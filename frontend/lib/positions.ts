"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { positionManagerAbi } from "./abis-extra";
import { conditionalOrdersAbi, rulesAbi } from "./generated/abis";
import { CORE, type Pool, POOLS, amountsFor, poolByIndex, priceAtTick, sqrtFromX96, tokenByAddress } from "./pools";
import { type Advanced, type ChainPlan, type LaneId, type Lane, type Rules, decodeStrategy, legPools, markBackIn, slotsOf } from "./rules";
import { CHECK, LEG, decodeSide } from "./side";
import { getLogsSinceDeploy } from "./logs";
import { explain } from "./tx";

/** Where a strategy's money is now: in its position, waiting (tokens held), or parked in another pool. */
export type Status = "home" | "waiting" | "parked";

export type RulePosition = {
  kind: "rules";
  id: bigint;
  pool: Pool; // the position's own pool: its rules are written for this pool
  tickLower: number; // the position's range (the last one, while the money is moved)
  tickUpper: number;
  tick: number; // the pool's current tick
  status: Status;
  livePool: Pool; // where the money is now (the parking pool while parked)
  liveRange: [number, number] | null; // the range it is in now (null while waiting)
  liveTick: number;
  amount0: number; // human units, in livePool's tokens
  amount1: number;
  rules: Rules;
  liveIsHome: boolean;
  advanced: Advanced;
  expiry: number;
  /** For the live lanes (the position's lanes, or the ways back while the money is moved). */
  ready: Record<LaneId, boolean>;
  /** Why a side whose condition is true cannot run right now (the contract's own reason), or null. */
  blocked: Record<LaneId, string | null>;
  /** When each live side last ran (or started), unix seconds. */
  lastRun: Record<LaneId, number>;
  memo: Record<LaneId, SideMemo | null>;
};

/** What a trailing side remembers, and whether a poke would move it now. */
export type SideMemo = { trails: boolean; bestPrice: number; pokeable: boolean; holdMinutes: number };

export type PlainPosition = {
  kind: "plain";
  id: bigint; // PositionManager NFT id
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  tick: number;
  amount0: number;
  amount1: number;
};

const c = { address: CORE.conditionalOrders, abi: conditionalOrdersAbi } as const;
const r = { address: CORE.rules, abi: rulesAbi } as const;
type Client = NonNullable<ReturnType<typeof usePublicClient>>;
const ZERO = "0x0000000000000000000000000000000000000000";

/** The live leg's lanes: the position's own, or the ways back while the money is moved. */
export const liveLanes = (p: Pick<RulePosition, "rules" | "liveIsHome">): { down: Lane; up: Lane } => (p.liveIsHome ? p.rules : p.rules.plan!.back);

/** Contract side a live lane runs on (true = upper). */
export function liveSide(p: Pick<RulePosition, "rules" | "liveIsHome" | "pool">, lane: LaneId): boolean {
  if (p.liveIsHome) return slotsOf(p.pool, p.rules)[lane] === "upper";
  const { away } = legPools(p.pool, p.rules.plan);
  return slotsOf(away, p.rules.plan!.back, p.pool)[lane] === "upper";
}

/** The pool a two-leg order was created in. A waiting leg names it; a parked order needs its OrderCreated event. */
async function homePoolOf(id: bigint, livePool: number, plan: ChainPlan): Promise<number> {
  if (plan.here.kind === LEG.NONE) return livePool;
  if (plan.here.kind === LEG.IDLE) return Number(plan.here.poolIndex);
  if (plan.there.kind === LEG.IDLE) return Number(plan.there.poolIndex);
  const logs = (await getLogsSinceDeploy({
    address: CORE.conditionalOrders,
    event: conditionalOrdersAbi.find((x) => x.type === "event" && x.name === "OrderCreated")!,
    args: { orderId: id },
  })) as { args: { poolIndex: number } }[];
  return logs.length ? Number(logs[0].args.poolIndex) : livePool;
}

