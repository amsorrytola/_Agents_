// my-custom-plugin/index.ts
import { Context, Plugin } from "hedera-agent-kit";
import getAllTokenBalancesTool, {GET_ALL_TOKEN_BALANCES}  from "./tools/account-query/get-all-token-balance-agent";


export const accountQueryPlugin: Plugin = {
  name: "account-query-plugin",
  version: "1.0.0",
  description: "Account query operations on All network",
  tools: (context: Context) => [
    getAllTokenBalancesTool(context),
  ],
};

export const accountQueryPluginToolNames = {
    GET_ALL_TOKEN_BALANCES
} as const;


export default { accountQueryPlugin, accountQueryPluginToolNames };
