// Encodes every template (and more cases, moves into another pool included) on every hook pool with the frontend code and dry-runs
// createOrder (eth_call, nothing is sent). Also checks that decoding what would be stored and encoding it again gives
// the same words.
//   npx tsx scripts/check-rules.ts                      Sepolia, as the deployer (holds test tokens, has approved)
//   RPC_URL=http://127.0.0.1:8546 PRIVATE_KEY=0x… npx tsx scripts/check-rules.ts   a local fork: approves first
import { createPublicClient, createWalletClient, http, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { conditionalOrdersAbi, rulesAbi, testTokenAbi } from "../lib/generated/abis";
import { CORE, POOLS, TOKENS, amountsFor, liquidityFor, priceAtTick, rangeAround, sqrtFromX96 } from "../lib/pools";
import {
  TEMPLATES,
  type ChainPlan,
  type Lane,
  type Rules,
  allErrors,
  createParams,
  decodeStrategy,
  encodeRules,
  isValid,
  parkable,
  validate,
  watchable,
} from "../lib/rules";

const RPC = process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(RPC);
const KEY = process.env.PRIVATE_KEY as Hex | undefined;
const account = LOCAL && KEY ? privateKeyToAccount((KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex) : undefined;
const FROM = account?.address ?? "0x02847D22C33f5F060Bd27e69F1a413AD44cab213";
const client = createPublicClient({ chain: sepolia, transport: http(RPC) });
const c = { address: CORE.conditionalOrders, abi: conditionalOrdersAbi } as const;
const r = { address: CORE.rules, abi: rulesAbi } as const;

const off = (): Lane => ({ trigger: null, actions: [], repeat: false });
const move = (trigger: Lane["trigger"]): Lane => ({ trigger, actions: [{ kind: "move" }], repeat: true });

async function approveAll() {
  if (!account) return;
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
  for (const t of TOKENS.filter((x) => !x.native)) {
    const hash = await wallet.writeContract({ address: t.address, abi: testTokenAbi, functionName: "approve", args: [CORE.conditionalOrders, maxUint256] });
    await client.waitForTransactionReceipt({ hash });
  }
}

async function main() {
  await approveAll();
  let ok = 0;
  let bad = 0;
  let skipped = 0;
  for (const pool of POOLS.filter((p) => p.hooked)) {
    const [sqrtX96, tickB] = await client.readContract({ ...r, functionName: "poolState", args: [pool.index] });
    const tick = Number(tickB);
    const sp = sqrtFromX96(sqrtX96);
    const price = priceAtTick(pool, tick);
    const range = rangeAround(pool, tick, 5);
    const [tl, tu] = range;
    const usd = pool.base.symbol === "ETH" ? 0.001 : 1; // a small position
    const L = liquidityFor(sp, tl, tu, usd * 10 ** pool.base.decimals, pool.base.address === pool.token0.address);
    const [a0, a1] = amountsFor(sp, tl, tu, L);
    const other = watchable(pool)[0];
    const park = parkable(pool)[0];
    const low = Math.min(priceAtTick(pool, tl), priceAtTick(pool, tu));
    const extra: [string, Rules][] = [
      ["collect fees only", { down: off(), up: { trigger: { kind: "timer", hours: 6 }, actions: [{ kind: "collect" }], repeat: true } }],
      ["price ladder", { down: off(), up: { trigger: { kind: "price", price: price * 1.03 }, actions: [{ kind: "withdraw", pct: 25 }], repeat: true, stepPct: 3 } }],
      ["leave AND 6h since last run", { down: { trigger: { kind: "leave", bufferPct: 1 }, trigger2: { kind: "timer", hours: 6 }, combine: "and", actions: [{ kind: "withdraw", pct: 100 }], repeat: false }, up: off() }],
      ["price OR daily, 3 runs", { down: off(), up: { trigger: { kind: "price", price: price * 1.03 }, trigger2: { kind: "timer", hours: 24 }, combine: "or", actions: [{ kind: "withdraw", pct: 20 }], repeat: true, stepPct: 3, maxRuns: 3 } }],
      ["trail AND 1h, averaged 15 min", { down: off(), up: { trigger: { kind: "trail", trailPct: 4 }, trigger2: { kind: "timer", hours: 1 }, combine: "and", actions: [{ kind: "withdraw", pct: 100 }], repeat: false, holdMinutes: 15 } }],
      ["stop, converts, held 30 min", { down: { trigger: { kind: "price", price: price * 0.95 }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false, holdMinutes: 30 }, up: off() }],
      ["re-centre ±3% on leaving, repeats", { down: { trigger: { kind: "leave" }, actions: [{ kind: "follow", widthPct: 3 }], repeat: true }, up: { trigger: { kind: "leave" }, actions: [{ kind: "follow", widthPct: 3 }], repeat: true } }],
      ["fees 1% then send out", { down: off(), up: { trigger: { kind: "fees", feesPct: 1 }, actions: [{ kind: "collect" }], repeat: true } }],
      ["wait in quote, back on a level, 2 runs", { down: { trigger: { kind: "leave" }, actions: [{ kind: "move", to: "quote" }], repeat: false, maxRuns: 2 }, up: off(), plan: { where: "wait", returnTo: "same", back: { down: off(), up: move({ kind: "price", price: low }) } } }],
      ["wait as is, back after 6h", { down: off(), up: { trigger: { kind: "leave" }, actions: [{ kind: "move" }], repeat: false }, plan: { where: "wait", returnTo: "recentre", back: { down: move({ kind: "timer", hours: 6 }), up: off() } } }],
    ];
    if (other) extra.push(["price in another pool", { down: { trigger: { kind: "otherPool", poolIndex: other.index, price: priceAtTick(other, 0) * 0.9 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false }, up: off() }]);
    if (park)
      extra.push(["park, trail back", { down: { trigger: { kind: "leave" }, actions: [{ kind: "move" }], repeat: false, holdMinutes: 10 }, up: off(), plan: { where: "park", parkPool: park.index, parkWidthPct: 0.3, returnTo: "recentre", back: { down: off(), up: move({ kind: "trail", trailPct: 5 }) } } }]);
    const cases: [string, Rules][] = [
      ...TEMPLATES.map((t) => [t.name, t.build(pool, price, range)] as [string, Rules | null]).filter((x): x is [string, Rules] => !!x[1]),
      ...extra,
    ];
    for (const [name, rules] of cases) {
      const v = validate(pool, rules, range);
      if (!isValid(v)) {
        skipped++;
        console.log(`  skip ${pool.label} / ${name}: ${allErrors(v)[0]}`);
        continue;
      }
      const max0 = BigInt(Math.ceil(a0 * 1.05)) + 1n;
      const max1 = BigInt(Math.ceil(a1 * 1.05)) + 1n;
      try {
        await client.simulateContract({
          ...c,
          account: FROM,
          functionName: "createOrder",
          args: [createParams(pool, range, { liquidity: BigInt(Math.floor(L * 0.999)), amount0Max: max0, amount1Max: max1 }, { keeperFeeBps: 10, slippagePct: 1, expiryDays: 30 }, rules)],
          value: pool.token0.native ? max0 : 0n,
        });
        // what the contract would store, decoded and encoded again, must be the same words
        const enc = encodeRules(pool, rules, range);
        const plan: ChainPlan | undefined = rules.plan
          ? { here: { ...enc.home, poolIndex: pool.index }, there: enc.away, thereLower: enc.awayLower, thereUpper: enc.awayUpper, held0: 0n, held1: 0n }
          : undefined;
        const back = decodeStrategy(pool, pool.index, enc.lower, enc.upper, plan).rules;
        const again = encodeRules(pool, back, range);
        const same =
          (["lower", "upper", "awayLower", "awayUpper"] as const).every((k) => again[k] === enc[k]) &&
          JSON.stringify(again.away) === JSON.stringify(enc.away) &&
          JSON.stringify(again.home) === JSON.stringify(enc.home);
        if (!same) {
          bad++;
          console.log(`  DECODE MISMATCH ${pool.label} / ${name}`);
        } else ok++;
      } catch (e) {
        bad++;
        console.log(`  REVERT ${pool.label} / ${name}: ${(e as Error).message.split("\n").slice(0, 3).join(" ")}`);
      }
    }
  }
  console.log(`\n${ok} accepted by the contract and decoded back the same, ${bad} problems, ${skipped} refused by the editor`);
  process.exit(bad ? 1 : 0);
}
main();