export async function loadRulePosition(client: Client, id: bigint): Promise<RulePosition | null> {
  const [order, rawPlan] = await Promise.all([
    client.readContract({ ...c, functionName: "getOrder", args: [id] }),
    client.readContract({ ...c, functionName: "getPlan", args: [id] }),
  ]);
  if (order.owner === ZERO) return null;
  const plan = rawPlan as unknown as ChainPlan;
  const livePool = poolByIndex(Number(order.poolIndex));
  const pool = poolByIndex(await homePoolOf(id, Number(order.poolIndex), plan));
  if (!pool || !livePool) return null;
  const decoded = decodeStrategy(pool, livePool.index, order.lowerState, order.upperState, plan);
  const liveIsHome = decoded.liveIsHome;
  const lower = decodeSide(order.lowerState);
  const upper = decodeSide(order.upperState);
  const waiting = plan.here.kind === LEG.IDLE;
  const status: Status = liveIsHome ? "home" : waiting ? "waiting" : "parked";
  // the position's range: live, or the last one it had before the money moved
  const homeLower = liveIsHome ? lower : decodeSide(plan.thereLower);
  const homeUpper = liveIsHome ? upper : decodeSide(plan.thereUpper);
  // a way back at the range's edge reads as "back in my range"
  const rules = markBackIn(pool, decoded.rules, [homeLower.edge, homeUpper.edge]);

  const [amounts, homeState, liveState, readyLower, readyUpper] = await Promise.all([
    client.readContract({ ...r, functionName: "orderAmounts", args: [CORE.conditionalOrders, id] }),
    client.readContract({ ...r, functionName: "poolState", args: [pool.index] }),
    client.readContract({ ...r, functionName: "poolState", args: [livePool.index] }),
    client.readContract({ ...r, functionName: "canExecute", args: [CORE.conditionalOrders, id, false] }),
    client.readContract({ ...r, functionName: "canExecute", args: [CORE.conditionalOrders, id, true] }),
  ]);
  const base = { rules, liveIsHome, pool };
  const lanes = liveLanes(base);
  const memoOf = async (lane: LaneId): Promise<SideMemo | null> => {
    const up = liveSide(base, lane);
    const s = up ? upper : lower;
    const trails = s.checker === CHECK.TRAIL || (s.combine !== 0 && s.checker2 === CHECK.TRAIL);
    if (!trails || !lanes[lane].trigger) return null;
    const pokeable = await client
      .simulateContract({ ...c, functionName: "poke", args: [id, up] })
      .then(() => true)
      .catch(() => false);
    const trailPool = s.checker === CHECK.TRAIL ? s.checkPool : s.checkPool2;
    return { trails, holdMinutes: s.holdMinutes, bestPrice: priceAtTick(trailPool ? poolByIndex(trailPool) ?? livePool : livePool, s.best), pokeable };
  };
  const [memoDown, memoUp] = await Promise.all([memoOf("down"), memoOf("up")]);
  const ready = (lane: LaneId) => !!lanes[lane].trigger && (liveSide(base, lane) ? readyUpper : readyLower);
  // a side whose condition is true can still be refused (the price was pushed, a swap past the limit…): say why
  const blockedOf = (lane: LaneId) =>
    ready(lane)
      ? client
          .simulateContract({ ...c, functionName: "execute", args: [id, liveSide(base, lane)] })
          .then(() => null)
          .catch((e) => explain(e))
      : Promise.resolve(null);
  const [blockedDown, blockedUp] = await Promise.all([blockedOf("down"), blockedOf("up")]);
  const runAt = (lane: LaneId) => (liveSide(base, lane) ? upper.lastRun : lower.lastRun);
  return {
    kind: "rules",
    id,
    pool,
    tickLower: homeLower.edge,
    tickUpper: homeUpper.edge,
    tick: Number(homeState[1]),
    status,
    livePool,
    liveRange: waiting ? null : [lower.edge, upper.edge],
    liveTick: Number(liveState[1]),
    amount0: Number(amounts[0]) / 10 ** livePool.token0.decimals,
    amount1: Number(amounts[1]) / 10 ** livePool.token1.decimals,
    rules,
    liveIsHome,
    advanced: {
      keeperFeeBps: Number(order.maxKeeperFeeBps),
      slippagePct: Number(order.maxSlippage) / 10,
      expiryDays: Math.max(1, Math.round((Number(order.expiry) - Date.now() / 1000) / 86400)),
    },
    expiry: Number(order.expiry),
    ready: { down: ready("down") && !blockedDown, up: ready("up") && !blockedUp },
    blocked: { down: blockedDown, up: blockedUp },
    lastRun: { down: runAt("down"), up: runAt("up") },
    memo: { down: memoDown, up: memoUp },
  };
}

