// Creates a few example strategies on the WETH/USDC pool with the app's own encoder (createParams), in tight ranges so
// that real ETH moves (Chainlink, which scripts/arb.ts keeps the pools on) trigger them within hours. Watch them with
//   npx tsx scripts/arb.ts --keep          (arbitrage + keeper every minute, on your machine)
// and in the app under Pool (or /pool?as=<this account>).
//
//   PRIVATE_KEY=0x... RPC_URL=https://... npx tsx scripts/demo-orders.ts
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { CHAIN, rpcUrl } from "../lib/chain";
import { withHeadroom } from "../lib/gas";
import { conditionalOrdersAbi, rulesAbi } from "../lib/generated/abis";
import { CORE, POOLS, amountsFor, liquidityFor, priceAtTick, rangeAround, sqrtFromX96 } from "../lib/pools";
import { type Rules, createParams, describeLane, emptyLane, isValid, allErrors, validate } from "../lib/rules";

const RPC = process.env.RPC_URL ?? rpcUrl();
const KEY = (process.env.PRIVATE_KEY ?? "") as string;
if (!KEY) throw new Error("set PRIVATE_KEY");
const account = privateKeyToAccount((KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex, { nonceManager });
const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const pool = POOLS.find((p) => p.name === "WETH_USDC_3000")!;
const stable = POOLS.find((p) => p.name === "USDC_USDT_100")!;
const move = (trigger: Rules["down"]["trigger"]) => ({ trigger, actions: [{ kind: "move" as const }], repeat: true });

// ONLY=<words>: create just the examples whose name contains them
const ONLY = process.env.ONLY;

async function create(name: string, rules: Rules, pct: number) {
  if (ONLY && !name.includes(ONLY)) return;
  const [sqrtX96, t] = await client.readContract({ address: CORE.rules, abi: rulesAbi, functionName: "poolState", args: [pool.index] });
  const range = rangeAround(pool, Number(t), pct);
  const v = validate(pool, rules, range);
  if (!isValid(v)) throw new Error(`${name}: ${allErrors(v)[0]}`);
  const sp = sqrtFromX96(sqrtX96);
  const L = liquidityFor(sp, range[0], range[1], 1 * 10 ** pool.base.decimals, pool.base.address === pool.token0.address); // about 1 WETH
  const [a0, a1] = amountsFor(sp, range[0], range[1], L);
  const params = createParams(pool, range, { liquidity: BigInt(Math.floor(L * 0.999)), amount0Max: BigInt(Math.ceil(a0 * 1.05)) + 1n, amount1Max: BigInt(Math.ceil(a1 * 1.05)) + 1n }, { keeperFeeBps: 10, slippagePct: 2, expiryDays: 30 }, rules);
  const req = { address: CORE.conditionalOrders, abi: conditionalOrdersAbi, functionName: "createOrder", args: [params], account } as const;
  const gas = await client.estimateContractGas(req);
  const hash = await wallet.writeContract({ ...req, gas: withHeadroom(gas) });
  const rc = await client.waitForTransactionReceipt({ hash });
  const created = parseEventLogs({ abi: conditionalOrdersAbi, logs: rc.logs, eventName: "OrderCreated" })[0];
  const id = created?.args.orderId;
  const [lo, hi] = [priceAtTick(pool, range[0]), priceAtTick(pool, range[1])].sort((a, b) => a - b);
  console.log(`#${id} ${name}: ${lo.toFixed(2)}-${hi.toFixed(2)} ${pool.quote.symbol}`);
  for (const lane of ["down", "up"] as const) {
    const d = describeLane(pool, lane, rules[lane], rules.plan);
    if (d) console.log(`    ${d}`);
  }
}

async function main() {
  console.log(`creating example strategies as ${account.address}`);
  await create(
    "move into USDT/USDC while below the range",
    {
      down: { trigger: { kind: "leave" }, actions: [{ kind: "move" }], repeat: false },
      up: emptyLane(),
      plan: { where: "park", parkPool: stable.index, parkWidthPct: 0.2, returnTo: "same", back: { down: emptyLane(), up: move({ kind: "price", backIn: true, bufferPct: 0.5 }) } },
    },
    1,
  );
  await create(
    "hold USDC above the range, come back centred on a 1% turn",
    {
      down: emptyLane(),
      up: { trigger: { kind: "leave" }, actions: [{ kind: "move", to: "quote" }], repeat: false },
      plan: { where: "wait", returnTo: "recentre", back: { down: move({ kind: "trail", trailPct: 1 }), up: emptyLane() } },
    },
    1,
  );
  await create(
    "stop loss confirmed for 15 minutes",
    { down: { trigger: { kind: "leave" }, actions: [{ kind: "withdraw", pct: 100 }, { kind: "convert", to: "quote" }], repeat: false, holdMinutes: 15 }, up: emptyLane() },
    1,
  );
  // runs within minutes whatever the market does: shows the keeper end to end
  await create(
    "send the fees out every 2 minutes, 3 times",
    { down: emptyLane(), up: { trigger: { kind: "timer", hours: 2 / 60 }, actions: [{ kind: "collect" }], repeat: true, maxRuns: 3 } },
    1,
  );

  await create(
    "leave if USDC loses its peg (own condition contract)",
    { down: { trigger: { kind: "card", contract: CORE.usdcDepegCard }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false }, up: emptyLane() },
    3,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
