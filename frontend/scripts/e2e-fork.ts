// End-to-end check on a LOCAL anvil fork of Sepolia with the contracts deployed by the fork rehearsal (DEPLOY.md):
// creates orders with the editor's own encoder (createParams), moves prices with real swaps, lets time pass so the
// hook's average price follows, runs the keeper (scripts/keeper.ts) and checks that every rule does what it says.
//
//   anvil --fork-url $SEPOLIA_RPC --port 8546
//   (deploy with OUT_DIR=./deployments/fork, then SYNC_DIR=deployments/fork npm run sync)
//   RPC_URL=http://127.0.0.1:8546 PRIVATE_KEY=0x... npx tsx scripts/e2e-fork.ts
//
// It refuses any RPC that is not on this machine, so it can never send to a real network.
import { createPublicClient, createWalletClient, http, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withHeadroom } from "../lib/gas";
import { sepolia } from "viem/chains";
import { conditionalOrdersAbi, priceFeedsAbi, routerAbi, rulesAbi, testTokenAbi } from "../lib/generated/abis";
import { CORE, POOLS, type Pool, amountsFor, liquidityFor, priceAtTick, rangeAround, sqrtFromX96 } from "../lib/pools";
import { type ChainPlan, type Lane, type Rules, createParams, describeLane, isValid, validate } from "../lib/rules";
import { LEG, decodeSide } from "../lib/side";
import { keep } from "./keeper";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC)) throw new Error(`local fork only, got ${RPC}`);
const KEY = (process.env.PRIVATE_KEY ?? "") as Hex;
if (!KEY) throw new Error("PRIVATE_KEY not set");

const account = privateKeyToAccount((KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex);
const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
const c = { address: CORE.conditionalOrders, abi: conditionalOrdersAbi } as const;
const r = { address: CORE.rules, abi: rulesAbi } as const;
const pool = POOLS.find((p) => p.name === "WETH_USDC_3000")!;
const stable = POOLS.find((p) => p.name === "USDC_USDT_100")!;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

async function send(req: Parameters<typeof wallet.writeContract>[0]) {
  // the hook writes a price snapshot in the first swap of each minute: an estimate made a moment earlier can be short
  const gas = await client.estimateContractGas({ ...(req as object), account } as never);
  const hash = await wallet.writeContract({ ...req, gas: withHeadroom(gas) } as never);
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`reverted: ${req.functionName}`);
  return rc;
}
const now = async () => Number((await client.getBlock()).timestamp);
const tickOf = async (p: Pool) => Number((await client.readContract({ ...r, functionName: "poolState", args: [p.index] }))[1]);
const price = async (p: Pool) => priceAtTick(p, await tickOf(p));
const getOrder = (id: bigint) => client.readContract({ ...c, functionName: "getOrder", args: [id] });
const open = async (id: bigint) => (await getOrder(id)).owner !== "0x0000000000000000000000000000000000000000";
const plan = async (id: bigint) => (await client.readContract({ ...c, functionName: "getPlan", args: [id] })) as unknown as ChainPlan;
const warp = async (s: number) => {
  await client.request({ method: "evm_increaseTime" as never, params: [s] as never });
  await client.request({ method: "evm_mine" as never, params: [] as never });
};

async function swap(p: Pool, zeroForOne: boolean, amount: bigint) {
  await send({
    address: CORE.swapRouter,
    abi: routerAbi,
    functionName: "swapExactTokensForTokens",
    args: [amount, 0n, zeroForOne, p.key, "0x", account.address, BigInt((await now()) + 600)],
  });
}

/** Let the price of the moment become the average: a minute, a dust swap (a snapshot), then the window. */
async function settle(...ps: Pool[]) {
  await warp(61);
  for (const p of ps) await swap(p, true, 1000n);
  await warp(121);
}

/** Swap until the base price is past `target` (in quote per base). */
async function moveTo(target: number) {
  const up = target > (await price(pool));
  const tokIn = up ? pool.quote : pool.base; // buying base raises its price
  let chunk = up ? 2_000n * 10n ** BigInt(pool.quote.decimals) : 1n * 10n ** BigInt(pool.base.decimals);
  for (let i = 0; i < 300; i++) {
    const p = await price(pool);
    if (up ? p >= target : p <= target) return p;
    await swap(pool, tokIn.address === pool.token0.address, chunk);
    const after = await price(pool);
    if (Math.abs(after / p - 1) < 0.003) chunk *= 2n; // too small a step: speed up
  }
  throw new Error("could not move the price");
}

