// End-to-end check on a LOCAL anvil fork of Sepolia, with a newly deployed ConditionalOrders (see DEPLOY.md):
// creates orders with the editor's own encoder, moves the price with real swaps, runs scripts/keeper.ts and checks
// that holds get armed, trailing highs move, and both rules run when they should.
//
//   anvil --fork-url $SEPOLIA_RPC --port 8546 --code-size-limit 65536
//   RPC_URL=http://127.0.0.1:8546 PRIVATE_KEY=0x... npx tsx scripts/e2e-fork.ts
//
// It refuses any RPC that is not on this machine, so it can never send to a real network.
import { execSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { conditionalOrdersAbi, priceFeedsAbi, routerAbi, testTokenAbi } from "../lib/generated/abis";
import { CORE, POOLS, type Pool, liquidityFor, amountsFor, priceAtTick, rangeAround, sqrtFromX96 } from "../lib/pools";
import { describeLane, encodeRules, type Rules } from "../lib/rules";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC)) throw new Error(`local fork only, got ${RPC}`);
const KEY = (process.env.PRIVATE_KEY ?? "") as Hex;
if (!KEY) throw new Error("PRIVATE_KEY not set");

const account = privateKeyToAccount((KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex);
const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const c = { address: CORE.conditionalOrders, abi: conditionalOrdersAbi } as const;
const pool = POOLS.find((p) => p.name === "WETH_USDC_3000")!;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

async function send(req: Parameters<typeof wallet.writeContract>[0]) {
  const hash = await wallet.writeContract(req);
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${req.functionName}`);
  return r;
}
const now = async () => Number((await client.getBlock()).timestamp);
const tick = async (p: Pool) => Number((await client.readContract({ ...c, functionName: "poolState", args: [p.index] }))[1]);
const price = async (p: Pool) => priceAtTick(p, await tick(p));
const open = async (id: bigint) => (await client.readContract({ ...c, functionName: "getOrder", args: [id] }))[0].owner !== "0x0000000000000000000000000000000000000000";
const state = async (id: bigint) => (await client.readContract({ ...c, functionName: "getOrder", args: [id] }))[1];

/** Swap until the base price is past `target` (in quote per base). */
async function moveTo(target: number) {
  const up = target > (await price(pool));
  const tokIn = up ? pool.quote : pool.base; // buying base raises its price
  let chunk = up ? 2_000n * 10n ** BigInt(pool.quote.decimals) : 1n * 10n ** BigInt(pool.base.decimals);
  for (let i = 0; i < 300; i++) {
    const p = await price(pool);
    if (up ? p >= target : p <= target) return p;
    const before = p;
    await send({
      address: CORE.swapRouter,
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [chunk, 0n, tokIn.address === pool.token0.address, pool.key, "0x", account.address, BigInt((await now()) + 600)],
    });
    const after = await price(pool);
    if (Math.abs(after / before - 1) < 0.003) chunk *= 2n; // too small a step: speed up
  }
  throw new Error("could not move the price");
}

function keeper(): string {
  const out = execSync("npx tsx scripts/keeper.ts", { env: { ...process.env, RPC_URL: RPC, KEEPER_PRIVATE_KEY: KEY }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  console.log(out.trim().split("\n").map((l) => `        keeper: ${l}`).join("\n"));
  return out;
}

async function createOrder(rules: Rules): Promise<bigint> {
  const [sqrtX96, t] = await client.readContract({ ...c, functionName: "poolState", args: [pool.index] });
  const [tl, tu] = rangeAround(pool, Number(t), 5);
  const sp = sqrtFromX96(sqrtX96);
  const L = liquidityFor(sp, tl, tu, 0.5 * 10 ** pool.base.decimals, pool.base.address === pool.token0.address);
  const [a0, a1] = amountsFor(sp, tl, tu, L);
  const enc = encodeRules(pool, rules);
  const id = await client.readContract({ ...c, functionName: "nextOrderId" });
  await send({
    ...c,
    functionName: "createOrder",
    args: [
      {
        key: pool.key,
        tickLower: tl,
        tickUpper: tu,
        liquidity: BigInt(Math.floor(L * 0.999)),
        amount0Max: BigInt(Math.ceil(a0 * 1.05)) + 1n,
        amount1Max: BigInt(Math.ceil(a1 * 1.05)) + 1n,
        swapPoolIndex: 0,
        expiry: (await now()) + 7 * 86400,
        maxKeeperFeeBps: 10,
        maxSlippage: 50,
        lower: enc.lower,
        upper: enc.upper,
      },
    ],
  });
  for (const lane of ["down", "up"] as const) {
    const d = describeLane(pool, lane, rules[lane]);
    if (d) console.log(`  #${id}: ${d}`);
  }
  return id;
}

