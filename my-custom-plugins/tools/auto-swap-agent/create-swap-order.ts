// my-custom-plugin/tools/autoswap-agent/create-swap-order.ts
import { z } from "zod";
import {
  Client,
  PrivateKey,
  AccountId,
  ContractId,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractCallQuery,
  AccountBalanceQuery,
  Hbar,
} from "@hashgraph/sdk";
import { Context, Tool } from "hedera-agent-kit";
import fs from "fs";
import path from "path";

// Configuration constants
// This contract address may be a solidity address from Hedera (0x...) — we convert below.
const CONTRACT_SOLIDITY_ADDRESS = "0x0000000000000000000000000000000000697ec4";
// ABI is not strictly necessary with the Hedera SDK if you use ContractFunctionParameters,
// but we keep it available if you want to encode/inspect functions offline.
const ABI_PATH = "./utils/AutoSwapLimit (1).json";

// Token configurations (kept as provided). These should be solidity token addresses or the
// 20-byte addresses your contract expects.
const TOKENS = {
  USDC: {
    symbol: "USDC",
    decimals: 6,
    address: "0x00000000000000000000000000000000000014F5",
  },
  SAUCE: {
    symbol: "SAUCE",
    decimals: 18,
    address: "0x0000000000000000000000000000000000120f46",
  },
} as const;

// Load contract ABI (optional)
let contractABI: any;
try {
  contractABI = JSON.parse(fs.readFileSync(path.resolve(ABI_PATH), "utf8"));
} catch (error) {
  // Not fatal — ABI useful for offline decoding but not required for SDK calls
  console.warn("Warning: Failed to load contract ABI (optional):", error);
}

// Helper: resolve token info
function resolveTokenInfo(tokenSymbol: string) {
  const symbol = tokenSymbol.toUpperCase();

  if (symbol === "USDC") return TOKENS.USDC;
  if (symbol === "SAUCE") return TOKENS.SAUCE;

  throw new Error(
    `Unsupported token: ${tokenSymbol}. Supported tokens: USDC, SAUCE`
  );
}

/**
 * Validates order parameters (same logic as before)
 */
function validateOrderParams(params: any) {
  const { hbarAmount, triggerPriceHbar, expirationHours = 24 } = params;

  // Validate HBAR amount
  const hbarNum = parseFloat(hbarAmount);
  if (isNaN(hbarNum) || hbarNum <= 0) {
    throw new Error("Invalid HBAR amount. Must be a positive number.");
  }
  if (hbarNum < 0.01) {
    throw new Error("HBAR amount too small. Minimum is 0.01 HBAR.");
  }
  if (hbarNum > 180) {
    throw new Error("HBAR amount too large. Maximum is 180 HBAR per order.");
  }

  // Validate trigger price
  const priceNum = parseFloat(triggerPriceHbar);
  if (isNaN(priceNum) || priceNum <= 0) {
    throw new Error("Invalid trigger price. Must be a positive number.");
  }

  // Validate expiration
  if (expirationHours < 1 || expirationHours > 720) {
    // Max 30 days
    throw new Error("Invalid expiration. Must be between 1 hour and 30 days.");
  }

  return { hbarNum, priceNum, expirationHours };
}

/**
 * Calculates minimum output amount (uint256 string) using integer math to avoid float precision issues.
 * Approach:
 *   expectedTokens = hbarAmount / triggerPrice
 *   scaledExpectedTokens = expectedTokens * (10^tokenDecimals)
 *   minTokens = scaledExpectedTokens * (1 - slippageBps/10000)
 *
 * We scale inputs by a `scale` (1e8) to preserve fractional precision when converting floats -> BigInt.
 */
function calculateMinAmountOut(
  hbarAmount: number,
  triggerPrice: number,
  tokenDecimals: number,
  slippageBps: number = 200 // 2% default slippage
): string {
  // high precision scale to preserve decimal fractions when converting to BigInt
  const HIGH_PREC = 1e8;

  // Convert to integer representations
  const hbarScaled = BigInt(Math.round(hbarAmount * HIGH_PREC)); // hbar * 1e8
  const priceScaled = BigInt(Math.round(triggerPrice * HIGH_PREC)); // price * 1e8

  // scaledExpectedTokens = (hbarScaled * 10^decimals) / priceScaled
  const tokenScale = BigInt(10) ** BigInt(tokenDecimals);
  const numerator = hbarScaled * tokenScale;
  const expectedTokensScaled = numerator / priceScaled; // this is already scaled by 1e8 cancelation

  // apply slippage
  const minTokens = (expectedTokensScaled * BigInt(10000 - slippageBps)) / BigInt(10000);

  // minTokens is the integer token amount in token's smallest units (i.e., uint256)
  return minTokens.toString();
}

