// my-custom-plugin/best-strategy-plugin.ts
import { z } from "zod";
import { Context, Tool } from "hedera-agent-kit";
import { Client } from "@hashgraph/sdk";
import fetch from "node-fetch";
import { EvmPriceServiceConnection, HermesClient } from "@pythnetwork/hermes-client";

const bestStrategyParameters = (context: Context = {}) =>
  z.object({
    tokenAmount: z
      .number()
      .optional()
      .describe("Amount of HBAR tokens to analyze (optional, for context)"),
  });

/* ---------------------------
   Helpers: APY fetching & parsing
   --------------------------- */

async function fetchAPYFromApi(
  url?: string | null,
  apiKey?: string | null
): Promise<number | null> {
  if (!url) return null;

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      // common pattern; adjust if your API expects a different header
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(url, { method: "GET", headers, timeout: 15000 });
    if (!res.ok) {
      // not fatal — caller will fall back
      console.debug(`APY fetch returned non-2xx (${res.status}) for ${url}`);
      return null;
    }

    const body = await res.json();

    // try multiple common fields for APY returned by various APIs
    const possiblePaths = [
      "apy",
      "data.apy",
      "data.apy_percent",
      "data.apy_pct",
      "data.apyPercent",
      "apy_percent",
      "apyPct",
      "apyPercentage",
      "yield.apy",
      "stats.apy",
      "result.apy",
    ];

    for (const p of possiblePaths) {
      const value = getPath(body, p);
      if (value !== undefined && value !== null && !Number.isNaN(Number(value))) {
        return Number(value);
      }
    }

    // some APIs return APY as a string like "5.23%" or "5.23"
    // attempt to find any numeric-looking field anywhere
    const numeric = findFirstNumericInObject(body);
    if (numeric !== null) return numeric;

    console.debug("APY parse heuristics failed for", url, body);
    return null;
  } catch (err) {
    console.debug("APY fetch error for", url, err instanceof Error ? err.message : err);
    return null;
  }
}

function getPath(obj: any, path: string) {
  const keys = path.split(".");
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function findFirstNumericInObject(obj: any): number | null {
  if (obj == null) return null;
  if (typeof obj === "number" && !Number.isNaN(obj)) return obj;
  if (typeof obj === "string") {
    const cleaned = obj.replace(/[^0-9.\-]/g, "");
    const n = Number(cleaned);
    return Number.isNaN(n) ? null : n;
  }
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const found = findFirstNumericInObject(el);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const found = findFirstNumericInObject(obj[k]);
      if (found !== null) return found;
    }
  }
  return null;
}


/* ---------------------------
   Pyth/Hermes price fetch
   --------------------------- */

async function fetchHBARPriceFromPyth(): Promise<number | null> {
  const hermesUrl = process.env.HERMES_URL || "https://hermes.pyth.network";
  const hbarPriceId = process.env.HBAR_USD_ID; // expect bytes32 hex string like 0x...

  if (!hbarPriceId) {
    console.debug("HBAR_USD_ID not set in env - cannot fetch Pyth price");
    return null;
  }

  try {
    // HermesClient exposes getLatestPriceUpdates which returns a parsed price
    // Use the parsed.price if available (docs/examples show .parsed[i].price)
    const client = new HermesClient(hermesUrl);
    const latest = await client.getLatestPriceUpdates([hbarPriceId], { encoding: "hex" });

    // docs/examples: latest.parsed?.[0].price
    const parsed = (latest as any).parsed;
    if (parsed && parsed[0] && typeof parsed[0].price === "number") {
      return parsed[0].price;
    }

    // some hermes clients include parsed under latest.parsed or latest.parsedPriceFeeds
    if ((latest as any)?.parsed?.length) {
      const p = (latest as any).parsed[0];
      if (p && typeof p.price === "number") return p.price;
    }

    // As last resort, attempt to find numeric fields in the entire response
    const numeric = findFirstNumericInObject(latest);
    if (numeric !== null) return numeric;

    console.debug("Could not read numeric price from Hermes response:", latest);
    return null;
  } catch (err) {
    console.debug("Error fetching HBAR price from Pyth/Hermes:", err instanceof Error ? err.message : err);
    return null;
  }
}

/* ---------------------------
   Tool implementation
   --------------------------- */

const bestStrategyPrompt = (context: Context = {}) => {
  return `
  Analyzes current market conditions and recommends the best strategy for HBAR tokens.

  This tool fetches real-time HBAR price from Pyth/Hermes and compares APY rates across SaucerSwap and SushiSwap
  (APIs provided via environment variables). It then recommends the platform with the higher APY and includes
  an estimated annual yield for the provided tokenAmount (if given).
  `;
};

