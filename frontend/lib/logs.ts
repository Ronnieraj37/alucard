import { createPublicClient, http } from "viem";
import { CHAIN, CHAIN_ID, logsRpc } from "./chain";
import { CORE } from "./pools";

// Event logs need a node that answers wide block ranges. Free Alchemy keys allow 10 blocks per eth_getLogs, so logs go
// to their own RPC (a public node), in the chunk size that node accepts (Sepolia: 50,000 blocks; Unichain Sepolia: 1,000,
// and it makes a block every second). What has been scanned is cached in the browser per chain and query, so a later
// visit only reads the blocks since then.
const { url: LOGS_RPC, chunk: CHUNK } = logsRpc();
const PARALLEL = 6;

export const logsClient = createPublicClient({ chain: CHAIN, transport: http(LOGS_RPC, { retryCount: 2 }) });

type GetLogsArgs = Parameters<typeof logsClient.getLogs>[0];

// bigints survive JSON as {"$b": "123"}
const enc = (_: string, v: unknown) => (typeof v === "bigint" ? { $b: v.toString() } : v);
const dec = (_: string, v: unknown) => (v && typeof v === "object" && "$b" in (v as object) ? BigInt((v as { $b: string }).$b) : v);

function cacheKey(params: object) {
  return `alucard.logs.${CHAIN_ID}.${CORE.conditionalOrders}.${JSON.stringify(params, enc)}`;
}
function readCache(key: string): { to: bigint; logs: unknown[] } | null {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw, dec) as { to: bigint; logs: unknown[] }) : null;
  } catch {
    return null;
  }
}
function writeCache(key: string, to: bigint, logs: unknown[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ to, logs }, enc));
  } catch {
    // full or blocked: the next visit scans again
  }
}

/** Every matching log from our deploy block to the latest block, in chunks the node accepts, a few at a time. */
export async function getLogsSinceDeploy<T extends Omit<NonNullable<GetLogsArgs>, "fromBlock" | "toBlock" | "blockHash">>(params: T) {
  const head = await logsClient.getBlockNumber();
  const p = params as { address?: unknown; event?: { name?: string }; args?: unknown };
  const key = cacheKey({ a: p.address, e: p.event?.name, args: p.args });
  const cached = readCache(key);
  const start = cached ? cached.to + 1n : BigInt(CORE.deployBlock);
  const ranges: [bigint, bigint][] = [];
  for (let from = start; from <= head; from += CHUNK) ranges.push([from, from + CHUNK - 1n < head ? from + CHUNK - 1n : head]);
  const found: unknown[] = [];
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const part = await Promise.all(
      ranges.slice(i, i + PARALLEL).map(([fromBlock, toBlock]) => logsClient.getLogs({ ...(params as object), fromBlock, toBlock } as GetLogsArgs)),
    );
    found.push(...part.flat());
  }
  // keep only what the app reads back (args), so the cache stays small
  const slim = found.map((l) => ({ args: (l as { args?: unknown }).args }));
  const logs = [...(cached?.logs ?? []), ...slim];
  writeCache(key, head, logs);
  return logs;
}