async function main() {
  console.log(`fork ${RPC}, ConditionalOrders ${CORE.conditionalOrders}, pool ${pool.label}`);
  // tokens: mint plenty on the fork and approve the router and the order contract
  for (const t of [pool.token0, pool.token1]) {
    await send({ address: t.address, abi: testTokenAbi, functionName: "mint", args: [account.address, 10n ** BigInt(t.decimals + 9)] });
    await send({ address: t.address, abi: testTokenAbi, functionName: "approve", args: [CORE.swapRouter, maxUint256] });
    await send({ address: t.address, abi: testTokenAbi, functionName: "approve", args: [CORE.conditionalOrders, maxUint256] });
  }
  const p0 = await price(pool);
  console.log(`price now ${p0.toFixed(2)} ${pool.quote.symbol}`);

  const off = { trigger: null, actions: [], repeat: false };
  const trail = await createOrder({
    down: { trigger: { kind: "trail", trailPct: 2 }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false },
    up: off,
  });
  const held = await createOrder({ down: off, up: { trigger: { kind: "leave", bufferPct: 0 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false, holdMinutes: 5 } });

  console.log("\n1. price rises 7%: above the hold order's range, and a new high for the trailing stop");
  await moveTo(p0 * 1.07);
  const sideOf = (lane: "down" | "up") => (lane === "up") === pool.baseIs0; // upper side?
  const bestBefore = (await state(trail))[sideOf("down") ? "upper" : "lower"].best;
  const out1 = keeper();
  check(/2 to poke/.test(out1), "keeper finds 2 pokes (arm the hold, move the high)");
  const st = await state(trail);
  const bestAfter = st[sideOf("down") ? "upper" : "lower"].best;
  check(bestAfter !== bestBefore, `trailing best tick moved (${bestBefore} -> ${bestAfter})`);
  const armed = (await state(held))[sideOf("up") ? "upper" : "lower"].armedAt;
  check(armed > 0, `hold armed at ${new Date(armed * 1000).toISOString()}`);
  check(await open(held), "hold order has not run yet");

  console.log("\n2. seven minutes later, still above the range");
  await client.request({ method: "evm_increaseTime" as never, params: [420] as never });
  await client.request({ method: "evm_mine" as never, params: [] as never });
  keeper();
  check(!(await open(held)), "hold order ran after the wait");
  check(await open(trail), "trailing stop still open (no drop yet)");

  console.log("\n3. price falls 3% from the high");
  const high = await price(pool);
  await moveTo(high * 0.97);
  keeper();
  check(!(await open(trail)), "trailing stop ran after the drop");

  console.log("\n4. Chainlink conditions and a batch");
  const feeds = await client.readContract({ ...c, functionName: "feeds" });
  for (const t of [pool.token0, pool.token1]) {
    const listed = await client.readContract({ address: feeds, abi: priceFeedsAbi, functionName: "isListed", args: [t.address] });
    check(listed, `${t.symbol} is on the token list`);
  }
  const [okTick, linkTick] = await client.readContract({ address: feeds, abi: priceFeedsAbi, functionName: "pairTick", args: [pool.token0.address, pool.token1.address] });
  check(okTick, "Chainlink gives a fresh price for the pair");
  const link = priceAtTick(pool, Number(linkTick));
  console.log(`  Chainlink ${link.toFixed(2)} ${pool.quote.symbol}, pool ${(await price(pool)).toFixed(2)} ${pool.quote.symbol}`);
  const [okPay, pay] = await client.readContract({ ...c, functionName: "keeperGasCostIn", args: [pool.quote.address, 200_000n] });
  check(okPay, `gas can be priced in ${pool.quote.symbol} (200,000 gas = ${Number(pay) / 10 ** pool.quote.decimals} ${pool.quote.symbol} at this call's gas price)`);

  // true now: Chainlink is already above a level 3% under its price. Not true: a level 30% above it.
  const linkNow = await createOrder({ down: off, up: { trigger: { kind: "oracle", price: link * 0.97 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } });
  const linkFar = await createOrder({ down: off, up: { trigger: { kind: "oracle", price: link * 1.3 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } });
  const timed = await createOrder({ down: off, up: { trigger: { kind: "timer", hours: 1 / 60 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } });
  await client.request({ method: "evm_increaseTime" as never, params: [120] as never });
  await client.request({ method: "evm_mine" as never, params: [] as never });
  const out4 = keeper();
  check(/batch of 2/.test(out4), "keeper sends the two ready orders as one batch");
  check(!(await open(linkNow)), "the Chainlink order ran");
  check(!(await open(timed)), "the timed order ran in the same batch");
  check(await open(linkFar), "the Chainlink order with a far level did not run");

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