/**
 * Build Hedera client from environment.
 * - Requires HEDERA_NETWORK (optional, default 'testnet') and HEDERA_ACCOUNT_ID (operator)
 * - PRIVATE_KEY must be provided (private key string for operator)
 */
function buildHederaClient() {
  const network = process.env.HEDERA_NETWORK || "testnet";
  let client: Client;

  if (network === "mainnet") {
    client = Client.forMainnet();
  } else {
    client = Client.forTestnet();
  }

  const operatorId = process.env.HEDERA_ACCOUNT_ID;
  const operatorKey = process.env.PRIVATE_KEY;

  if (!operatorId || !operatorKey) {
    throw new Error(
      "HEDERA_ACCOUNT_ID or PRIVATE_KEY missing from environment variables."
    );
  }

  client.setOperator(AccountId.fromString(operatorId), PrivateKey.fromString(operatorKey));
  return client;
}

const createSwapOrderParameters = (context: Context = {}) =>
  z.object({
    tokenOut: z.string().describe("Output token symbol (USDC or SAUCE)"),
    hbarAmount: z.string().describe("HBAR amount to swap (e.g., '10.5')"),
    triggerPriceHbar: z
      .string()
      .describe(
        "Trigger price: HBAR per token (e.g., '0.1' means 1 token costs 0.1 HBAR)"
      ),
    expirationHours: z
      .number()
      .optional()
      .default(24)
      .describe("Order expiration in hours (1-720, default: 24)"),
    minAmountOut: z
      .string()
      .optional()
      .describe(
        "Minimum token output (optional, auto-calculated with 2% slippage if not provided)"
      ),
  });

const createSwapOrderPrompt = () => `
Creates an AutoSwap limit order to automatically swap HBAR for tokens when price conditions are met.

**Supported Tokens:**
- USDC: USD Coin (6 decimals)
- SAUCE: SaucerSwap Token (18 decimals)

**Order Limits:**
- Minimum: 0.01 HBAR
- Maximum: 180 HBAR per order
- Expiration: 1 hour to 30 days

**Price Logic:**
- triggerPriceHbar represents how much HBAR one token costs
- Example: triggerPriceHbar="0.1" means execute when 1 token = 0.1 HBAR
- Order executes when market price >= trigger price (favorable for buying)

**Example Usage:**
- "Create order: 10 HBAR → USDC at 0.08 HBAR per USDC"
- "Swap 25 HBAR for SAUCE when price drops to 0.05"
`;

