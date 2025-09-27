// my-custom-plugin/index.ts
import { Context, Plugin } from "hedera-agent-kit";
import getAllTokenBalancesTool, {
  GET_ALL_TOKEN_BALANCES,
} from "./tools/account-query/get-all-token-balance-agent";
import bestStrategyTool, {
  BEST_STRATEGY_TOOL,
} from "./tools/best-strategy-agent/best-strategy-plugin";
import executeSwapOrderTool, {
  EXECUTE_SWAP_ORDER,
} from "./tools/auto-swap-agent/execute-swap-order";
import monitorOrdersTool, {
  MONITOR_ORDERS,
} from "./tools/auto-swap-agent/monitor-orders";
import getOrderDetailsTool, {
  GET_ORDER_DETAILS,
} from "./tools/auto-swap-agent/get-order-details";
import createSwapOrderTool, {
  CREATE_SWAP_ORDER,
} from "./tools/auto-swap-agent/create-swap-order";

export const autoSwapAgentPlugin: Plugin = {
  name: "auto-swap-agent-plugin",
  version: "1.0.0",
  description: "Automated swap order management on Autoswap DEX",
  tools: (context: Context) => [
    createSwapOrderTool(context),
    getOrderDetailsTool(context),
    monitorOrdersTool(context),
    executeSwapOrderTool(context),
  ],
};
export const autoSwapAgentPluginToolNames = {
  CREATE_SWAP_ORDER,
  GET_ORDER_DETAILS,
  MONITOR_ORDERS,
  EXECUTE_SWAP_ORDER,
} as const;

export const bestStrategyPlugin: Plugin = {
  name: "best-strategy-plugin",
  version: "1.0.0",
  description:
    "Tool to determine the best strategy for staking HBAR based on APY from various platforms",
  tools: (context: Context) => [bestStrategyTool(context)],
};
export const bestStrategyPluginToolNames = {
  BEST_STRATEGY_TOOL,
} as const;

export const accountQueryPlugin: Plugin = {
  name: "account-query-plugin",
  version: "1.0.0",
  description: "Account query operations on All network",
  tools: (context: Context) => [getAllTokenBalancesTool(context)],
};
export const accountQueryPluginToolNames = {
  GET_ALL_TOKEN_BALANCES,
} as const;

export default {
  accountQueryPlugin,
  accountQueryPluginToolNames,
  bestStrategyPlugin,
  bestStrategyPluginToolNames,
  autoSwapAgentPlugin,
  autoSwapAgentPluginToolNames,
};
