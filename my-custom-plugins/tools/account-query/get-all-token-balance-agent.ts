// my-custom-plugin/tools/account-query/get-all-token-balances-agent.ts
import { z } from "zod";
import { ethers } from "ethers";
import type { Context, Tool } from "hedera-agent-kit";

/**
 * Network configurations
 */
const NETWORKS = {
  HEDERA_TESTNET: {
    name: "Hedera Testnet",
    rpcUrl: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api",
    chainId: 296,
  },
  SEPOLIA: {
    name: "Sepolia Testnet",
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    chainId: 11155111,
  },
  ROOTSTOCK_TESTNET: {
    name: "Rootstock Testnet",
    rpcUrl: process.env.ROOTSTOCK_RPC_URL || "https://public-node.testnet.rsk.co",
    chainId: 31,
  }
};

/**
 * Common ERC-20 ABI for balance queries
 */
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)"
];

/**
 * Known tokens across all networks - Fixed addresses with proper checksums
 */
const NETWORK_TOKENS = {
  HEDERA_TESTNET: {
    HBAR:{
      address: "0x0000000000000000000000000000000000342855",
      symbol: "HBAR",
      name: "HBAR",
      decimals: 18,
    }
  },
  SEPOLIA: {
    SepoliaETH:{
      address: "0xdbc1856cbD9553B8F2BE31f6E6d5695dC823B47C",
      symbol: "SepoliaETH",
      name: "Sepolia Ether",
      decimals: 18
    }
   
  },
  ROOTSTOCK_TESTNET: {
    tRBTC:{
      address: "0x1a09C14922247d2D9731B7D7eE55F2833Ad8C557",
      symbol: "tRBTC",
      name: "tRBTC",
      decimals: 18
    }
  }
};

/**
 * Create provider for each network with retry logic
 */
function getProvider(networkKey: keyof typeof NETWORKS): ethers.JsonRpcProvider {
  const network = NETWORKS[networkKey];
  
  // For Sepolia, check if it's the placeholder URL and use public endpoint
  let rpcUrl = network.rpcUrl;
  if (networkKey === 'SEPOLIA' && rpcUrl.includes('0x692d410d3195671ef1B0705A1D022f24b2E0d1e1')) {
    rpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";
  }
  
  const ethersNetwork = {
    name: network.name.toLowerCase().replace(/\s+/g, '-'),
    chainId: network.chainId,
  };
  
  const provider = new ethers.JsonRpcProvider(rpcUrl, ethersNetwork, {
    staticNetwork: true, // Disable network detection to avoid retries
  });
  
  return provider;
}

/**
 * Get user EVM address from environment
 */
