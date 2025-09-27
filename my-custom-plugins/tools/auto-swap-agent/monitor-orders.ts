// my-custom-plugin/tools/autoswap-agent/monitor-orders.ts - HEDERA-NATIVE VERSION
import { z } from "zod";
import {
  Client,
  AccountBalanceQuery,
  ContractCallQuery,
  ContractId,
  Hbar,
  AccountId,
} from "@hashgraph/sdk";
import { Context, Tool } from "hedera-agent-kit";

// CONFIG
const CONTRACT_ADDRESS = "0.0.6913732";
const MAX_FETCH_LIMIT = 50;

// Token metadata (replace with your tokens)
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  USDC: { symbol: "USDC", decimals: 6 },
  SAUCE: { symbol: "SAUCE", decimals: 18 },
};

// --- Helpers ---

function buildHederaClient(): Client {
  const network = process.env.HEDERA_NETWORK || "testnet";
  const client =
    network === "mainnet" ? Client.forMainnet() : Client.forTestnet();

  const operatorId = process.env.HEDERA_ACCOUNT_ID;
  const operatorKey = process.env.PRIVATE_KEY;
  if (!operatorId || !operatorKey) {
    throw new Error(
      "HEDERA_ACCOUNT_ID and PRIVATE_KEY must be set in env."
    );
  }
  client.setOperator(AccountId.fromString(operatorId), operatorKey);
  return client;
}

function formatUintWithDecimals(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/,"");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "expired";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs}h ${mins}m ${secs}s`;
}

// --- Hedera-native queries ---

async function getWalletBalance(client: Client, accountId: string): Promise<bigint> {
  try {
    const res = await new AccountBalanceQuery()
      .setAccountId(AccountId.fromString(accountId))
      .execute(client);
    // Hbar to tinybars
    return BigInt(res.hbars.toTinybars());
  } catch (err) {
    console.warn("Failed to fetch wallet balance:", err);
    return 0n;
  }
}

async function getContractBalance(client: Client, contractId: string): Promise<bigint> {
  try {
    const cid = ContractId.fromString(contractId);
    const call = await new ContractCallQuery()
      .setContractId(cid)
      .setGas(200000)
      .setFunction("getContractBalance")
      .execute(client);
    const res = call.getUint256(0);
    return BigInt(res.toString());
  } catch (err) {
    console.warn("Failed to fetch contract balance:", err);
    return 0n;
  }
}

async function getUserOrders(client: Client, contractId: string, user: string): Promise<bigint[]> {
  try {
    const cid = ContractId.fromString(contractId);
    const call = await new ContractCallQuery()
      .setContractId(cid)
      .setGas(300000)
      .setFunction("getUserOrders", [{ type: "address", value: user }])
      .execute(client);
    const length = call.getUint256(0);
    const orders: bigint[] = [];
    for (let i = 0; i < Number(length); i++) {
      const id = call.getUint256(i + 1);
      orders.push(BigInt(id.toString()));
    }
    return orders;
  } catch (err) {
    console.warn("Failed to fetch user orders:", err);
    return [];
  }
}

async function getOrderDetails(client: Client, contractId: string, orderId: bigint) {
  try {
    const cid = ContractId.fromString(contractId);
    const call = await new ContractCallQuery()
      .setContractId(cid)
      .setGas(300000)
      .setFunction("getOrderDetails", [{ type: "uint256", value: orderId.toString() }])
      .execute(client);

    // decode expected fields; adjust indices based on your contract ABI
    const tokenAddress = call.getAddress(0);
    const amountIn = BigInt(call.getUint256(1).toString());
    const triggerPrice = BigInt(call.getUint256(2).toString());
    const expirationTime = Number(call.getUint256(3).toString());
    const isActive = Boolean(call.getBool(4));
    const isExecuted = Boolean(call.getBool(5));

    return { tokenAddress, amountIn, triggerPrice, expirationTime, isActive, isExecuted };
  } catch (err) {
    console.warn(`Failed to fetch order ${orderId}:`, err);
    return null;
  }
}

// --- Execution status check ---
function getExecutionStatus(order: any): { status: string; timeToExpiry: number } {
  const now = Math.floor(Date.now() / 1000);
  if (!order.isActive) {
    return { status: order.isExecuted ? "Completed" : "Cancelled", timeToExpiry: 0 };
  }
  const timeToExpiry = order.expirationTime - now;
  if (timeToExpiry <= 0) return { status: "Expired", timeToExpiry: 0 };
  return { status: "Active", timeToExpiry };
}

// --- Main tool ---

const monitorOrdersParameters = (context: Context = {}) =>
  z.object({
    limit: z.number().optional().default(20).describe("Maximum number of recent orders to fetch (1-50)")
  });

const monitorOrdersPrompt = () => `Monitor AutoSwap limit orders (Hedera-native).`;

const monitorOrdersExecute = async (
  clientArg: Client | undefined,
  context: Context,
  params: z.infer<ReturnType<typeof monitorOrdersParameters>>
) => {
  const client = clientArg || buildHederaClient();
  const user = process.env.HEDERA_ACCOUNT_ID!;
  const limit = Math.min(params.limit ?? 20, MAX_FETCH_LIMIT);

  // balances
  const [walletBalance, contractBalance] = await Promise.all([
    getWalletBalance(client, user),
    getContractBalance(client, CONTRACT_ADDRESS),
  ]);

  // orders
  const orderIds = await getUserOrders(client, CONTRACT_ADDRESS, user);
  if (orderIds.length === 0) {
    return `📊 No orders found. Wallet: ${Number(walletBalance)/1e8} HBAR, Contract: ${Number(contractBalance)/1e8} HBAR`;
  }

  const recentOrderIds = orderIds.slice(-limit);

  const orders: any[] = [];
  for (const id of recentOrderIds) {
    const detail = await getOrderDetails(client, CONTRACT_ADDRESS, id);
    if (detail) orders.push({ id, ...detail });
  }

  // Format summary
  const lines = orders.map(o => {
    const token = TOKENS[o.tokenAddress] || { symbol: o.tokenAddress, decimals: 18 };
    const amountStr = formatUintWithDecimals(o.amountIn, 18);
    const priceStr = formatUintWithDecimals(o.triggerPrice, 18);
    const { status, timeToExpiry } = getExecutionStatus(o);
    const timeStr = formatTimeRemaining(timeToExpiry);
    return `${status} #${o.id} | ${amountStr} HBAR → ${token.symbol} | Price: ${priceStr} | ${timeStr}`;
  });

  return `📊 Monitoring Dashboard
👤 Account: ${user}
💰 Wallet Balance: ${Number(walletBalance)/1e8} HBAR
🏛 Contract Balance: ${Number(contractBalance)/1e8} HBAR
📋 Orders: ${orders.length}
${lines.join("\n")}`;
};

export const MONITOR_ORDERS = "monitor_orders";

const tool = (context: Context): Tool => ({
  method: MONITOR_ORDERS,
  name: "Monitor Orders",
  description: monitorOrdersPrompt(),
  parameters: monitorOrdersParameters(context),
  execute: monitorOrdersExecute,
});

export default tool;
