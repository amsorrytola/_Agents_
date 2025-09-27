// my-custom-plugin/tools/autoswap-agent/execute-swap-order.ts - FIXED VERSION
import { z } from "zod";
import { Client } from "@hashgraph/sdk";
import { Context, Tool } from "hedera-agent-kit";
import { ethers } from "ethers";
import {
  getContract,
  getContractWithWallet,
  getWallet,
  contractInterface,
  formatTokenInfo,
  formatTokenAmount,
  formatHBARAmount,
  validateOrderId,
  estimateGasCost,
  handleContractError,
  safeBigIntToNumber,
  CONTRACT_ADDRESS,
} from "../../utils/contractUtils";

/**
 * FIXED: Get current market price using the same method as contract
 */
async function getCurrentMarketPrice(contract: any, tokenOut: string, amountIn: bigint): Promise<bigint> {
  try {
    console.log(`📊 Getting market price for ${amountIn} HBAR -> ${tokenOut}`);
    
    // Use the contract's own estimation method (same as in smart contract)
    const estimatedOut = await contract.getEstimatedAmountOut(tokenOut, amountIn);
    console.log(`💰 Estimated output: ${estimatedOut} tokens`);
    
    if (estimatedOut === 0n) {
      throw new Error("No liquidity available for this swap");
    }

    // Calculate current price: amountIn / estimatedOut
    // Price = HBAR amount / Token amount = HBAR per token
    const tokenInfo = formatTokenInfo(tokenOut);
    if (!tokenInfo) {
      throw new Error("Unsupported token");
    }

    // Convert to same units for calculation
    const hbarAmount = parseFloat(ethers.formatUnits(amountIn, 18));
    const tokenAmount = parseFloat(ethers.formatUnits(estimatedOut, tokenInfo.decimals));
    
    if (tokenAmount === 0) {
      throw new Error("Invalid token amount returned from DEX");
    }

    const pricePerToken = hbarAmount / tokenAmount;
    console.log(`📈 Current market price: ${pricePerToken.toFixed(8)} HBAR per ${tokenInfo.symbol}`);
    
    // Convert back to BigInt with 18 decimals (HBAR precision)
    const marketPriceBigInt = ethers.parseUnits(pricePerToken.toFixed(18), 18);
    return marketPriceBigInt;
    
  } catch (error: any) {
    console.error("❌ Failed to get market price:", error.message);
    throw new Error(`Could not get current market price: ${error.message}`);
  }
}

/**
 * FIXED: Validate order execution with comprehensive checks
 */
