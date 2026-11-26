// Arbitrage bot for the test pools: keeps every pool's price on its Chainlink price, the way arbitrageurs keep real
// pools on the market. On a testnet nobody else does it, and a strategy step only runs while its pool is within the
// list's band of Chainlink (Rules.checkPrice), so this is what lets strategies react to real market moves.
//
//   PRIVATE_KEY=0x... RPC_URL=https://... npx tsx scripts/arb.ts              every 60 s, until stopped
//   ... npx tsx scripts/arb.ts --once                                         one round
//   ... npx tsx scripts/arb.ts --keep                                         and run the keeper after each round
//   ... --every 30 --within 5                                                 seconds between rounds, ticks of slack
//
// Each round, for each pool: read its price and the pair's Chainlink price (both as ticks); if they are further apart
// than `--within` ticks, swap toward Chainlink with an amount computed from the pool's active liquidity, and repeat
// (a swap that crosses ticks meets different liquidity) until it is close. Runs on your machine with your key; it
// spends test tokens and Sepolia gas only.
import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAIN, rpcUrl } from "../lib/chain";
import { withHeadroom } from "../lib/gas";
import { priceFeedsAbi, routerAbi, rulesAbi } from "../lib/generated/abis";
import { CORE, POOLS, type Pool, priceAtTick } from "../lib/pools";
import { keep } from "./keeper";

const RPC = process.env.RPC_URL ?? rpcUrl();
const KEY = (process.env.ARB_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? "") as string;
if (!KEY) throw new Error("set PRIVATE_KEY (or ARB_PRIVATE_KEY): the account that trades");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const ONCE = flag("--once");
const KEEP = flag("--keep");
const EVERY = opt("--every", 60);
const WITHIN = opt("--within", 5);

const account = privateKeyToAccount((KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex, { nonceManager });
const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const Q96 = 2 ** 96;
const approved = new Set<string>();

async function send(req: Parameters<typeof wallet.writeContract>[0]) {
  const gas = await client.estimateContractGas({ ...(req as object), account } as never);
  const hash = await wallet.writeContract({ ...req, gas: withHeadroom(gas) } as never);
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`reverted: ${hash}`);
}

async function approve(token: `0x${string}`) {
  if (approved.has(token)) return;
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, CORE.swapRouter] });
  if (allowance < maxUint256 / 2n) await send({ address: token, abi: erc20Abi, functionName: "approve", args: [CORE.swapRouter, maxUint256] } as never);
  approved.add(token);
}

/** Pool and Chainlink ticks; null when the pool is empty or Chainlink has no fresh price. */
async function ticks(p: Pool) {
  const [sqrtX96, tick, liquidity] = await client.readContract({ address: CORE.rules, abi: rulesAbi, functionName: "poolState", args: [p.index] });
  const [ok, link] = await client.readContract({ address: CORE.priceFeeds, abi: priceFeedsAbi, functionName: "pairTick", args: [p.key.currency0, p.key.currency1] });
  if (!ok || liquidity === 0n) return null;
  return { sp: Number(sqrtX96) / Q96, tick: Number(tick), link: Number(link), L: Number(liquidity) };
}

/** Bring one pool to within WITHIN ticks of Chainlink. Returns a line for the log. */
export async function arbitrage(p: Pool): Promise<string> {
  let t = await ticks(p);
  if (!t) return `${p.label}: no Chainlink price or no liquidity, skipped`;
  const from = t.tick;
  for (let i = 0; i < 8 && Math.abs(t.link - t.tick) > WITHIN; i++) {
    const target = Math.pow(1.0001, t.link / 2);
    const down = target < t.sp; // the pool is above Chainlink: sell token0
    // input that moves the price to the target at this liquidity, gross of the fee
    const raw = down ? t.L * (1 / target - 1 / t.sp) : t.L * (target - t.sp);
    const amountIn = BigInt(Math.max(1, Math.ceil(raw / (1 - p.key.fee / 1e6))));
    const tokIn = down ? p.token0 : p.token1;
    if (!tokIn.native) await approve(tokIn.address);
    await send({
      address: CORE.swapRouter,
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, 0n, down, p.key, "0x", account.address, (await client.getBlock()).timestamp + 600n], // chain time (a fork may be ahead)
      value: tokIn.native ? amountIn : 0n,
    } as never);
    const after = await ticks(p);
    if (!after) break;
    t = after;
  }
  const off = t.link - t.tick;
  const price = (x: number) => priceAtTick(p, x).toPrecision(6);
  if (from === t.tick) return `${p.label}: ${price(t.tick)} ${p.quote.symbol}, on Chainlink (${off >= 0 ? "+" : ""}${off} ticks)`;
  return `${p.label}: ${price(from)} -> ${price(t.tick)} ${p.quote.symbol} (Chainlink ${price(t.link)}, ${off >= 0 ? "+" : ""}${off} ticks)`;
}

async function round() {
  console.log(`\n${new Date().toISOString()}`);
  for (const p of POOLS) {
    try {
      console.log(`  ${await arbitrage(p)}`);
    } catch (e) {
      console.log(`  ${p.label}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (KEEP) await keep(RPC, KEY, false, (l: string) => console.log(`  keeper: ${l}`));
}

async function main() {
  console.log(`arbitrage as ${account.address} on ${RPC.replace(/\/v2\/.*/, "/v2/…")}`);
  for (;;) {
    await round();
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, EVERY * 1000));
  }
}

if (process.argv[1]?.endsWith("arb.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
