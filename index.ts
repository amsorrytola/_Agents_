// index.ts (fixed)
// Final index.ts with enhanced DeFi agent and professional user interaction

import dotenv from "dotenv";
dotenv.config();

import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatGroq } from "@langchain/groq";
import { Client, PrivateKey } from "@hashgraph/sdk";
import { HederaLangchainToolkit, AgentMode, coreAccountQueryPlugin, coreAccountQueryPluginToolNames } from "hedera-agent-kit";
import { logger, logSuccess, logError, logDebug } from "./logger.js";
import { isSmallTalk } from "./utils/isSmallTalk.js";

type AnyObject = Record<string, any>;

function createLLM() {
  return new ChatGroq({
    model: "llama-3.3-70b-versatile",
    apiKey: process.env.GROQ_API_KEY,
    temperature: 0.15,
    verbose: false,
    maxRetries: 3,
    timeout: 45000,
  });
}

function parsePrivateKeyFromEnv(envKeyName = "PRIVATE_KEY"): PrivateKey {
  const raw = process.env[envKeyName];
  if (!raw) {
    throw new Error(
      `Missing environment variable ${envKeyName}. Add it to your .env (no surrounding quotes).`
    );
  }

  try {
    return PrivateKey.fromStringECDSA(raw);
  } catch (e1) {
    try {
      return PrivateKey.fromString(raw);
    } catch (e2) {
      const hint =
        "Key parse failed. Ensure the .env value has no surrounding quotes or stray whitespace.";
      const err = new Error(
        `Unable to parse private key from env variable. ${hint} (${String(e2)})`
      );
      // Attach inner details for debugging
      (err as AnyObject).inner = {
        e1: e1 instanceof Error ? e1.message : String(e1),
        e2: e2 instanceof Error ? e2.message : String(e2),
      };
      throw err;
    }
  }
}

export async function buildHederaClient(): Promise<Client> {
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  if (!accountId) {
    throw new Error(
      "Missing HEDERA_ACCOUNT_ID in environment. Add HEDERA_ACCOUNT_ID=0.0.x to your .env"
    );
  }

  const pk = parsePrivateKeyFromEnv("PRIVATE_KEY");
  const client = Client.forTestnet().setOperator(accountId, pk);

  logDebug("Hedera client configured", { accountId });
  return client;
}

export async function buildAgentExecutor(client: Client) {
  logDebug("Building professional DeFi agent...");

  const hederaAgentToolkit = new HederaLangchainToolkit({
    client,
    configuration: {
      tools: [
        coreAccountQueryPluginToolNames.GET_HBAR_BALANCE_QUERY_TOOL
      ],
      plugins: [coreAccountQueryPlugin],
      context: {
        // Keep same as your original intent; agent autonomy is controlled by behavior rules
        mode: AgentMode.AUTONOMOUS,
      },
    },
  });

  const tools = hederaAgentToolkit.getTools();
  const llm = createLLM();


  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `You are YieldCraft AI - a professional DeFi assistant.

**🎯 Core Mission:**
Help users efficiently manage DeFi operations, with expertise in AutoSwap limit orders, account management, and transaction monitoring.

**🚨 CRITICAL BEHAVIOR RULES:**
• ONLY use ONE TOOL per user request unless explicitly asked for multiple actions

**🔧 Available Capabilities:**

**Account & Network Operations:**
• GET_HBAR_BALANCE: Get HBAR balance for account (STOP after showing result)

**🗣️ Communication Style:**
• Be professional yet approachable
• Use clear formatting for better readability
• Provide specific, actionable information
• Always explain technical concepts when relevant
• Offer next steps as SUGGESTIONS only - never execute them automatically
• Handle errors gracefully with helpful troubleshooting

**🔍 User Intent Recognition:**
GET_HBAR_BALANCE : STOP after showing results - DO NOT take further actions

**⚡ Response Guidelines:**
• Use EXACTLY ONE TOOL per user request
• For balance queries: Show the balance results, then suggest related actions

**💡 Proper Workflow:**
1. User requests action → Execute ONE tool → Show complete results
2. Suggest next steps as text suggestions only
3. Wait for user's next request before taking any action
4. Never assume what users want to do next

Remember: You're a helpful assistant that executes ONE action at a time and respects user autonomy. Show complete results and let users decide their next step.`,
    ],
    ["placeholder", "{chat_history}"],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]);

  const agent = createToolCallingAgent({
    llm,
    tools,
    prompt,
  });

  const agentExecutor = new AgentExecutor({
    agent,
    tools,
    verbose: false,
    maxIterations: 6,
    handleParsingErrors: true,
    returnIntermediateSteps: false,
  });

  logDebug("Professional DeFi agent ready", {
    toolCount: Array.isArray(tools) ? tools.length : undefined,
    autoswapTools: 5,
  });

  return agentExecutor;
}

