import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { CORE } from "./pools";

// Event logs need a node that answers wide block ranges. Free Alchemy keys allow 10 blocks per eth_getLogs, so logs
// go to their own RPC (a public node by default, 50,000 blocks per request) while everything else uses the app's RPC.
const LOGS_RPC = process.env.NEXT_PUBLIC_LOGS_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const CHUNK = 50_000n;

export const logsClient = createPublicClient({ chain: sepolia, transport: http(LOGS_RPC) });

type GetLogsArgs = Parameters<typeof logsClient.getLogs>[0];

/** Every matching log from our deploy block to the latest block, in parallel chunks the node accepts. */
export async function getLogsSinceDeploy<T extends Omit<NonNullable<GetLogsArgs>, "fromBlock" | "toBlock" | "blockHash">>(params: T) {
  const head = await logsClient.getBlockNumber();
  const parts = [];
  for (let from = BigInt(CORE.deployBlock); from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head;
    parts.push(logsClient.getLogs({ ...(params as object), fromBlock: from, toBlock: to } as GetLogsArgs));
  }
  return (await Promise.all(parts)).flat() as unknown[];
}