const keeper = async () => {
  const lines: string[] = [];
  await keep(RPC, KEY, false, (l: string) => {
    lines.push(l);
    console.log(`        keeper: ${l}`);
  });
  return lines.join("\n");
};

async function createOrder(rules: Rules, pct = 5): Promise<{ id: bigint; range: [number, number] }> {
  const [sqrtX96, t] = await client.readContract({ ...r, functionName: "poolState", args: [pool.index] });
  const range = rangeAround(pool, Number(t), pct);
  const v = validate(pool, rules, range);
  if (!isValid(v)) throw new Error(`editor refuses: ${JSON.stringify(v)}`);
  const sp = sqrtFromX96(sqrtX96);
  const L = liquidityFor(sp, range[0], range[1], 0.5 * 10 ** pool.base.decimals, pool.base.address === pool.token0.address);
  const [a0, a1] = amountsFor(sp, range[0], range[1], L);
  const id = await client.readContract({ ...c, functionName: "nextOrderId" });
  await send({
    ...c,
    functionName: "createOrder",
    args: [createParams(pool, range, { liquidity: BigInt(Math.floor(L * 0.999)), amount0Max: BigInt(Math.ceil(a0 * 1.05)) + 1n, amount1Max: BigInt(Math.ceil(a1 * 1.05)) + 1n }, { keeperFeeBps: 10, slippagePct: 5, expiryDays: 7 }, rules)],
  });
  for (const lane of ["down", "up"] as const) {
    const d = describeLane(pool, lane, rules[lane], rules.plan);
    if (d) console.log(`  #${id}: ${d}`);
  }
  return { id, range };
}

const off = (): Lane => ({ trigger: null, actions: [], repeat: false });