/**
 * interactiveLoop - main REPL loop
 */
async function interactiveLoop(agentExecutor: any) {
  const rl = readline.createInterface({ input, output, terminal: true });
  const { terminal } = await import("./utils/terminalController.js");

  terminal.clearAndShowHeader();

  while (true) {
    try {
      const userInput = await rl.question("💬 You: ");

      if (!userInput?.trim()) continue;

      const inputText = userInput.trim();
      const lowerInput = inputText.toLowerCase();

      // System commands
      if (["exit", "quit", "bye"].includes(lowerInput)) {
        terminal.print(
          "Thanks for using YieldCraft AI! Your DeFi operations are in good hands. 👋✨",
          "success"
        );
        rl.close();
        break;
      }

      if (["clear", "cls"].includes(lowerInput)) {
        terminal.clearAndShowHeader();
        continue;
      }

      if (lowerInput === "status") {
        terminal.showStatus();
        continue;
      }

      if (lowerInput === "logs") {
        terminal.showRecentLogs(20);
        continue;
      }

      

      terminal.showProcessing("Analyzing request and preparing response");

      const startTime = Date.now();

      // Small talk handling
      if (isSmallTalk(inputText)) {
        terminal.hideProcessing();
        terminal.print("💬 YieldCraft AI:", "info");
        console.log(`Hello! I'm your professional DeFi assistant for Hedera network.


What would you like to do today?`);
        continue;
      }

      // call the agent
      let result: any;
      try {
        // LangChain AgentExecutor.invoke shape differs by versions.
        // We handle common shapes below.
        result = await agentExecutor.invoke({
          input: inputText,
          chat_history: [],
        });
      } catch (agentError: any) {
        terminal.hideProcessing();

        const errMsg = (agentError && agentError.message) || String(agentError);
        console.error("💥 Agent execution error:", errMsg);
      }

      const duration = Date.now() - startTime;
      terminal.hideProcessing();

      // Normalize agent response text
      let outputText: string;
      if (!result) {
        outputText = "No response from agent.";
      } else if (typeof result === "string") {
        outputText = result;
      } else if (typeof result.output === "string") {
        outputText = result.output;
      } else if (typeof result.text === "string") {
        outputText = result.text;
      } else if (typeof (result as AnyObject).result === "string") {
        outputText = (result as AnyObject).result;
      } else {
        try {
          outputText = JSON.stringify(result, null, 2);
        } catch {
          outputText = String(result);
        }
      }

      const cleanOutput = terminal.formatResponse
        ? terminal.formatResponse(outputText)
        : outputText;

      terminal.print(`🤖 YieldCraft AI (${duration}ms):`, "info");
      console.log(cleanOutput);

      

      console.log(""); // spacing
    } catch (err: any) {
      terminal.hideProcessing();

      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("💥 Error processing request:", errorMsg);

    }
  }
}

async function main() {
  try {
    logDebug("🚀 Initializing YieldCraft AI - Professional DeFi Assistant...");

    const client = await buildHederaClient();
    logSuccess("✅ Hedera network connection established");

    const agentExecutor = await buildAgentExecutor(client);
    logSuccess("✅ YieldCraft AI initialized with full DeFi capabilities");

    await interactiveLoop(agentExecutor);
  } catch (err: any) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("💥 Fatal startup error:", errorMessage);

    if ((err as AnyObject).inner) {
      logDebug("Additional startup error details", (err as AnyObject).inner);
    }

    process.exit(1);
  }
}

// Enhanced process management
process.on("SIGINT", () => {
  logger.info("\n👋 YieldCraft AI shutting down gracefully...");
  logger.info("🎯 Your DeFi operations remain safe on Hedera network");
  logger.info("💫 Thank you for using YieldCraft AI!");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("\n🛑 YieldCraft AI process terminated");
  process.exit(0);
});

process.on("uncaughtException", (error: Error) => {
  logError("💥 Critical system error", {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  });
  console.error("\n💥 Critical error occurred. Please restart YieldCraft AI.");
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logError("💥 Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    promise: String(promise),
    timestamp: new Date().toISOString(),
  });
});

main().catch((error) => {
  console.error("💥 Fatal initialization error:", error?.message ?? error);
  console.error("🔧 Please check your configuration and try again.");
  process.exit(1);
});
