// my-custom-plugin/tools/autoswap-agent/get-order-details.ts - HEDERA-NATIVE VERSION
import { z } from "zod";
import {
  Client,
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

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "expired";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs}h ${mins}m ${secs}s`;
}

function validateOrderId(orderId: string): bigint {
  const num = BigInt(orderId);
  if (num < 0n) throw new Error("Invalid order ID");
  return num;
}

// --- Hedera-native queries ---

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

async function getOrderDetailsRaw(client: Client, orderId: bigint) {
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
    return [false, "Status check temporarily unavailable"];
  }
}

function getExecutionStatus(order: any, canExecute: boolean, reason: string) {
  const now = Math.floor(Date.now() / 1000);
  const timeToExpiry = order.expirationTime - now;
  let status = order.isActive ? "Active" : order.isExecuted ? "Completed" : "Cancelled";
  return { status, recommendation: reason, timeToExpiry, canExecute };
}

function formatOrderDetails(orderId: string, order: any, canExecute: boolean, reason: string) {
  const tokenInfo = TOKENS[order.tokenOut] || { symbol: order.tokenOut, decimals: 18 };
  const { status, recommendation, timeToExpiry, canExecute: canActuallyExecute } = getExecutionStatus(order, canExecute, reason);
  const expiryDate = new Date(order.expirationTime * 1000).toLocaleString();

  const hbarAmount = parseFloat(formatUintWithDecimals(order.amountIn, 18));
  const triggerPrice = parseFloat(formatUintWithDecimals(order.triggerPrice, 18));
  const expectedTokens = hbarAmount / triggerPrice;

  const currentPriceInfo = canExecute ? " (✅ Trigger reached)" : " (⏳ Waiting)";

  return `📋 **Order Details #${orderId}**

**📊 Basic Information:**
• **Status:** ${status}
• **Type:** ${hbarAmount} HBAR → ${tokenInfo.symbol}
• **Owner:** ${order.owner}
• **Active:** ${order.isActive ? "✅ Yes" : "❌ No"}
• **Executed:** ${order.isExecuted ? "✅ Yes" : "❌ No"}

**💰 Trading Details:**
• **HBAR Amount:** ${hbarAmount} HBAR
• **Target Token:** ${tokenInfo.symbol}
• **Trigger Price:** ${triggerPrice} HBAR per ${tokenInfo.symbol}${currentPriceInfo}
• **Min Amount Out:** ${formatUintWithDecimals(order.minAmountOut, tokenInfo.decimals)} ${tokenInfo.symbol}
• **Expected Output:** ~${expectedTokens.toFixed(tokenInfo.decimals === 6 ? 2 : 4)} ${tokenInfo.symbol}

**⏰ Timing Information:**
• **Expires:** ${expiryDate}
• **Time Remaining:** ${formatTimeRemaining(timeToExpiry)}

**🎯 Execution Status:**
• **Ready to Execute:** ${canActuallyExecute ? "🟢 YES" : "🔴 NO"}
• **Reason:** ${recommendation}

${canActuallyExecute ? 
  '🚀 **Ready for execution!** Use "execute order ' + orderId + '" to execute.' : 
  timeToExpiry <= 0 ? 
    '💡 **Expired:** Use "cancel order ' + orderId + '" to recover HBAR.' :
    order.isActive ? 
      '⏳ **Active:** Order will execute when conditions are met.' :
      '📈 **Completed:** Order finished processing.'}`;
}

// --- Tool ---

const getOrderDetailsParameters = (context: Context = {}) =>
  z.object({
    orderId: z.string().describe("Order ID to fetch details for"),
  });

const getOrderDetailsPrompt = () => `Get comprehensive details about a specific AutoSwap limit order (Hedera-native).`;

const getOrderDetailsExecute = async (
  clientArg: Client | undefined,
  context: Context,
  params: z.infer<ReturnType<typeof getOrderDetailsParameters>>
) => {
  const client = clientArg || buildHederaClient();
  try {
    const orderIdNum = validateOrderId(params.orderId);

    const exists = await isValidOrder(client, orderIdNum);
    if (!exists) {
      return `❌ **Order Not Found**\n\nOrder #${params.orderId} does not exist.`;
    }

    const orderDetails = await getOrderDetailsRaw(client, orderIdNum);
    const [canExecute, reason] = await canExecuteOrder(client, orderIdNum);

    return formatOrderDetails(params.orderId, orderDetails, canExecute, reason);

  } catch (error: any) {
    console.error("❌ Get Order Details Error:", error);
    return `❌ Error fetching order details: ${error.message || error}`;
  }
};

export const GET_ORDER_DETAILS = "get_order_details";

const tool = (context: Context): Tool => ({
  method: GET_ORDER_DETAILS,
  name: "Get Order Details",
  description: getOrderDetailsPrompt(),
  parameters: getOrderDetailsParameters(context),
  execute: getOrderDetailsExecute,
});

export default tool;