async function main() {
  console.log(`fork ${RPC}, ConditionalOrders ${CORE.conditionalOrders}, pool ${pool.label}`);
  for (const t of [pool.token0, pool.token1, stable.token0, stable.token1]) {
    await send({ address: t.address, abi: testTokenAbi, functionName: "mint", args: [account.address, 10n ** BigInt(t.decimals + 9)] });
    await send({ address: t.address, abi: testTokenAbi, functionName: "approve", args: [CORE.swapRouter, maxUint256] });
    await send({ address: t.address, abi: testTokenAbi, functionName: "approve", args: [CORE.conditionalOrders, maxUint256] });
  }
  await settle(pool, stable);
  const p0 = await price(pool);
  console.log(`price now ${p0.toFixed(2)} ${pool.quote.symbol}`);

  // ------------------------------------------------------------ 1. nobody can fire a rule with a quick push
  console.log("\n1. a stop loss, and a push in the same block");
  const stop = await createOrder({ down: { trigger: { kind: "leave" }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false }, up: off() });
  await warp(180);
  await moveTo(p0 * 0.9);
  const pushed = await client.readContract({ ...r, functionName: "canExecute", args: [CORE.conditionalOrders, stop.id, (pool.baseIs0 ? "lower" : "upper") === "upper"] });
  check(!pushed, "right after a 10% push the average has not moved: the stop cannot run");
  await moveTo(p0); // the attacker swaps back
  await settle(pool);
  await keeper();
  check(await open(stop.id), "the stop is still open after the push and the swap back");

  // ------------------------------------------------------------ 2. trailing stop and an averaged take profit
  console.log("\n2. a trailing stop and a take profit averaged over 5 minutes");
  const trail = await createOrder({ down: { trigger: { kind: "trail", trailPct: 2 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false }, up: off() });
  // a ±5% range and a push to +7%: three minutes later the 5-minute average is still inside, five more and it is out
  const tp = await createOrder({ down: off(), up: { trigger: { kind: "leave" }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false, holdMinutes: 5 } }, 5);
  await moveTo(p0 * 1.07);
  await settle(pool);
  const out2 = await keeper();
  check(/to poke/.test(out2) && !/0 to poke/.test(out2), "the keeper moves the trailing stop's high");
  check(await open(tp.id), "the take profit waits: the 5-minute average is not above the range yet");
  await warp(300);
  await swap(pool, true, 1000n);
  await warp(61);
  await keeper();
  check(!(await open(tp.id)), "the take profit ran once the average over 5 minutes was above the range");
  check(await open(trail.id), "the trailing stop is still open (no drop yet)");
  await moveTo((await price(pool)) * 0.97);
  await settle(pool);
  await keeper();
  check(!(await open(trail.id)), "the trailing stop ran after a 3% drop from the high");

  // ------------------------------------------------------------ 3. park in USDC/USDT and come back
  console.log("\n3. park in the stable pool below the range, come back when the price is back");
  const pBase = await price(pool);
  const [sq, tk] = await client.readContract({ ...r, functionName: "poolState", args: [pool.index] });
  void sq;
  const preview = rangeAround(pool, Number(tk), 4);
  const lowEdge = Math.min(priceAtTick(pool, preview[0]), priceAtTick(pool, preview[1]));
  const park = await createOrder(
    {
      down: { trigger: { kind: "leave" }, actions: [{ kind: "move" }], repeat: false },
      up: off(),
      plan: { where: "park", parkPool: stable.index, parkWidthPct: 0.2, returnTo: "same", back: { down: off(), up: { trigger: { kind: "price", price: lowEdge }, actions: [{ kind: "move" }], repeat: true } } },
    },
    4,
  );
  await warp(180);
  await moveTo(pBase * 0.93);
  await settle(pool, stable);
  await keeper();
  let o = await getOrder(park.id);
  let pl = await plan(park.id);
  check(Number(o.poolIndex) === stable.index, `parked: the order now lives in ${stable.label}`);
  check(pl.here.kind === LEG.CENTERED && Number(pl.there.poolIndex) === pool.index, "the plan keeps the way back to the WETH range");
  const [s0, s1] = await client.readContract({ ...r, functionName: "orderAmounts", args: [CORE.conditionalOrders, park.id] });
  check(s0 > 0n && s1 > 0n, `both stablecoins in the parking range (${Number(s0) / 1e6} / ${Number(s1) / 1e6})`);
  await moveTo(pBase * 1.0);
  await settle(pool, stable);
  await keeper();
  o = await getOrder(park.id);
  pl = await plan(park.id);
  check(Number(o.poolIndex) === pool.index, "came back into the WETH / USDC pool");
  check(decodeSide(o.lowerState).edge === park.range[0] && decodeSide(o.upperState).edge === park.range[1], "into the same range as before");
  check(pl.there.poolIndex === stable.index, "plan B is ready for next time");

  // ------------------------------------------------------------ 4. wait, re-enter centred
  console.log("\n4. exit and wait in USDC, re-enter centred after a 3% rebound");
  const wait = await createOrder({
    down: { trigger: { kind: "leave" }, actions: [{ kind: "move", to: "quote" }], repeat: false },
    up: off(),
    plan: { where: "wait", returnTo: "recentre", back: { down: off(), up: { trigger: { kind: "trail", trailPct: 3 }, actions: [{ kind: "move" }], repeat: true } } },
  });
  await warp(180);
  const p4 = await price(pool);
  await moveTo(p4 * 0.92);
  await settle(pool);
  await keeper();
  pl = await plan(wait.id);
  check(pl.here.kind === LEG.IDLE, "waiting: the tokens are held for the order");
  check(pl.held1 > 0n || pl.held0 > 0n, "held as claims in the PoolManager");
  await moveTo((await price(pool)) * 1.05);
  await settle(pool);
  await keeper(); // pokes / runs
  await keeper();
  pl = await plan(wait.id);
  check(pl.here.kind === LEG.CENTERED, "re-entered a range centred on the price");

  // ------------------------------------------------------------ 5. Chainlink, timer, and a batch
  console.log("\n5. Chainlink and timer orders run together in one batch");
  const feeds = CORE.priceFeeds;
  const [okTick, linkTick] = await client.readContract({ address: feeds, abi: priceFeedsAbi, functionName: "pairTick", args: [pool.token0.address, pool.token1.address] });
  check(okTick, "Chainlink gives a fresh price for the pair");
  const link = priceAtTick(pool, Number(linkTick));
  const linkNow = await createOrder({ down: off(), up: { trigger: { kind: "oracle", price: link * 0.97 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } });
  const linkFar = await createOrder({ down: off(), up: { trigger: { kind: "oracle", price: link * 1.3 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } });
  const timed = await createOrder({ down: off(), up: { trigger: { kind: "timer", hours: 1 / 60 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } });
  await warp(180);
  const out5 = await keeper();
  check(/batch of 2/.test(out5), "the keeper sends the two ready orders as one batch");
  check(!(await open(linkNow.id)), "the Chainlink order ran");
  check(!(await open(timed.id)), "the timed order ran in the same batch");
  check(await open(linkFar.id), "the Chainlink order with a far level did not run");

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
