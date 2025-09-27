// src/index.ts
import dotenv from "dotenv";
dotenv.config();

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { Client, PrivateKey } from "@hashgraph/sdk";
import { HederaLangchainToolkit, coreQueriesPlugin } from "hedera-agent-kit";

/**
 * Return type is `any` because different langchain LLM wrappers have different types.
 * You can tighten this later if you add the provider type packages.
 */
function createLLM(): any {
  // Prefer Anthropic if API key present
  if (process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ChatAnthropic } = require("@langchain/anthropic");
    return new ChatAnthropic({
      model: process.env.CLAUDE_MODEL ?? "claude-3-haiku-20240307",
      // You may pass the API key in options depending on package; langchain wrappers often use env variables directly.
    });
  }

  // Next preference: Groq
  if (process.env.GROQ_API_KEY) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ChatGroq } = require("@langchain/groq");
    return new ChatGroq({
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    });
  }

  // If none configured, throw a helpful error
  throw new Error(
    "No LLM provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY in your .env."
  );
}

async function main(): Promise<void> {
  // create the LLM (throws if no provider)
  const llm = createLLM();

  // Validate Hedera env vars
  const hederaAccount = process.env.HEDERA_ACCOUNT_ID;
  const hederaPrivateKey = process.env.HEDERA_PRIVATE_KEY;
  if (!hederaAccount || !hederaPrivateKey) {
    throw new Error(
      "Hedera credentials missing. Set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY in your .env."
    );
  }

  // Hedera client (testnet)
  const client = Client.forTestnet().setOperator(
    hederaAccount,
    // the example uses ECDSA format — keep same call
    PrivateKey.fromStringECDSA(hederaPrivateKey)
  );

  const hederaAgentToolkit = new HederaLangchainToolkit({
    client,
    configuration: {
      plugins: [coreQueriesPlugin],
    },
  });

  // Load the structured chat prompt template
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "You are a helpful assistant"],
    ["placeholder", "{chat_history}"],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]);

  // Fetch tools from toolkit
  const tools: any[] = hederaAgentToolkit.getTools();

  // Create the underlying agent
  const agent = createToolCallingAgent({
    llm,
    tools,
    prompt,
  });

  // Wrap with an executor that will maintain memory / context
  const agentExecutor = new AgentExecutor({
    agent,
    tools,
  });

  const response = await agentExecutor.invoke({ input: "what's my balance?" });
  // `response` shape depends on the AgentExecutor implementation; print raw for debugging
  // If it's an object with `.output` or `.text`, log accordingly
  console.log("Raw response:", response);
  // If response is a LangChain `Chain` result, it may be .output or .text — print both defensively:
  // @ts-ignore
  if (response?.output) console.log("response.output:", response.output);
  // @ts-ignore
  if (response?.text) console.log("response.text:", response.text);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