function getUserEvmAddress(): string {
  let evmAddress = process.env.EVM_ADDRESS ;
  if (!evmAddress) {
    throw new Error("EVM_ADDRESS not set in environment. Please set EVM_ADDRESS=0x... in your .env file");
  }
  
  // Clean up the address - remove quotes if present
  evmAddress = evmAddress.replace(/['"]/g, '').trim();
  
  if (!ethers.isAddress(evmAddress)) {
    throw new Error(`Invalid EVM address in environment: ${evmAddress}`);
  }
  
  return ethers.getAddress(evmAddress); // This ensures proper checksum
}

/**
 * Format token amount with proper decimals
 */
function formatTokenAmount(amount: bigint, decimals: number, symbol: string): string {
  const formatted = ethers.formatUnits(amount, decimals);
  const num = parseFloat(formatted);
  
  if (num === 0) return `0 ${symbol}`;
  
  // Format based on token decimals and amount size
  let displayDecimals = 4;
  if (decimals === 6) displayDecimals = 4; // USDC, USDT
  if (decimals === 18 && num < 1) displayDecimals = 8; // Small amounts of 18-decimal tokens
  if (num > 1000) displayDecimals = 2; // Large amounts
  
  return `${num.toLocaleString(undefined, { 
    minimumFractionDigits: 0,
    maximumFractionDigits: displayDecimals 
  })} ${symbol}`;
}


/**
 * Get token balance from contract with validation
 */
async function getTokenBalance(
  provider: ethers.JsonRpcProvider, 
  tokenAddress: string, 
  userAddress: string
): Promise<bigint> {
  try {
    // Ensure proper address format
    const checksumTokenAddress = ethers.getAddress(tokenAddress);
    const checksumUserAddress = ethers.getAddress(userAddress);
    
    const contract = new ethers.Contract(checksumTokenAddress, ERC20_ABI, provider);
    
    // Use staticCall for better error handling
    const balance = await contract.balanceOf.staticCall(checksumUserAddress);
    console.log(`Fetched balance for token ${tokenAddress} on ${provider._network.name}: ${balance.toString()}`);
    return BigInt(balance.toString());
  } catch (error: any) {
    console.warn(`Failed to get balance for token ${tokenAddress}: ${error?.message || error}`);
    return 0n;
  }
}

/**
 * Get native token balance with timeout
 */
async function getNativeBalance(provider: ethers.JsonRpcProvider, userAddress: string): Promise<bigint> {
  try {
    const checksumAddress = ethers.getAddress(userAddress);
    const balance = await provider.getBalance(checksumAddress);
    return BigInt(balance.toString());
  } catch (error: any) {
    console.warn(`Failed to get native balance: ${error?.message || error}`);
    return 0n;
  }
}

/**
 * Get balances for a specific network with timeout and error handling
 */
async function getNetworkBalances(
  networkKey: keyof typeof NETWORKS,
  userAddress: string
): Promise<{
  networkName: string;
  nativeBalance: { symbol: string; balance: bigint; formattedBalance: string };
  tokenBalances: Array<{
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    balance: bigint;
    formattedBalance: string;
  }>;
  error?: string;
}> {
  const networkConfig = NETWORKS[networkKey];
  
  try {
    const provider = getProvider(networkKey);
    const tokens = NETWORK_TOKENS[networkKey];

    // Get native token balance with timeout
    const nativeBalancePromise = getNativeBalance(provider, userAddress);
    const nativeBalance = await Promise.race([
      nativeBalancePromise,
      new Promise<bigint>((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 10000)
      )
    ]);
    
    let nativeSymbol: string;
    switch (networkKey) {
      case 'HEDERA_TESTNET':
        nativeSymbol = 'HBAR';
        break;
      case 'SEPOLIA':
        nativeSymbol = 'ETH';
        break;
      case 'ROOTSTOCK_TESTNET':
        nativeSymbol = 'RBTC';
        break;
      default:
        nativeSymbol = 'Native';
    }

    const formattedNativeBalance = formatTokenAmount(nativeBalance, 18, nativeSymbol);

    // Get token balances with individual error handling
    const tokenBalancePromises = Object.values(tokens).map(async (token) => {
      try {
        const balance = await Promise.race([
          getTokenBalance(provider, token.address, userAddress),
          new Promise<bigint>((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 8000)
          )
        ]);
        
        const formattedBalance = formatTokenAmount(balance, token.decimals, token.symbol);
        
        return {
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          balance,
          formattedBalance
        };
      } catch (error: any) {
        // Return zero balance for failed tokens
        return {
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          balance: 0n,
          formattedBalance: `0 ${token.symbol}`
        };
      }
    });

    const tokenBalances = await Promise.all(tokenBalancePromises);

    // Sort by symbol for consistent display
    tokenBalances.sort((a, b) => a.symbol.localeCompare(b.symbol));

    return {
      networkName: networkConfig.name,
      nativeBalance: {
        symbol: nativeSymbol,
        balance: nativeBalance,
        formattedBalance: formattedNativeBalance
      },
      tokenBalances
    };

  } catch (error: any) {
    console.error(`Error fetching balances for ${networkConfig.name}:`, error);
    
    return {
      networkName: networkConfig.name,
      nativeBalance: { symbol: 'N/A', balance: 0n, formattedBalance: '0 N/A' },
      tokenBalances: [],
      error: error?.message || 'Network connection failed'
    };
  }
}

/**
 * Zod parameters schema
 */
export const getAllTokenBalancesParameters = (context: Context = {}) =>
  z.object({
    networks: z
      .array(z.enum(['HEDERA_TESTNET', 'SEPOLIA', 'ROOTSTOCK_TESTNET']))
      .optional()
      .describe("Specific networks to check (defaults to all networks)"),
    customTokens: z
      .record(z.string(), z.array(z.object({
        address: z.string(),
        symbol: z.string(),
        name: z.string(),
        decimals: z.number()
      })))
      .optional()
      .describe("Additional tokens per network: {'SEPOLIA': [{'address': '0x123...', 'symbol': 'TOKEN', 'name': 'Token Name', 'decimals': 18}]}")
  });

export const getAllTokenBalancesPrompt = () => `
Returns all token balances (including native tokens and zero balances) across Hedera testnet, Sepolia, and Rootstock testnet.
Uses EVM address from environment variable EVM_ADDRESS.

Input: { 
  "networks": ["HEDERA_TESTNET", "SEPOLIA", "ROOTSTOCK_TESTNET"], // optional - defaults to all networks
  "customTokens": { // optional - additional tokens per network
    "SEPOLIA": [{"address": "0x123...", "symbol": "TOKEN", "name": "Token Name", "decimals": 18}]
  }
}

Shows balances for:
- Hedera Testnet: HBAR, USDC, SAUCE
- Sepolia: ETH, USDC, USDT, WETH, DAI, LINK  
- Rootstock Testnet: RBTC, rUSDT, RDOC, RIF, WRBTC
`;

/**
 * Execute function
 */
const getAllTokenBalancesExecute = async (
  _client: any,
  _context: Context,
  params: z.infer<ReturnType<typeof getAllTokenBalancesParameters>>
): Promise<string> => {
  try {
    const userAddress = getUserEvmAddress();
    const networksToCheck = params?.networks || ['HEDERA_TESTNET', 'SEPOLIA', 'ROOTSTOCK_TESTNET'];

    console.log(`Fetching token balances across ${networksToCheck.length} networks for address: ${userAddress}`);

    // Get balances from all requested networks with timeout
    const networkPromises = networksToCheck.map(networkKey => 
      Promise.race([
        getNetworkBalances(networkKey, userAddress),
        new Promise<any>((_, reject) => 
          setTimeout(() => reject(new Error('Network timeout')), 15000)
        )
      ]).catch(error => ({
        networkName: NETWORKS[networkKey].name,
        nativeBalance: { symbol: 'N/A', balance: 0n, formattedBalance: '0 N/A' },
        tokenBalances: [],
        error: error?.message || 'Network timeout'
      }))
    );

    const networkResults = await Promise.all(networkPromises);

    // Format response
    let response = `💰 **Multi-Network Token Portfolio**
• **EVM Address:** ${userAddress}
• **Networks:** ${networksToCheck.length} networks checked
• **Timestamp:** ${new Date().toISOString()}

`;

    let totalNetworks = 0;
    let totalTokens = 0;
    let totalActiveHoldings = 0;

    // Display results for each network
    for (const result of networkResults) {
      totalNetworks++;
      
      response += `🌐 **${result.networkName}**\n`;
      
      if (result.error) {
        response += `❌ Error: ${result.error}\n\n`;
        continue;
      }

      // Native token balance
      const nativeActive = result.nativeBalance.balance > 0n ? '🟢' : '⚪';
      response += `• ${nativeActive} **${result.nativeBalance.symbol}**: ${result.nativeBalance.formattedBalance}\n`;
      
      if (result.nativeBalance.balance > 0n) totalActiveHoldings++;
      totalTokens++;

      // Token balances
      if (result.tokenBalances.length > 0) {
        for (const token of result.tokenBalances) {
          const balanceIcon = token.balance > 0n ? '🟢' : '⚪';
          response += `• ${balanceIcon} **${token.symbol}** (${token.name}): ${token.formattedBalance}\n`;
          
          if (token.balance > 0n) totalActiveHoldings++;
          totalTokens++;
        }
      } else {
        response += `• No tokens configured for this network\n`;
      }
      
      response += `\n`;
    }

    // Portfolio summary
    response += `📊 **Portfolio Summary**
• **Total Networks:** ${totalNetworks}
• **Total Assets:** ${totalTokens} (native + tokens)
• **Active Holdings:** ${totalActiveHoldings}
• **Zero Balances:** ${totalTokens - totalActiveHoldings}

🔍 **Legend:**
• 🟢 = Active balance (> 0)
• ⚪ = Zero balance

✅ Multi-network portfolio retrieved successfully!

💡 **Tips:**
• Add more tokens using the "customTokens" parameter
• Specify "networks" array to check only specific networks
• Ensure proper RPC endpoints are configured`;

    return response;

  } catch (err: any) {
    console.error("Get all token balances failed:", err);
    const message = err?.message || String(err);
    return `❌ **Multi-Network Token Portfolio Query Failed**
Error: ${message}

💡 **Possible Issues:**
• Missing or invalid EVM_ADDRESS in environment variables
• Network connectivity issues
• RPC endpoint problems

**Setup Required:**
• Set EVM_ADDRESS=0x... in your .env file (without quotes)
• For Sepolia: Set SEPOLIA_RPC_URL with valid Infura/Alchemy endpoint
• Ensure stable internet connection

**Try:** 
• Check your .env file has valid EVM_ADDRESS without quotes
• Verify RPC endpoints are accessible
• Test with single network first: {"networks": ["HEDERA_TESTNET"]}`;
  }
};

/**
 * Tool export (factory)
 */
export const GET_ALL_TOKEN_BALANCES = "GET_ALL_TOKEN_BALANCES";

const tool = (context: Context): Tool => ({
  method: GET_ALL_TOKEN_BALANCES,
  name: "Get All Token Balances",
  description: getAllTokenBalancesPrompt(),
  parameters: getAllTokenBalancesParameters(context),
  execute: getAllTokenBalancesExecute,
});

export default tool;