const createSwapOrderExecute = async (
  clientArg: any,
  context: Context,
  params: z.infer<ReturnType<typeof createSwapOrderParameters>>
) => {
  try {
    // Build Hedera client (or use passed clientArg if provided)
    const client = clientArg || buildHederaClient();

    // Validate params
    const { hbarNum, priceNum, expirationHours } = validateOrderParams(params);
    const tokenInfo = resolveTokenInfo(params.tokenOut);

    // Compute values
    const hbarAmount = hbarNum; // number
    const triggerPrice = priceNum; // number
    const expirationTime = Math.floor(Date.now() / 1000) + expirationHours * 3600;

    // minAmountOut either provided or calculated
    const minAmountOutUint = params.minAmountOut
      ? BigInt(params.minAmountOut).toString()
      : calculateMinAmountOut(hbarAmount, triggerPrice, tokenInfo.decimals);

    // Check account balance (operator)
    const operatorIdStr = process.env.HEDERA_ACCOUNT_ID;
    if (!operatorIdStr) {
      throw new Error("HEDERA_ACCOUNT_ID not set in environment");
    }
    const operatorId = AccountId.fromString(operatorIdStr);
    const balanceQuery = new AccountBalanceQuery().setAccountId(operatorId);
    const balance = await balanceQuery.execute(client);

    // balance.hbars is an Hbar object. Compare numerically with a small buffer
    const walletBalanceHbar = parseFloat(balance.hbars.toString()); // e.g., "12.345 HBAR" -> parseFloat
    const requiredBuffer = 0.1; // ~0.1 HBAR for fees
    if (walletBalanceHbar < hbarAmount + requiredBuffer) {
      throw new Error(
        `Insufficient balance. Need at least ${(
          hbarAmount + requiredBuffer
        ).toFixed(6)} HBAR (you have ${walletBalanceHbar} HBAR).`
      );
    }

    // Convert provided solidity contract address to ContractId object
    let contractId: ContractId;
    try {
      contractId = ContractId.fromSolidityAddress(CONTRACT_SOLIDITY_ADDRESS);
    } catch (e) {
      // If CONTRACT_SOLIDITY_ADDRESS is not solidity format, try parsing as string ContractId
      contractId = ContractId.fromString(CONTRACT_SOLIDITY_ADDRESS);
    }

    // Prepare contract call
    // Hedera ContractFunctionParameters supports standard param types.
    // We will pass:
    //   tokenAddress (bytes20 / address) -> addAddress expects 20-byte hex (0x...)
    //   minAmountOut (uint256) -> addUint256
    //   triggerPriceWei (uint256) -> represent trigger price scaled similarly to contract expectation
    //   expirationTime (uint256)

    // NOTE: The contract's expected types must match. If your contract expects prices in 18-decimal HBAR units,
    // convert accordingly. Here we assume triggerPrice is expressed as HBAR per token (e.g. 0.1),
    // and the contract expects an 18-decimal fixed-point (like wei). We'll scale triggerPrice to 18 decimals.
    const TRIGGER_PRICE_DECIMALS = 18;
    const triggerPriceScaled = BigInt(
      Math.round(triggerPrice * Math.pow(10, TRIGGER_PRICE_DECIMALS))
    ).toString();

    // Build parameters
    const functionParams = new ContractFunctionParameters()
      .addAddress(tokenInfo.address) // solidity address (20 bytes)
      .addUint256(minAmountOutUint) // min tokens out (uint256)
      .addUint256(triggerPriceScaled) // trigger price scaled to 18 decimals (uint256)
      .addUint256(BigInt(expirationTime).toString()); // expiration as uint256

    // Hedera gas: set a reasonably high gas limit for contract execution
    const GAS_LIMIT = 3_000_000; // conservative default; increase if your contract is gas heavy

    // Execute contract: set payable amount as Hbar.from(hbarAmount)
    const tx = await new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(GAS_LIMIT)
      .setFunction("createSwapOrder", functionParams)
      .setPayableAmount(new Hbar(hbarAmount)) // pay HBAR into the contract
      .execute(client);

    // Get receipt
    const receipt = await tx.getReceipt(client);
    if (receipt.status && receipt.status.toString().includes("FAIL")) {
      throw new Error(`Contract execution failed with status ${receipt.status}`);
    }

    const txId = tx.transactionId.toString();

    // Get nextOrderId via a view call to contract
    const callResult = await new ContractCallQuery()
      .setContractId(contractId)
      .setGas(250000)
      .setFunction("nextOrderId")
      .execute(client);

    // Attempt to read uint256 result
    let orderIdStr = "unknown";
    try {
      // ContractCallQuery returns a ContractFunctionResult with getter methods
      // getUint256(index) returns a BigInt (as string) in many SDK versions
      // Some SDKs expose getUint256(0) as Uint8Array; adapt if needed.
      const nextOrderId = callResult.getUint256(0);
      // nextOrderId might be a JS BigInt or a string; convert to BigInt to subtract 1
      const nextIdBig = BigInt(nextOrderId.toString());
      const orderId = nextIdBig - BigInt(1);
      orderIdStr = orderId.toString();
    } catch (e) {
      console.warn("Warning: unable to parse nextOrderId view result:", e);
    }

    return `✅ **AutoSwap Limit Order Created Successfully**
**📋 Order Details:**
• **Order ID:** #${orderIdStr}
• **🔗 Transaction ID:** ${txId}`;
  } catch (error: any) {
    console.error("❌ Create Order Error:", error);

    // Hedera-specific and generic error handling
    const msg = (error && error.message) ? error.message.toLowerCase() : "";

    if (msg.includes("insufficient") || msg.includes("balance")) {
      return "❌ **Insufficient Funds**\n\nYour account doesn't have enough HBAR to create this order plus fees. Please add more HBAR and try again.";
    }

    if (msg.includes("contract execution failed") || msg.includes("revert")) {
      return "❌ **Transaction Failed**\n\nThe smart contract rejected your transaction. Please check:\n• Token is supported (USDC/SAUCE only)\n• Order amount is within limits (0.01-180 HBAR)\n• Expiration time is valid";
    }

    if (msg.includes("network") || msg.includes("timeout")) {
      return "❌ **Network Error**\n\nConnection to Hedera network failed. Please check your internet connection and try again.";
    }

    if (msg.includes("nonce") || msg.includes("transaction id")) {
      return "❌ **Transaction Nonce / ID Error**\n\nPlease wait a moment and try again.";
    }

    // Generic fallback
    return `❌ **Order Creation Failed**

**Error:** ${error.message || "Unknown error occurred"}

**Troubleshooting Tips:**
• Ensure HEDERA_ACCOUNT_ID and PRIVATE_KEY are set in environment variables.
• Ensure you have sufficient HBAR balance (${params.hbarAmount} + ~0.1 for fees)
• Verify token symbol is correct (USDC or SAUCE only)
• Check order amount is within limits (0.01-180 HBAR)`;
  }
};

// Tool export: keep the same symbol
export const CREATE_SWAP_ORDER = "create_swap_order";

const tool = (context: Context): Tool => ({
  method: CREATE_SWAP_ORDER,
  name: "Create AutoSwap Limit Order",
  description: createSwapOrderPrompt(),
  parameters: createSwapOrderParameters(context),
  execute: createSwapOrderExecute,
});

export default tool;