const bestStrategyExecute = async (
  client: Client,
  context: Context,
  params: z.infer<ReturnType<typeof bestStrategyParameters>>
) => {
  try {
    // Read API config from env
    const saucerApiUrl = process.env.SAUCER_API_URL ?? null;
    const saucerApiKey = process.env.SAUCER_API_KEY ?? null;

    const sushiApiUrl = process.env.SUSHI_API_URL ?? null;
    const sushiApiKey = process.env.SUSHI_API_KEY ?? null;

    // Fetch APYs (concurrent)
    const [saucerswapFetched, sushiswapFetched] = await Promise.all([
      fetchAPYFromApi(saucerApiUrl, saucerApiKey),
      fetchAPYFromApi(sushiApiUrl, sushiApiKey),
    ]);

    const saucerswapAPY = saucerswapFetched ;
    const sushiswapAPY = sushiswapFetched ;

    // Fetch HBAR price from Pyth (Hermes)
    const hbarPriceUSD = (await fetchHBARPriceFromPyth()) ;

    // Determine best platform
    const bestPlatform = saucerswapAPY > sushiswapAPY ? "saucerswap" : "sushiswap";
    const bestAPY = Math.max(saucerswapAPY, sushiswapAPY);

    // Compose analysis text
    let recommendation = "";
    let actionSuggestion = "";

    if (bestPlatform === "saucerswap") {
      recommendation = `SaucerSwap offers the better APY at ${bestAPY}%. I recommend creating a swap order to optimize your HBAR position for maximum yield farming returns.`;
      actionSuggestion = "Consider creating a limit order to swap HBAR for USDC/SAUCE at optimal prices for SaucerSwap yield farming.";
    } else {
      recommendation = `SushiSwap offers the better APY at ${bestAPY}%. I recommend using the vault strategy to deposit liquidity and earn automated yield.`;
      actionSuggestion = "Consider depositing your tokens into the Rootstock vault for automated SushiSwap yield farming.";
    }

    const analysisLines: string[] = [];

    analysisLines.push("🎯 **HBAR Strategy Analysis**\n");
    analysisLines.push("📊 **Current Market Data (Fetched):**");
    analysisLines.push(`• HBAR Price (USD): ${hbarPriceUSD.toFixed(6)}`);
    analysisLines.push(`• SaucerSwap APY: ${saucerswapAPY}%`);
    analysisLines.push(`• SushiSwap APY: ${sushiswapAPY}%\n`);

    analysisLines.push("🔍 **Analysis:**");
    analysisLines.push(`Based on current yield rates, **${bestPlatform.toUpperCase()}** offers superior returns at ${bestAPY}%.\n`);

    analysisLines.push("💡 **Recommendation:**");
    analysisLines.push(recommendation + "\n");

    analysisLines.push("🚀 **Suggested Action:**");
    analysisLines.push(actionSuggestion + "\n");

    analysisLines.push("⚠️ **Risk Considerations:**");
    analysisLines.push("• APY rates are dynamic and subject to change");
    analysisLines.push("• Consider gas fees and transaction costs");
    analysisLines.push("• Diversification across platforms may reduce risk");
    analysisLines.push("• Monitor market conditions regularly\n");

    if (params.tokenAmount) {
      const usdValue = params.tokenAmount * hbarPriceUSD;
      const annualYieldUSD = (usdValue * bestAPY) / 100;
      analysisLines.push(
        `💰 **For your ${params.tokenAmount} HBAR:**\nEstimated USD value: $${usdValue.toFixed(
          4
        )}\nAnnual yield potential (at ${bestAPY}%): $${annualYieldUSD.toFixed(4)}`
      );
    }

    const analysis = analysisLines.join("\n");

    return {
      success: true,
      analysis,
      data: {
        hbarPrice: hbarPriceUSD,
        saucerswapAPY,
        sushiswapAPY,
        recommendedPlatform: bestPlatform,
        bestAPY,
        tokenAmount: params.tokenAmount ?? null,
        metadata: {
          saucerApiUrl: saucerApiUrl ?? null,
          sushiApiUrl: sushiApiUrl ?? null,
          hermesUrl: process.env.HERMES_URL ?? "https://hermes.pyth.network",
          hbarPriceId: process.env.HBAR_USD_ID ?? null,
          apyFetched: {
            saucer: saucerApiUrl ? (saucerswapFetched !== null) : false,
            sushi: sushiApiUrl ? (sushiswapFetched !== null) : false,
          },
        },
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Strategy analysis failed";
    return {
      success: false,
      error: errorMsg,
      analysis: `❌ Unable to analyze strategy: ${errorMsg}`,
    };
  }
};

export const BEST_STRATEGY_TOOL = "best_strategy_tool";

const tool = (context: Context): Tool => ({
  method: BEST_STRATEGY_TOOL,
  name: "Best Strategy Recommendation Tool",
  description: bestStrategyPrompt(context),
  parameters: bestStrategyParameters(context),
  execute: bestStrategyExecute,
});

export default tool;



