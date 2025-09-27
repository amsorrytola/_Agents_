// my-custom-plugin/tools/account-query/get-all-token-balances-agent.ts
import fetch from "node-fetch";
import { z } from "zod";
import { ethers } from "ethers";
import type { Context, Tool } from "hedera-agent-kit";

/**
 * Local known networks & tokens (fallback / curated)
 * Keep this small — the dynamic discovery will extend these.
 */
const NETWORK_TOKENS = {
  HEDERA_TESTNET: {
    HBAR: {
      address: "0x0000000000000000000000000000000000342855",
      symbol: "HBAR",
      name: "HBAR",
      decimals: 18,
    },
  },
  SEPOLIA: {
    SepoliaETH: {
      address: "0xdbc1856cbD9553B8F2BE31f6E6d5695dC823B47C",
      symbol: "SepoliaETH",
      name: "Sepolia Ether",
      decimals: 18,
    },
  },
  ROOTSTOCK_TESTNET: {
    tRBTC: {
      address: "0x1a09C14922247d2D9731B7D7eE55F2833Ad8C557",
      symbol: "tRBTC",
      name: "tRBTC",
      decimals: 18,
    },
  },
};

/**
 * ERC20 ABI subset
 */
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
];

/**
 * Chain catalog source (community-maintained)
 * See: https://chainid.network/chains.json
 * This returns JSON array of chain metadata objects.
 */
const CHAINLIST_URL = "https://chainid.network/chains.json";

/**
 * Utility: fetch chain catalog (cached in-memory for this process)
 */
let _cachedChains: any[] | null = null;
async function fetchChainCatalog(): Promise<any[]> {
  if (_cachedChains) return _cachedChains;
  const res = await fetch(CHAINLIST_URL, { timeout: 10000 });
  if (!res.ok) throw new Error(`Failed to fetch chain catalog: ${res.status}`);
  const json = await res.json();
  _cachedChains = json;
  return json;
}

/**
 * Try Covalent balances_v2 for a given decimal chainId.
 * Endpoint: https://api.covalenthq.com/v1/{chain_id}/address/{address}/balances_v2/?key={API_KEY}
 * NOTE: Covalent uses decimal chain ids (1, 56, 137, 11155111, 31, 296, etc.) for supported chains.
 */
