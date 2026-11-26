// Which testnet the app (or a script) works on. Everything chain-specific (addresses, pools, RPCs, the explorer)
// comes from here, so the rest of the app reads one chain's deployment as if it were the only one.
//
// In the browser the choice is remembered (localStorage) and changing it reloads the page; when the wallet is on
// another supported network, the app follows the wallet (Header). Scripts choose with CHAIN=unichain or
// CHAIN=sepolia. NEXT_PUBLIC_DEFAULT_CHAIN sets the default (Sepolia).
import { type Chain } from "viem";
import { sepolia, unichainSepolia } from "viem/chains";
import all from "./generated/deployment.json";

export type ChainId = 11155111 | 1301;
export const CHAINS: Record<ChainId, { chain: Chain; label: string; short: string }> = {
  11155111: { chain: sepolia, label: "Ethereum Sepolia", short: "Sepolia" },
  1301: { chain: unichainSepolia, label: "Unichain Sepolia", short: "Unichain" },
};
const DEPLOYED = all.chains as unknown as Record<string, Deployment>;
export const SUPPORTED = (Object.keys(CHAINS).map(Number) as ChainId[]).filter((id) => DEPLOYED[id]);

type Deployment = { chainId: number; name: string; core: Record<string, string | number>; tokens: Record<string, string>; pools: Record<string, unknown> };

const KEY = "alucard.chain";
const parse = (v?: string | null): ChainId | undefined => {
  if (!v) return undefined;
  const s = v.toLowerCase();
  const id = s.startsWith("uni") ? 1301 : s.startsWith("sep") || s === "ethereum" ? 11155111 : Number(s);
  return SUPPORTED.includes(id as ChainId) ? (id as ChainId) : undefined;
};

/** The default, the same on the server and in the browser (so the first render matches). */
export const DEFAULT_CHAIN: ChainId = parse(process.env.NEXT_PUBLIC_DEFAULT_CHAIN) ?? 11155111;

function pick(): ChainId {
  if (typeof window === "undefined") return parse(process.env.CHAIN) ?? DEFAULT_CHAIN;
  try {
    return parse(window.localStorage.getItem(KEY)) ?? DEFAULT_CHAIN;
  } catch {
    return DEFAULT_CHAIN;
  }
}

export const CHAIN_ID: ChainId = pick();
export const CHAIN = CHAINS[CHAIN_ID].chain;
export const CHAIN_LABEL = CHAINS[CHAIN_ID].label;
export const DEPLOYMENT = DEPLOYED[CHAIN_ID];
export const EXPLORER = CHAIN.blockExplorers?.default.url ?? "https://sepolia.etherscan.io";
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;

/** Switch the app to another chain: remembered, then the page reloads with that chain's deployment. */
export function setChain(id: ChainId) {
  if (id === CHAIN_ID) return;
  try {
    window.localStorage.setItem(KEY, String(id));
  } catch {
    // private mode: the switch lasts for this page only
  }
  window.location.reload();
}

/** The app's RPC for a chain. Unichain defaults to the same Alchemy key as Sepolia (Alchemy serves both). */
export function rpcUrl(id: ChainId = CHAIN_ID): string {
  const env = typeof window === "undefined" ? process.env.RPC_URL ?? process.env.SEPOLIA_RPC : undefined;
  const sepoliaRpc = process.env.NEXT_PUBLIC_RPC_URL ?? env;
  if (id === 1301) {
    if (process.env.NEXT_PUBLIC_UNICHAIN_RPC_URL) return process.env.NEXT_PUBLIC_UNICHAIN_RPC_URL;
    if (typeof window === "undefined" && process.env.UNICHAIN_RPC_URL) return process.env.UNICHAIN_RPC_URL;
    if (sepoliaRpc?.includes("eth-sepolia.g.alchemy.com")) return sepoliaRpc.replace("eth-sepolia", "unichain-sepolia");
    return "https://sepolia.unichain.org";
  }
  return sepoliaRpc ?? "https://ethereum-sepolia-rpc.publicnode.com";
}

/** A node for wide eth_getLogs ranges (free Alchemy keys answer 10 blocks), and how many blocks it takes at once. */
export function logsRpc(id: ChainId = CHAIN_ID): { url: string; chunk: bigint } {
  if (id === 1301) return { url: process.env.NEXT_PUBLIC_UNICHAIN_LOGS_RPC_URL ?? "https://sepolia.unichain.org", chunk: 50_000n };
  return { url: process.env.NEXT_PUBLIC_LOGS_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com", chunk: 50_000n };
}