/** Plain Uniswap positions in our pools that this wallet holds (found from NFT transfer logs since our deploy). */
async function loadPlain(client: Client, owner: `0x${string}`): Promise<PlainPosition[]> {
  const logs = await getLogsSinceDeploy({
    address: CORE.positionManager,
    event: positionManagerAbi.find((x) => x.type === "event" && x.name === "Transfer")!,
    args: { to: owner },
  });
  const ids = [...new Set((logs as { args: { id: bigint } }[]).map((l) => l.args.id))];
  const out: PlainPosition[] = [];
  for (const id of ids) {
    const [holder, [key, info], liq] = await Promise.all([
      client.readContract({ address: CORE.positionManager, abi: positionManagerAbi, functionName: "ownerOf", args: [id] }),
      client.readContract({ address: CORE.positionManager, abi: positionManagerAbi, functionName: "getPoolAndPositionInfo", args: [id] }),
      client.readContract({ address: CORE.positionManager, abi: positionManagerAbi, functionName: "getPositionLiquidity", args: [id] }),
    ]);
    if (holder.toLowerCase() !== owner.toLowerCase() || liq === 0n) continue;
    const pool = POOLS.find(
      (p) =>
        p.key.currency0.toLowerCase() === key.currency0.toLowerCase() &&
        p.key.currency1.toLowerCase() === key.currency1.toLowerCase() &&
        p.key.fee === key.fee &&
        p.key.hooks.toLowerCase() === key.hooks.toLowerCase(),
    );
    if (!pool) continue;
    const s24 = (x: bigint) => {
      const v = Number(x & 0xffffffn);
      return v >= 0x800000 ? v - 0x1000000 : v;
    };
    const tickLower = s24(info >> 8n);
    const tickUpper = s24(info >> 32n);
    const [sqrtX96, tick] = await client.readContract({ ...r, functionName: "poolState", args: [pool.index] });
    const [a0, a1] = amountsFor(sqrtFromX96(sqrtX96), tickLower, tickUpper, Number(liq));
    out.push({
      kind: "plain",
      id,
      pool,
      tickLower,
      tickUpper,
      tick: Number(tick),
      amount0: a0 / 10 ** pool.token0.decimals,
      amount1: a1 / 10 ** pool.token1.decimals,
    });
  }
  return out;
}

export function useMyPositions(owner?: `0x${string}`) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["positions", owner],
    enabled: !!owner && !!client,
    queryFn: async () => {
      const ids = await client!.readContract({ ...c, functionName: "ordersOf", args: [owner!] });
      const rules = (await Promise.all([...ids].reverse().map((id) => loadRulePosition(client!, id)))).filter(Boolean) as RulePosition[];
      const plain = await loadPlain(client!, owner!).catch(() => [] as PlainPosition[]);
      // payouts held for this wallet (if a transfer to it ever failed), in any token an order can hold
      const held: { symbol: string; amount: number; currency: `0x${string}` }[] = [];
      const seen = new Set<string>(rules.flatMap((x) => [x.pool.token0.address, x.pool.token1.address, x.livePool.token0.address, x.livePool.token1.address]));
      for (const a of seen) {
        const amount = await client!.readContract({ ...c, functionName: "owed", args: [owner!, a as `0x${string}`] });
        if (amount > 0n) {
          const t = tokenByAddress(a);
          held.push({ symbol: t.symbol, amount: Number(amount) / 10 ** t.decimals, currency: t.address });
        }
      }
      return { rules, plain, held };
    },
  });
}

export function useRulePosition(id: bigint) {
  const client = usePublicClient();
  return useQuery({ queryKey: ["position", String(id)], enabled: !!client, queryFn: () => loadRulePosition(client!, id) });
}