async function covalentGetBalances(chainId: number, address: string): Promise<any | null> {
  const key = process.env.COVALENT_API_KEY;
  if (!key) return null;
  // Some hosted providers use different proxied endpoints; this is the standard pattern.
  const url = `https://api.covalenthq.com/v1/${chainId}/address/${address}/balances_v2/?key=${key}`;
  try {
    const res = await fetch(url, { timeout: 15000 });
    if (!res.ok) {
      // 404 or unsupported chain -> return null (we'll fallback)
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`Covalent request failed for chain ${chainId}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Create an ethers provider from an RPC URL (with basic timeout wrapper).
 */
function createProvider(rpcUrl: string, chainId?: number, name?: string): ethers.JsonRpcProvider {
  const network = chainId
    ? { chainId, name: (name || "unknown").toLowerCase().replace(/\s+/g, "-") }
    : undefined;
  return new ethers.JsonRpcProvider(rpcUrl, network as any);
}

/**
 * Resolve and checksum a possibly malformed address string.
 * - Removes quotes / whitespace / common prefixes
 * - Removes zero-width / non-ASCII characters
 * - If input contains extra text (URL, explorer string), attempts to extract last 40 hex chars
 * - Returns checksummed address via ethers.getAddress or throws if impossible
 */
function resolveAddress(input: string | undefined, label = "address"): string {
  if (!input) throw new Error(`Missing ${label}`);
  // basic cleanup
  let addr = String(input).trim();

  // Remove common prefixes/labels like "ethereum:", "addr=", "Address:"
  addr = addr.replace(/^ethereum:/i, "");
  addr = addr.replace(/^(address|addr)=/i, "");
  addr = addr.replace(/^(0x)?["']|["']$/g, ""); // strip leading/trailing quotes

  // Remove common explorer url wrappers (keep hex chars)
  // Remove any non-hex characters except 0x
  // But first replace invisible unicode characters (zero-width, etc.)
  addr = addr.replace(/[\u200B-\u200D\uFEFF]/g, ""); // remove zero-width chars

  // If it looks like a URL or contains many non-hexs, try to extract the last 40 hex chars
  const hexOnly = addr.match(/0x([0-9a-fA-F]{40})/) || addr.match(/([0-9a-fA-F]{40})$/);
  if (hexOnly && hexOnly.length >= 2) {
    addr = "0x" + hexOnly[1];
  } else {
    // remove everything that's not hex or 0x, then hope it's valid
    addr = addr.replace(/[^0-9a-fA-Fx]/g, "");
  }

  // ensure it starts with 0x
  if (!addr.startsWith("0x")) {
    addr = "0x" + addr;
  }

  // If too long or too short, throw early
  const hex = addr.replace(/^0x/i, "");
  if (hex.length !== 40) {
    throw new Error(`Unable to parse ${label}: "${input}". Extracted "${addr}" (length ${hex.length}).`);
  }

  // Now use ethers.getAddress to compute/validate checksum — it will throw if not a valid address
  try {
    return ethers.getAddress(addr);
  } catch (err) {
    // Pass along a helpful message
    throw new Error(`Failed to checksum ${label} "${input}": ${(err as Error).message}`);
  }
}


/**
 * Validate and checksummed EVM user address from env
 */
function getUserEvmAddress(): string {
  const raw = process.env.EVM_ADDRESS;
  if (!raw) {
    throw new Error("EVM_ADDRESS not set in environment. Please set EVM_ADDRESS=0x... in your .env file");
  }
  // resolve + checksum
  return resolveAddress(raw, "EVM_ADDRESS");
}


/**
 * Format token amount
 */
function formatTokenAmount(amount: bigint, decimals: number, symbol: string): string {
  const formatted = ethers.formatUnits(amount, decimals);
  const num = parseFloat(formatted);
  if (num === 0) return `0 ${symbol}`;
  let displayDecimals = 4;
  if (decimals === 6) displayDecimals = 4;
  if (decimals === 18 && num < 1) displayDecimals = 8;
  if (num > 1000) displayDecimals = 2;
  return `${num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: displayDecimals,
  })} ${symbol}`;
}

/**
 * Get native balance via provider with timeout
 */
async function getNativeBalanceWithProvider(provider: ethers.JsonRpcProvider, addr: string): Promise<bigint> {
  const checksum = resolveAddress(addr, "userAddress");
  return await Promise.race([
    provider.getBalance(checksum).then(b => BigInt(b.toString())),
    new Promise<bigint>((_, rej) => setTimeout(() => rej(new Error("native-balance-timeout")), 10000)),
  ]);
}

/**
 * Get ERC20 token balance via provider with timeout
 */
async function getTokenBalanceWithProvider(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  addr: string,
  decimals = 18
): Promise<{ balance: bigint; formatted: string }> {
  try {
    const checksumToken = resolveAddress(tokenAddress, "tokenAddress");
    const checksumAddr = resolveAddress(addr, "userAddress");
    const contract = new ethers.Contract(checksumToken, ERC20_ABI, provider);
    const bal: any = await Promise.race([
      contract.balanceOf(checksumAddr),
      new Promise((_, rej) => setTimeout(() => rej(new Error("erc20-balance-timeout")), 8000)),
    ]);
    const big = BigInt(bal.toString());
    return { balance: big, formatted: formatTokenAmount(big, decimals, "TOKEN") };
  } catch (err) {
    console.warn(`getTokenBalanceWithProvider error for token ${tokenAddress}: ${(err as Error).message}`);
    return { balance: 0n, formatted: `0 TOKEN` };
  }
}


/**
 * Determine candidate chains to check.
 * We will:
 *  - load chainlist catalog,
 *  - filter to chains that have at least one RPC url,
 *  - and prefer commonly used chains (you can modify the priority list).
 *
 * To avoid scanning hundreds of chains by default, we will:
 *  - include any chain in `priorityChainIds` first,
 *  - then optionally include more if you set env SCAN_FULL_CATALOG=true.
 */
const priorityChainIds = [
  1, // Ethereum Mainnet
  11155111, // Sepolia
  137, // Polygon
  56, // BSC
  43114, // Avalanche
  10, // Optimism
  69, // Optimism Kovan (older)
  31, // Rootstock Testnet
  296, // Hedera Testnet (used in your code)
];

async function buildCandidateChains(): Promise<Array<{ chainId: number; name: string; rpc: string; nativeCurrency?: any }>> {
  const catalog = await fetchChainCatalog();
  // map by decimal chainId for quick lookup
  const chainsById = new Map<number, any>();
  for (const c of catalog) {
    const id = Number(c.chainId);
    if (!id || !c.rpc || c.rpc.length === 0) continue;
    // pick first working RPC (could be improved by testing them)
    chainsById.set(id, c);
  }

  const candidates: any[] = [];
  for (const id of priorityChainIds) {
    const c = chainsById.get(id);
    if (c) {
      candidates.push({ chainId: id, name: c.name, rpc: c.rpc[0], nativeCurrency: c.nativeCurrency });
      chainsById.delete(id);
    }
  }

  // Optionally append more chains if env asks for full scan
  if (process.env.SCAN_FULL_CATALOG === "true") {
    for (const [id, c] of chainsById.entries()) {
      candidates.push({ chainId: id, name: c.name, rpc: c.rpc[0], nativeCurrency: c.nativeCurrency });
    }
  }

  return candidates;
}

/**
 * Detect networks where the address has activity/balances.
 * Strategy:
 *  - If COVALENT_API_KEY is present, call Covalent balances_v2 per chain (fast, returns token list).
 *  - Otherwise, use chain RPC to get native balance and optionally fallback tokens from NETWORK_TOKENS map.
 *
 * Returns structured results compatible with your previous result format.
 */
async function detectAndFetchBalancesForAddress(address: string) {
  const candidates = await buildCandidateChains();
  const results: any[] = [];

  // cap number of chains checked to avoid timeouts if SCAN_FULL_CATALOG not enabled
  const cap = process.env.SCAN_FULL_CATALOG === "true" ? candidates.length : Math.min(candidates.length, 12);

  for (let i = 0; i < cap; i++) {
    const candidate = candidates[i];
    const chainId = candidate.chainId;
    const chainName = candidate.name;
    const rpc = candidate.rpc;
    const nativeSymbol = candidate.nativeCurrency?.symbol || "NATIVE";

    // Try Covalent first (if present)
    const covalentResp = await covalentGetBalances(chainId, address);
    if (covalentResp && covalentResp.data) {
      // Covalent returns lots of info; map native + token balances to our format
      const nativeItem = covalentResp.data.items.find((it: any) => it.contract_address === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" || it.contract_address === null);
      const nativeBalance = nativeItem ? BigInt(nativeItem.balance || 0) : 0n;
      const nativeDecimals = nativeItem ? (nativeItem.contract_decimals || 18) : 18;
      const nativeFormatted = formatTokenAmount(nativeBalance, nativeDecimals, nativeSymbol);

      const tokens = (covalentResp.data.items || []).filter((it: any) => it.contract_address && it.contract_ticker_symbol)
        .map((it: any) => ({
          address: it.contract_address,
          symbol: it.contract_ticker_symbol,
          name: it.contract_name || it.contract_ticker_symbol,
          decimals: it.contract_decimals || 18,
          balance: BigInt(it.balance || 0),
          formattedBalance: formatTokenAmount(BigInt(it.balance || 0), it.contract_decimals || 18, it.contract_ticker_symbol),
        }));

      results.push({
        networkName: chainName,
        chainId,
        rpc,
        nativeBalance: { symbol: nativeSymbol, balance: nativeBalance, formattedBalance: nativeFormatted },
        tokenBalances: tokens,
      });

      // small delay to be polite to Covalent / rate limits
      await new Promise((res) => setTimeout(res, 200));
      continue;
    }

    // Fallback: RPC provider approach
    try {
      const provider = createProvider(rpc, chainId, chainName);
      // quick native balance check
      let nativeBalance = 0n;
      try {
        nativeBalance = await getNativeBalanceWithProvider(provider, address);
      } catch (err) {
        // if provider fails - skip this chain gracefully
        console.warn(`RPC native balance check failed for ${chainName} (${chainId}): ${(err as Error).message}`);
        continue;
      }
      const nativeFormatted = formatTokenAmount(nativeBalance, 18, nativeSymbol);

      // look for known tokens for that chain (if present in NETWORK_TOKENS)
      let tokenBalances: any[] = [];
      // map some of your fallback network labels to chainId heuristically
      if (chainId === 11155111 && NETWORK_TOKENS.SEPOLIA) {
        tokenBalances = await Promise.all(
          Object.values(NETWORK_TOKENS.SEPOLIA).map(async (token) => {
            const tb = await getTokenBalanceWithProvider(provider, token.address, address, token.decimals);
            return {
              address: token.address,
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              balance: tb.balance,
              formattedBalance: formatTokenAmount(tb.balance, token.decimals, token.symbol),
            };
          })
        );
      } else if (chainId === 31 && NETWORK_TOKENS.ROOTSTOCK_TESTNET) {
        tokenBalances = await Promise.all(
          Object.values(NETWORK_TOKENS.ROOTSTOCK_TESTNET).map(async (token) => {
            const tb = await getTokenBalanceWithProvider(provider, token.address, address, token.decimals);
            return {
              address: token.address,
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              balance: tb.balance,
              formattedBalance: formatTokenAmount(tb.balance, token.decimals, token.symbol),
            };
          })
        );
      } else if (chainId === 296 && NETWORK_TOKENS.HEDERA_TESTNET) {
        tokenBalances = await Promise.all(
          Object.values(NETWORK_TOKENS.HEDERA_TESTNET).map(async (token) => {
            const tb = await getTokenBalanceWithProvider(provider, token.address, address, token.decimals);
            return {
              address: token.address,
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              balance: tb.balance,
              formattedBalance: formatTokenAmount(tb.balance, token.decimals, token.symbol),
            };
          })
        );
      }

      results.push({
        networkName: chainName,
        chainId,
        rpc,
        nativeBalance: { symbol: nativeSymbol, balance: nativeBalance, formattedBalance: nativeFormatted },
        tokenBalances,
      });

    } catch (err) {
      console.warn(`Skipping chain ${chainName} (${chainId}) due to error: ${(err as Error).message}`);
      continue;
    }
  }

  // Consider "supported in wallet" = chains where either native balance > 0 OR non-empty tokenBalances
  const activeChains = results.filter((r) => {
    const nativeActive = (r.nativeBalance?.balance || 0n) > 0n;
    const tokensActive = (r.tokenBalances || []).some((t: any) => (t.balance || 0n) > 0n);
    return nativeActive || tokensActive;
  });

  // If there are no active chains, return the scanned results (to show zeros) — useful during debugging
  return { scanned: results, activeChains, allFoundChains: results };
}

/**
 * zod parameters + prompt unchanged — kept for compatibility
 */
export const getAllTokenBalancesParameters = (context: Context = {}) =>
  z.object({
    networks: z
      .array(z.string())
      .optional()
      .describe("Specific networks to check (defaults to autodiscovered networks)"),
    customTokens: z
      .record(
        z.string(),
        z.array(
          z.object({
            address: z.string(),
            symbol: z.string(),
            name: z.string(),
            decimals: z.number(),
          })
        )
      )
      .optional()
      .describe("Additional tokens per network"),
  });

export const getAllTokenBalancesPrompt = () => `
Returns all token balances across networks the user's wallet/address is active on.
Uses EVM address from environment variable EVM_ADDRESS.
`;

/**
 * Main execute function — uses dynamic discovery
 */
const getAllTokenBalancesExecute = async (
  _client: any,
  _context: Context,
  params: z.infer<ReturnType<typeof getAllTokenBalancesParameters>>
): Promise<string> => {
  try {
    const userAddress = getUserEvmAddress();
    console.log(`Autodiscovering networks for ${userAddress}...`);

    const { scanned, activeChains } = await detectAndFetchBalancesForAddress(userAddress);

    // If user passed explicit networks param, prefer that (backwards compat)
    let networksToDisplay = activeChains;
    if (params?.networks && Array.isArray(params.networks) && params.networks.length > 0) {
      // Map the scanned results to match names in params (best-effort)
      networksToDisplay = scanned.filter((r: any) => params.networks.includes(String(r.chainId)) || params.networks.includes(r.networkName));
      // if none matched, keep scanned results
      if (networksToDisplay.length === 0) networksToDisplay = scanned;
    }

    // Build textual response
    let response = `💰 **Multi-Network Token Portfolio (auto-discovered)**\n• **EVM Address:** ${userAddress}\n• **Discovered networks scanned:** ${scanned.length}\n• **Active networks (non-zero balances):** ${activeChains.length}\n• **Timestamp:** ${new Date().toISOString()}\n\n`;

    let totalNetworks = 0;
    let totalTokens = 0;
    let totalActiveHoldings = 0;

    for (const net of networksToDisplay) {
      totalNetworks++;
      response += `🌐 **${net.networkName}** (chainId: ${net.chainId})\n`;

      // Native
      const nativeActive = net.nativeBalance.balance > 0n ? "🟢" : "⚪";
      response += `• ${nativeActive} **${net.nativeBalance.symbol}**: ${net.nativeBalance.formattedBalance}\n`;
      if (net.nativeBalance.balance > 0n) totalActiveHoldings++;
      totalTokens++;

      // Tokens
      if (net.tokenBalances && net.tokenBalances.length > 0) {
        for (const token of net.tokenBalances) {
          const icon = token.balance > 0n ? "🟢" : "⚪";
          response += `• ${icon} **${token.symbol}** (${token.name}): ${token.formattedBalance}\n`;
          if (token.balance > 0n) totalActiveHoldings++;
          totalTokens++;
        }
      } else {
        response += `• No token balances returned / configured for this network\n`;
      }
      response += `\n`;
    }

    response += `📊 **Summary**\n• **Total Networks Displayed:** ${totalNetworks}\n• **Total Assets (native + tokens):** ${totalTokens}\n• **Active Holdings:** ${totalActiveHoldings}\n• **Zero Balances:** ${totalTokens - totalActiveHoldings}\n\n✅ Done. Tips:\n• Provide COVALENT_API_KEY in env for faster multi-chain token detection\n• Set SCAN_FULL_CATALOG=true to scan entire chain catalog (slow)\n• Provide customTokens param to add tokens not indexed by Covalent\n`;

    return response;
  } catch (err: any) {
    console.error("GetAllTokenBalances failed:", err);
    return `❌ Error: ${err?.message || String(err)}`;
  }
};

/**
 * Tool export
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