async function validateExecution(contract: any, orderId: number) {
  console.log(`🔍 Validating execution for order #${orderId}...`);

  // Check if order exists and is valid
  const isValid = await contract.isValidOrder(orderId);
  if (!isValid) {
    throw new Error(`Order #${orderId} does not exist or is invalid`);
  }

  // Get order details
  const orderDetails = await contract.getOrderDetails(orderId);
  console.log(`📋 Order found - Amount: ${formatHBARAmount(orderDetails.amountIn)} HBAR`);
  
  // Check if order is active
  if (!orderDetails.isActive) {
    throw new Error(`Order #${orderId} is not active ${orderDetails.isExecuted ? '(already executed)' : '(cancelled)'}`);
  }

  // Check if already executed
  if (orderDetails.isExecuted) {
    throw new Error(`Order #${orderId} has already been executed`);
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  const expirationTime = safeBigIntToNumber(orderDetails.expirationTime);
  if (now >= expirationTime) {
    throw new Error(`Order #${orderId} has expired. Consider cancelling to recover funds.`);
  }

  // CRITICAL: Check if order has valid amount
  if (orderDetails.amountIn === 0n) {
    throw new Error(`Order #${orderId} has 0 HBAR amount and cannot be executed`);
  }

  console.log(`✅ Order validation passed`);
  return orderDetails;
}

/**
 * Format execution success result
 */
function formatExecutionResult(
  orderId: number,
  orderDetails: any,
  txHash: string,
  executionPrice: string,
  gasUsed?: bigint
) {
  const tokenInfo = formatTokenInfo(orderDetails.tokenOut);
  const triggerPrice = ethers.formatUnits(orderDetails.triggerPrice, 18);
  
  return `✅ **Order Executed Successfully**

🎯 **Execution Summary:**
• **Order ID:** #${orderId}
• **Amount Swapped:** ${formatHBARAmount(orderDetails.amountIn)} HBAR
• **Target Token:** ${tokenInfo?.symbol || 'Unknown'}
• **Execution Price:** ${executionPrice} HBAR per ${tokenInfo?.symbol || 'token'}
• **Trigger Price:** ${triggerPrice} HBAR per ${tokenInfo?.symbol || 'token'}
• **Status:** ✅ Completed

🔗 **Transaction Details:**
• **Hash:** ${txHash}
• **Contract:** ${CONTRACT_ADDRESS}
${gasUsed ? `• **Gas Used:** ${gasUsed.toLocaleString()}` : ''}

💰 **Output Information:**
• **Minimum Guaranteed:** ${formatTokenAmount(orderDetails.minAmountOut, orderDetails.tokenOut)} ${tokenInfo?.symbol || 'tokens'}

🎉 **Success!** Your limit order has been executed and tokens should appear in your wallet shortly.

💡 **What's Next:**
• Check your wallet balance to confirm token receipt
• Use "monitor orders" to see your order history
• Consider creating new orders for future trading`;
}

const executeSwapOrderParameters = (context: Context = {}) =>
  z.object({
    orderId: z.string().describe("The order ID to execute (e.g., '1')"),
  });

const executeSwapOrderPrompt = () => `
Execute a ready AutoSwap limit order manually with enhanced validation.

FIXED: Now properly calls contract function with correct current market price.
Uses contract's own price estimation and validates against trigger conditions.
`;

const executeSwapOrderExecute = async (
  client: Client,
  context: Context,
  params: z.infer<ReturnType<typeof executeSwapOrderParameters>>
) => {
  try {
    const { orderId } = params;
    const orderIdNum = validateOrderId(orderId);
    
    console.log(`🚀 Starting execution of order #${orderId}...`);

    const wallet = getWallet();
    const contract = getContract();
    const contractWithWallet = getContractWithWallet(wallet);

    console.log(`👤 Executing as: ${wallet.address}`);
    console.log(`📍 Contract: ${CONTRACT_ADDRESS}`);

    // Validate execution eligibility
    const orderDetails = await validateExecution(contract, orderIdNum);
    const tokenInfo = formatTokenInfo(orderDetails.tokenOut);
    
    console.log(`📊 Order: ${formatHBARAmount(orderDetails.amountIn)} HBAR → ${tokenInfo?.symbol || 'Unknown'}`);
    console.log(`🎯 Trigger Price: ${ethers.formatUnits(orderDetails.triggerPrice, 18)} HBAR per token`);

    // Check contract can execute (final validation)
    console.log(`🔍 Final contract validation...`);
    const [canExecute, reason] = await contract.canExecuteOrder(orderIdNum);
    if (!canExecute) {
      throw new Error(`Contract validation failed: ${reason}`);
    }
    console.log(`✅ Contract validation passed: ${reason}`);

    // Get current market price using contract's method
    console.log(`💰 Getting current market price...`);
    const currentMarketPrice = await getCurrentMarketPrice(contract, orderDetails.tokenOut, orderDetails.amountIn);
    const priceForDisplay = ethers.formatUnits(currentMarketPrice, 18);
    
    console.log(`📈 Current market price: ${priceForDisplay} HBAR per ${tokenInfo?.symbol}`);
    console.log(`🎯 Required trigger price: ${ethers.formatUnits(orderDetails.triggerPrice, 18)} HBAR per ${tokenInfo?.symbol}`);

    // Check if current price meets trigger condition (this is what contract will check)
    if (currentMarketPrice < orderDetails.triggerPrice) {
      return `❌ **Price Condition Not Met**

Order #${orderId} cannot be executed because the current market price hasn't reached the trigger level.

**Current Situation:**
• **Current Market Price:** ${priceForDisplay} HBAR per ${tokenInfo?.symbol || 'token'}
• **Your Trigger Price:** ${ethers.formatUnits(orderDetails.triggerPrice, 18)} HBAR per ${tokenInfo?.symbol || 'token'}
• **Price Gap:** Market price is ${((parseFloat(ethers.formatUnits(orderDetails.triggerPrice, 18)) - parseFloat(priceForDisplay)) / parseFloat(priceForDisplay) * 100).toFixed(2)}% below trigger

**What to do:**
• **Wait:** Market conditions may improve
• **Check Details:** Use "order details ${orderId}" for current status
• **Cancel if needed:** Use "cancel order ${orderId}" to recover HBAR

💡 The order will automatically execute when the market price reaches your trigger level.`;
    }

    // Check wallet balance for gas fees
    const balance = await wallet.provider?.getBalance(wallet.address);
    if (!balance) {
      throw new Error("Could not check wallet balance");
    }
    console.log(`💰 Wallet balance: ${ethers.formatUnits(balance, 18)} HBAR`);

    // Estimate gas cost
    console.log(`⛽ Estimating gas cost...`);
    const gasEstimation = await estimateGasCost(wallet, contractInterface.encodeFunctionData("executeSwapOrder", [orderIdNum, currentMarketPrice]));
    console.log(`⛽ Estimated gas: ${gasEstimation.gasLimit} | Max fee: ${ethers.formatUnits(gasEstimation.maxFeePerGas, "gwei")} Gwei`);

    // Check if wallet has enough for gas
    if (balance < gasEstimation.estimatedCost) {
      return `❌ **Insufficient Balance for Gas Fees**

Your wallet needs more HBAR to cover the gas fees for this transaction.

**Required for gas:** ${ethers.formatUnits(gasEstimation.estimatedCost, 18)} HBAR
**Current balance:** ${ethers.formatUnits(balance, 18)} HBAR
**Shortfall:** ${ethers.formatUnits(gasEstimation.estimatedCost - balance, 18)} HBAR

💡 **Solution:** Add more HBAR to your wallet and try again.`;
    }

    // Execute the order with proper transaction parameters
    console.log(`🔄 Submitting execution transaction...`);
    console.log(`📊 Using current price: ${currentMarketPrice} (${priceForDisplay} HBAR per token)`);
    
    const tx = await contractWithWallet.executeSwapOrder(orderIdNum, currentMarketPrice, {
      gasLimit: gasEstimation.gasLimit,
      maxFeePerGas: gasEstimation.maxFeePerGas,
      maxPriorityFeePerGas: gasEstimation.maxPriorityFeePerGas,
      type: 2 // EIP-1559 transaction type for Hedera
    });

    console.log(`📤 Transaction submitted: ${tx.hash}`);

    // Wait for confirmation with timeout
    console.log(`⏳ Waiting for transaction confirmation...`);
    const receipt = await tx.wait(3); // Wait for 3 confirmations
    
    if (!receipt) {
      throw new Error("Transaction receipt not received");
    }

    if (receipt.status !== 1) {
      throw new Error(`Transaction failed with status: ${receipt.status}`);
    }

    console.log(`✅ Transaction confirmed: ${receipt.hash}`);
    console.log(`📊 Gas used: ${receipt.gasUsed?.toLocaleString()} / ${gasEstimation.gasLimit.toLocaleString()}`);

    // Verify execution on-chain
    try {
      console.log(`🔍 Verifying order execution...`);
      const updatedOrderDetails = await contract.getOrderDetails(orderIdNum);
      if (updatedOrderDetails.isExecuted) {
        console.log(`✅ Order execution verified on-chain`);
      } else {
        console.warn(`⚠️ Order shows as not executed yet, but transaction succeeded`);
      }
    } catch (error) {
      console.warn("Could not immediately verify execution status:", error);
      console.log("✅ Transaction confirmed - order should be updated shortly");
    }

    return formatExecutionResult(
      orderIdNum,
      orderDetails,
      receipt.hash,
      priceForDisplay,
      receipt.gasUsed
    );

  } catch (error: any) {
    console.error("❌ Execute Order Error:", error);
    
    const errorMsg = error.message || String(error);
    
    // Handle specific error conditions
    if (errorMsg.includes("execution reverted")) {
      if (errorMsg.includes("Price does not reach trigger")) {
        return `❌ **Price Condition Failed on Execution**

The smart contract rejected the execution because the price condition was not met at the exact moment of execution.

**This can happen when:**
• Market price changed between validation and execution
• Network congestion caused timing issues
• Price feeds updated during transaction processing

**Solutions:**
• Try again immediately - prices fluctuate constantly
• Use "order details ${params.orderId}" to check current status
• Wait for better market conditions`;
      }

      if (errorMsg.includes("Order not active") || errorMsg.includes("Order already executed")) {
        return `❌ **Order Status Changed**

Order #${params.orderId} status changed during execution:
${errorMsg}

💡 **Check Status:** Use "order details ${params.orderId}" to see current state.`;
      }

      if (errorMsg.includes("Order expired")) {
        return `❌ **Order Expired During Execution**

Order #${params.orderId} expired while the transaction was being processed.

💡 **Action:** Use "cancel order ${params.orderId}" to recover your HBAR.`;
      }

      return `❌ **Smart Contract Rejected Execution**

The AutoSwap contract rejected the execution with: ${errorMsg}

**Common causes:**
• Market conditions changed during execution
• Insufficient DEX liquidity
• Order parameters no longer valid
• Network congestion affecting price feeds

**Solutions:**
• Wait a few moments and try again
• Check "order details ${params.orderId}" for current status
• Consider market volatility factors`;
    }

    if (errorMsg.includes("does not exist")) {
      return `❌ **Order Not Found**

Order #${params.orderId} does not exist in the AutoSwap contract.

💡 **Check:** Use "monitor orders" to see your available orders.`;
    }

    if (errorMsg.includes("not active") || errorMsg.includes("already executed")) {
      return `❌ **Order Not Executable**

${errorMsg}

💡 **Try:** Use "order details ${params.orderId}" to check current status.`;
    }

    if (errorMsg.includes("expired")) {
      return `❌ **Order Expired**

${errorMsg}

💡 **Action:** Use "cancel order ${params.orderId}" to recover your HBAR.`;
    }

    if (errorMsg.includes("Insufficient balance") || errorMsg.includes("insufficient funds")) {
      return `❌ **Insufficient Balance**

${errorMsg}

💡 **Solutions:**
• Add more HBAR to your wallet for gas fees
• Wait for pending transactions to complete
• Check that your wallet has enough HBAR`;
    }

    if (errorMsg.includes("Could not get current market price")) {
      return `❌ **Market Price Error**

Unable to get current market price from the DEX: ${errorMsg}

**This usually means:**
• No liquidity available for this token pair
• DEX is temporarily unavailable
• Network connectivity issues

💡 **Solutions:**
• Try again in a few moments
• Check if the token pair has sufficient liquidity
• Wait for DEX to become available`;
    }

    return handleContractError(error, "Order Execution");
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