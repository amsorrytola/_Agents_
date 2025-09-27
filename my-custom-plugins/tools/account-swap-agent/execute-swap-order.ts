// my-custom-plugin/tools/autoswap-agent/execute-swap-order.ts - HEDERA-NATIVE VERSION
import { z } from "zod";
import {
  Client,
  ContractExecuteTransaction,
  ContractCallQuery,
  ContractId,
  AccountId,
} from "@hashgraph/sdk";
import { Context, Tool } from "hedera-agent-kit";

// CONFIG
const CONTRACT_ADDRESS = process.env.AUTOSWAP_CONTRACT || "0.0.6893391";
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

function validateOrderId(orderId: string): bigint {
  const num = BigInt(orderId);
  if (num < 0n) throw new Error("Invalid order ID");
  return num;
}

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "expired";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs}h ${mins}m ${secs}s`;
}

async function contractCall(
  client: Client,
  funcName: string,
  params: { type: string; value: any }[] = []
) {
  const cid = ContractId.fromString(CONTRACT_ADDRESS);
  const call = await new ContractCallQuery()
    .setContractId(cid)
    .setGas(300_000)
    .setFunction(funcName, params)
    .execute(client);
  return call;
}

// --- Hedera-native order helpers ---
async function isValidOrder(client: Client, orderId: bigint): Promise<boolean> {
  try {
    const call = await contractCall(client, "isValidOrder", [
      { type: "uint256", value: orderId.toString() },
    ]);
    return call.getBool(0);
  } catch {
    return false;
  }
}

async function getOrderDetails(client: Client, orderId: bigint) {
  const call = await contractCall(client, "getOrderDetails", [
    { type: "uint256", value: orderId.toString() },
  ]);
  return {
    tokenOut: call.getAddress(0),
    amountIn: BigInt(call.getUint256(1).toString()),
    triggerPrice: BigInt(call.getUint256(2).toString()),
    minAmountOut: BigInt(call.getUint256(3).toString()),
    expirationTime: Number(call.getUint256(4).toString()),
    owner: call.getAddress(5),
    isActive: Boolean(call.getBool(6)),
    isExecuted: Boolean(call.getBool(7)),
  };
}

async function canExecuteOrder(client: Client, orderId: bigint): Promise<[boolean, string]> {
  try {
    const call = await contractCall(client, "canExecuteOrder", [
      { type: "uint256", value: orderId.toString() },
    ]);
    return [call.getBool(0), call.getString(1)];
  } catch {
    return [false, "Status check unavailable"];
  }
}

// --- Core execution logic ---
async function executeSwapOrderHedera(client: Client, orderIdStr: string) {
  const orderId = validateOrderId(orderIdStr);

  if (!(await isValidOrder(client, orderId))) {
    throw new Error(`Order #${orderId} does not exist`);
  }

  const order = await getOrderDetails(client, orderId);
  if (!order.isActive || order.isExecuted) {
    throw new Error(
      `Order #${orderId} cannot be executed: ${order.isActive ? "already executed" : "inactive"}`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (order.expirationTime <= now) {
    throw new Error(`Order #${orderId} has expired`);
  }

  const [canExecute, reason] = await canExecuteOrder(client, orderId);
  if (!canExecute) {
    throw new Error(`Order #${orderId} cannot be executed: ${reason}`);
  }

  const tokenInfo = TOKENS[order.tokenOut] || { symbol: order.tokenOut, decimals: 18 };
  const tx = await new ContractExecuteTransaction()
    .setContractId(CONTRACT_ADDRESS)
    .setGas(500_000)
    .setFunction("executeSwapOrder", [
      { type: "uint256", value: orderId.toString() },
      { type: "uint256", value: order.triggerPrice.toString() },
    ])
    .execute(client);

  const receipt = await tx.getReceipt(client);

  return {
    orderId: orderId.toString(),
    txId: tx.transactionId.toString(),
    executed: receipt.status.toString() === "SUCCESS",
    tokenOut: tokenInfo.symbol,
    amountIn: formatUintWithDecimals(order.amountIn, 18),
    minAmountOut: formatUintWithDecimals(order.minAmountOut, tokenInfo.decimals),
  };
}

// --- Tool ---
const executeSwapOrderParameters = (context: Context = {}) =>
  z.object({
    orderId: z.string().describe("The order ID to execute (e.g., '1')"),
  });

const executeSwapOrderPrompt = () =>
  `Execute a ready AutoSwap limit order on Hedera using native SDK (no utils/ethers).`;

const executeSwapOrderExecute = async (
  clientArg: Client | undefined,
  context: Context,
  params: z.infer<ReturnType<typeof executeSwapOrderParameters>>
) => {
  const client = clientArg || buildHederaClient();
  try {
    const result = await executeSwapOrderHedera(client, params.orderId);
    return `✅ **Order Executed Successfully**

Order #${result.orderId}
• Amount In: ${result.amountIn} HBAR
• Target Token: ${result.tokenOut}
• Min Amount Out: ${result.minAmountOut}
• Transaction ID: ${result.txId}
• Status: ${result.executed ? "✅ Success" : "❌ Failed"}`;
  } catch (error: any) {
    return `❌ Execution Error: ${error.message || String(error)}`;
  }
};

export const EXECUTE_SWAP_ORDER = "execute_swap_order";

const tool = (context: Context): Tool => ({
  method: EXECUTE_SWAP_ORDER,
  name: "Execute Swap Order",
  description: executeSwapOrderPrompt(),
  parameters: executeSwapOrderParameters(context),
  execute: executeSwapOrderExecute,
});

export default tool;
