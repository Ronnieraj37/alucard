// The strategy model the UI works with, and its translation to the contract.
//
// A strategy is the position's rules (two lanes: what to do if the base token falls, or rises) and, optionally, a
// move: where the money goes when a lane says "move" (into a range in another pool, or holding one token), when it
// comes back (the "come back" lanes), and into what range. The contract calls the place it moves to the second leg.
//
// The UI talks about the BASE token's price ("if WETH falls"). The contract talks about ticks of token1 per token0
// ("lower side" fires when the tick falls). When the base token is token1 the two point opposite ways, so every
// mapping below goes through `contractSide`.

import { type Pool, POOLS, pctForTicks, priceAtTick, poolByIndex, ticksForPct, tickAtPrice, fmt } from "./pools";
import { ACT, ADD_CENTERED, ADD_SAME, CHECK, COMBINE, LEG, type Leg, type Side, decodeSide, encodeSide, noLeg, offSide } from "./side";

export type { Side } from "./side";

export type LaneId = "down" | "up"; // base price falls / rises

export type TriggerKind = "leave" | "price" | "otherPool" | "chainlink" | "timer" | "trail" | "fees" | "apr" | "card";
export type Trigger = {
  kind: TriggerKind;
  bufferPct?: number; // leave: how far past the range edge
  price?: number; // price, otherPool, chainlink: base price in quote
  poolIndex?: number; // otherPool; trail, chainlink: the pool whose price it reads (unset = this one)
  hours?: number; // timer
  trailPct?: number; // trail: how far the price turns back from its best
  feesPct?: number; // fees: fees earned, in % of the position
  aprPct?: number; // apr: the fee rate per year, in %
  contract?: string; // card: the position's own condition contract (IAlucardCondition: answers true or false)
  /** a way back "the price is back in my range": a price level at the range's edge (bufferPct inside it) */
  backIn?: boolean;
};

export type ActionKind = "collect" | "withdraw" | "convert" | "readd" | "follow" | "move";
export type Action = {
  kind: ActionKind;
  pct?: number; // withdraw: % of the liquidity
  to?: "base" | "quote"; // convert; a move that holds a token: which one (unset = keep the tokens as they are)
  widthPct?: number; // follow: the new range, this % below and above the price
};

export type Combine = "and" | "or";

export type Lane = {
  trigger: Trigger | null;
  actions: Action[];
  repeat: boolean;
  stepPct?: number;
  /** A second condition: both must hold ("and") or either one ("or"). */
  trigger2?: Trigger | null;
  combine?: Combine;
  /** Price conditions read the average over this many minutes (at least 2). 0 / unset = 2 minutes. */
  holdMinutes?: number;
  /** With repeat (or a move): switch the side off after this many runs. 0 / unset = no limit. */
  maxRuns?: number;
};

/** Where the money goes on "move", and how it comes back. (Called the order's second leg in the contract.) */
export type PlanB = {
  where: "wait" | "park"; // wait: hold one token, no pool; park: a position in another pool
  parkPool?: number; // park: any Alucard pool that shares a token with this one
  parkWidthPct?: number; // park: the range there, ±% around its price when the money arrives
  returnTo: "same" | "recentre"; // back into the same range, or one of the same width centred on the price
  back: { down: Lane; up: Lane }; // when to come back (about this pool's base price); each lane only moves back
};

export type Rules = { down: Lane; up: Lane; plan?: PlanB };

export type Advanced = { keeperFeeBps: number; slippagePct: number; expiryDays: number };
export const DEFAULT_ADVANCED: Advanced = { keeperFeeBps: 10, slippagePct: 1, expiryDays: 30 };

export const ACTION_ORDER: ActionKind[] = ["collect", "withdraw", "convert", "readd", "follow", "move"];
export const emptyLane = (): Lane => ({ trigger: null, actions: [], repeat: false });
export const emptyRules = (): Rules => ({ down: emptyLane(), up: emptyLane() });
const moveLane = (trigger: Trigger | null): Lane => ({ trigger, actions: [{ kind: "move" }], repeat: true });
export const emptyPlan = (): PlanB => ({ where: "wait", returnTo: "recentre", back: { down: moveLane(null), up: moveLane(null) } });

/** The way back of the money a lane takes out: a fall out of the range comes back on a rise, and the other way. */
export const backLaneOf = (exit: LaneId): LaneId => (exit === "down" ? "up" : "down");

/** A range width that suits a pool: narrow for two stablecoins, wider otherwise. */
export const defaultWidthPct = (q: Pool) => (STABLE.includes(q.base.symbol) && STABLE.includes(q.quote.symbol) ? 0.2 : 5);

/** A new move for a lane: into the first other pool there is (or holding a token when there is none), coming back
 * into the same range once the price is back in it. */
export const newPlan = (exit: LaneId, home?: Pool): PlanB => {
  const q = home ? defaultPark(home) : undefined;
  const plan: PlanB = q
    ? { where: "park", parkPool: q.index, parkWidthPct: defaultWidthPct(q), returnTo: "same", back: { down: moveLane(null), up: moveLane(null) } }
    : { where: "wait", returnTo: "same", back: { down: moveLane(null), up: moveLane(null) } };
  plan.back[backLaneOf(exit)] = moveLane({ kind: "price", backIn: true });
  return plan;
};

/** "Back in my range" ways back get their price: the range's low edge for a rise back, its high edge for a fall back,
 * `bufferPct` further inside the range when set (so a price hovering at the edge does not bring it straight back). */
export function materialize(p: Pool, r: Rules, range?: [number, number]): Rules {
  if (!r.plan || !range) return r;
  const [lo, hi] = [priceAtTick(p, range[0]), priceAtTick(p, range[1])].sort((a, b) => a - b);
  const fix = (l: Lane, id: LaneId): Lane => {
    const t = l.trigger;
    if (!t?.backIn) return l;
    const b = (t.bufferPct ?? 0) / 100;
    return { ...l, trigger: { ...t, kind: "price", price: id === "up" ? lo * (1 + b) : hi * (1 - b) } };
  };
  return { ...r, plan: { ...r.plan, back: { down: fix(r.plan.back.down, "down"), up: fix(r.plan.back.up, "up") } } };
}

/** The other way: a decoded way back whose level is the range's edge reads as "back in my range". */
export function markBackIn(p: Pool, r: Rules, range: [number, number]): Rules {
  if (!r.plan) return r;
  const [lo, hi] = [priceAtTick(p, range[0]), priceAtTick(p, range[1])].sort((a, b) => a - b);
  const mark = (l: Lane, id: LaneId): Lane => {
    const t = l.trigger;
    const edge = id === "up" ? lo : hi;
    if (t?.kind !== "price") return l;
    // the level is the edge, or a whole % (0.5 steps) inside the range from it
    const inside = id === "up" ? (t.price ?? 0) / edge - 1 : 1 - (t.price ?? 0) / edge;
    const buf = Math.round(inside * 200) / 2;
    if (buf < 0 || buf > 10 || Math.abs(inside * 100 - buf) > 0.05) return l;
    return { ...l, trigger: { ...t, backIn: true, bufferPct: buf || undefined } };
  };
  return { ...r, plan: { ...r.plan, back: { down: mark(r.plan.back.down, "down"), up: mark(r.plan.back.up, "up") } } };
}

/** A price level: a pool's price against a fixed tick. A repeating level steps. */
const isLevel = (checker: number) => checker === CHECK.TICK || checker === CHECK.LINK;
export const MAX_RUNS = 127;
/** Rules.MAX_HOLD_MINUTES: a day. */
export const MAX_HOLD_MINUTES = 1440;
/** OrderState.MAX_TRAIL: a 99.99% fall in ticks. */
export const MAX_TRAIL_TICKS = 92_108;
const MAX_TICK = 887_272;
const BPS = 10_000;

/** A price level (the pool's price, or Chainlink's): a fixed number the price crosses; a repeating one steps. */
const isPrice = (t?: Trigger | null) => t?.kind === "price" || t?.kind === "otherPool" || t?.kind === "chainlink";
const isApr = (l: Lane) => l.trigger?.kind === "apr" || l.trigger2?.kind === "apr";
const live = (l: Lane) => !!l.trigger && l.actions.length > 0;

/** Which contract side a lane uses: "up" (base rises) is the upper side when base is token0. */
export const contractSide = (p: Pool, lane: LaneId): "lower" | "upper" => ((lane === "up") === p.baseIs0 ? "upper" : "lower");

/** The pool one trigger reads: another pool for "price in another pool", else `watch` (the leg's own price source). */
export const watchedBy = (p: Pool, t?: Trigger | null, watch: Pool = p): Pool =>
  (t?.kind === "otherPool" || t?.kind === "trail" || t?.kind === "chainlink") && t.poolIndex ? poolByIndex(t.poolIndex) ?? watch : watch;

/** Conditions that read a price (the decoder's TICK, TRAIL and LINK). */
const readsPrice = (t?: Trigger | null) => isPrice(t) || t?.kind === "trail";

/** The pool whose price direction decides a lane's contract side: the first condition that reads a pool's price. */
export const watched = (p: Pool, lane: Lane, watch: Pool = p): Pool =>
  readsPrice(lane.trigger) ? watchedBy(p, lane.trigger, watch) : readsPrice(lane.trigger2) ? watchedBy(p, lane.trigger2, watch) : watch;

type Slot = "lower" | "upper";
const otherSlot = (x: Slot): Slot => (x === "lower" ? "upper" : "lower");
const directional = (t?: Trigger | null) => readsPrice(t) || t?.kind === "leave";

/** The contract side a lane must use, or null when either will do (timer and fee conditions). A price check runs on
 * the watched pool's ticks, so that pool's orientation decides; APR is a lower-side condition ("earns less than"). */
function fixedSlot(own: Pool, id: LaneId, lane: Lane, watch: Pool): Slot | null {
  if (!live(lane)) return null;
  if (isApr(lane)) return "lower";
  if (directional(lane.trigger) || directional(lane.trigger2)) return contractSide(watched(own, lane, watch), id);
  return null;
}

/** The contract sides two lanes use: fixed ones where they must, the other slot for a lane that can use either.
 * `conflict` when both lanes need the same slot. */
export function slotsOf(own: Pool, lanes: { down: Lane; up: Lane }, watch: Pool = own): { down: Slot; up: Slot; conflict: boolean } {
  const fd = fixedSlot(own, "down", lanes.down, watch);
  const fu = fixedSlot(own, "up", lanes.up, watch);
  const down = fd ?? (fu ? otherSlot(fu) : contractSide(watch, "down"));
  const up = fu ?? (fd ? otherSlot(fd) : contractSide(watch, "up"));
  return { down, up, conflict: live(lanes.down) && live(lanes.up) && down === up };
}

export const has = (lane: Lane, k: ActionKind) => lane.actions.some((a) => a.kind === k);
export const get = (lane: Lane, k: ActionKind) => lane.actions.find((a) => a.kind === k);

/** Insert or replace an action, keeping the order the contract runs them in. Adds what an action needs. */
export function withAction(lane: Lane, a: Action): Lane {
  if (a.kind === "move") return { ...lane, actions: [a], repeat: false, stepPct: undefined }; // a move takes everything
  let actions = [...lane.actions.filter((x) => x.kind !== a.kind && x.kind !== "move"), a];
  if (a.kind === "convert" && !actions.some((x) => x.kind === "withdraw")) actions.push({ kind: "withdraw", pct: 100 });
  if (a.kind === "convert") actions = actions.filter((x) => x.kind !== "readd" && x.kind !== "follow");
  if (a.kind === "readd" || a.kind === "follow") {
    actions = actions.filter((x) => x.kind !== "convert" && (a.kind === "readd" ? x.kind !== "follow" : x.kind !== "readd"));
  }
  if (a.kind === "follow") actions = actions.filter((x) => x.kind !== "withdraw"); // follow moves everything
  actions.sort((x, y) => ACTION_ORDER.indexOf(x.kind) - ACTION_ORDER.indexOf(y.kind));
  return { ...lane, actions };
}

// ---------------------------------------------------------------- pools a move can go into

/** Pools a condition can watch: every pool in the table (with or without the hook), same pair first. */
export const watchable = (p: Pool) => {
  const others = POOLS.filter((q) => q.index !== p.index);
  const same = others.filter((q) => q.key.currency0 === p.key.currency0 && q.key.currency1 === p.key.currency1);
  return [...same, ...others.filter((q) => !same.includes(q))];
};

/** The token two pools share (null if none; the pair's token0 if they are the same pair). */
export function sharedToken(a: Pool, b: Pool): "token0" | "token1" | "both" | null {
  const in0 = b.key.currency0 === a.key.currency0 || b.key.currency1 === a.key.currency0;
  const in1 = b.key.currency0 === a.key.currency1 || b.key.currency1 === a.key.currency1;
  if (in0 && in1) return "both";
  return in0 ? "token0" : in1 ? "token1" : null;
}

const STABLE = ["USDC", "USDT", "DAI"];
/** Pools a move can go into: every pool in the table that shares a token with this one (another fee tier of the same pair
 * too). The money is swapped into the shared token on the way. */
export const parkable = (p: Pool) => POOLS.filter((q) => q.index !== p.index && sharedToken(p, q));
const STABLES = ["USDC", "USDT", "DAI"];
/** Where moved money goes by default: a pool of two stablecoins if one shares a token (it waits there at a steady
 * price), else the first pool that does. */
export const defaultPark = (p: Pool) => parkable(p).find((q) => STABLES.includes(q.base.symbol) && STABLES.includes(q.quote.symbol)) ?? parkable(p)[0];

// ---------------------------------------------------------------- trailing distance <-> ticks

const LN = Math.log(1.0001);
/** Ticks for a base-price move of `pct`: a fall of x% (down lane) or a rise of x% (up lane). */
const ticksForMove = (pct: number, rise: boolean) =>
  Math.max(1, Math.round((rise ? Math.log(1 + pct / 100) : -Math.log(1 - Math.min(pct, 99.99) / 100)) / LN));
const pctForMove = (ticks: number, rise: boolean) => (rise ? Math.exp(ticks * LN) - 1 : 1 - Math.exp(-ticks * LN)) * 100;
const round2 = (n: number) => Math.round(n * 100) / 100;
const alignUp = (t: number, s: number) => Math.max(s, Math.ceil(t / s) * s);

// ---------------------------------------------------------------- encode

/** Where a leg's lanes run: the pool of the leg, the pool its price conditions read, and whether it is waiting. */
type Ctx = { own: Pool; watch: Pool; idle: boolean; twoLegs: boolean; moveSwap: (lane: Lane) => boolean | undefined };

type Cond = { checker: number; value: number; checkPool: number };

function encodeTrigger(c: Ctx, laneId: LaneId, t: Trigger): Cond {
  const pool = (w: Pool) => (w.index === c.own.index ? 0 : w.index);
  if (t.kind === "leave") return { checker: CHECK.EDGE, value: ticksForPct(t.bufferPct ?? 0), checkPool: 0 };
  if (t.kind === "price" || t.kind === "otherPool") {
    const w = watchedBy(c.own, t, c.watch);
    return { checker: CHECK.TICK, value: Math.round(tickAtPrice(w, t.price ?? 0)), checkPool: pool(w) };
  }
  // the pair's Chainlink price, as a tick of that pool: the same number a pool price level would use
  if (t.kind === "chainlink") {
    const w = watchedBy(c.own, t, c.watch);
    return { checker: CHECK.LINK, value: Math.round(tickAtPrice(w, t.price ?? 0)), checkPool: pool(w) };
  }
  if (t.kind === "trail") return { checker: CHECK.TRAIL, value: ticksForMove(t.trailPct ?? 5, laneId === "up"), checkPool: pool(watchedBy(c.own, t, c.watch)) };
  if (t.kind === "card") return { checker: CHECK.EXTERNAL, value: 0, checkPool: 0 }; // the address goes with the order
  if (t.kind === "fees") return { checker: CHECK.FEES, value: Math.round((t.feesPct ?? 1) * 100), checkPool: 0 };
  if (t.kind === "apr") return { checker: CHECK.APR, value: Math.round((t.aprPct ?? 5) * 100), checkPool: 0 };
  return { checker: CHECK.TIME, value: Math.max(1, Math.round((t.hours ?? 24) * 60)), checkPool: 0 };
}

function encodeLane(c: Ctx, lane: Lane, laneId: LaneId, slot: Slot): Side {
  const s = offSide();
  if (!live(lane)) return s;
  const p = c.own;
  const upper = slot === "upper";
  const follow = get(lane, "follow");
  const move = get(lane, "move");
  const spacing = p.key.tickSpacing;

  Object.assign(s, encodeTrigger(c, laneId, lane.trigger!));
  if (lane.trigger2) {
    const b = encodeTrigger(c, laneId, lane.trigger2);
    s.checker2 = b.checker;
    s.value2 = b.value;
    s.checkPool2 = b.checkPool;
    s.combine = lane.combine === "or" ? COMBINE.OR : COMBINE.AND;
  }
  s.holdMinutes = Math.max(0, Math.round(lane.holdMinutes ?? 0));

  if (move) {
    // a move takes everything to the other leg and stays for the way back (repeat)
    s.repeat = true;
    s.runsLeft = Math.max(0, Math.round(lane.maxRuns ?? 0));
    if (c.idle) {
      s.actions = ACT.MOVE;
      return s;
    }
    s.actions = ACT.REMOVE | ACT.KEEP_FEES | ACT.MOVE;
    s.removeBps = BPS;
    const toToken1 = c.moveSwap(lane);
    if (toToken1 !== undefined) {
      s.actions |= ACT.SWAP;
      s.swapToToken1 = toToken1;
    }
    return s;
  }

  const withdraw = get(lane, "withdraw");
  const collect = has(lane, "collect");
  let bits = collect ? 0 : ACT.KEEP_FEES;
  if (withdraw) {
    bits |= ACT.REMOVE;
    s.removeBps = Math.round((withdraw.pct ?? 100) * 100);
  } else if (collect) {
    bits |= ACT.REMOVE; // remove nothing: just collect the fees and send them out
    s.removeBps = 0;
  }
  const convert = get(lane, "convert");
  if (convert) {
    bits |= ACT.SWAP;
    const target = convert.to === "base" ? p.base : p.quote;
    s.swapToToken1 = target.address === p.token1.address;
  }
  if (has(lane, "readd")) {
    bits |= ACT.ADD;
    s.addMode = ADD_SAME;
  }
  if (follow) {
    // everything moves into a new range around the price: `widthPct` below and above it, in spacings
    bits |= ACT.ADD | ACT.REMOVE;
    s.removeBps = BPS;
    s.addMode = ADD_CENTERED;
    const w = Math.max(1, Math.min(2047, Math.ceil(ticksForPct(follow.widthPct ?? 5) / spacing)));
    s.shape = w | (w << 11);
  }
  s.actions = bits;
  s.repeat = lane.repeat;
  const stepsA = isLevel(s.checker);
  const stepsB = !!lane.trigger2 && isLevel(s.checker2);
  // a repeating price level steps after each run; with Follow the shape field holds the new range's width instead
  if (lane.repeat && (stepsA || stepsB) && !follow) s.shape = ticksForPct(lane.stepPct ?? 5);
  s.runsLeft = lane.repeat ? Math.max(0, Math.round(lane.maxRuns ?? 0)) : 0;
  return s;
}

function encodeLanes(c: Ctx, lanes: { down: Lane; up: Lane }): { lower: Side; upper: Side } {
  const out = { lower: offSide(), upper: offSide() };
  const slots = slotsOf(c.own, lanes, c.watch);
  if (live(lanes.down)) out[slots.down] = encodeLane(c, lanes.down, "down", slots.down);
  if (live(lanes.up)) out[slots.up] = encodeLane(c, lanes.up, "up", slots.up);
  return out;
}

/** The pools of a strategy's two legs. */
export function legPools(home: Pool, plan?: PlanB): { away: Pool; awayWatch: Pool } {
  const park = plan?.where === "park" && plan.parkPool ? poolByIndex(plan.parkPool) : undefined;
  return { away: park ?? home, awayWatch: home };
}

function homeCtx(home: Pool, plan?: PlanB): Ctx {
  const { away } = legPools(home, plan);
  const shared = plan?.where === "park" ? sharedToken(home, away) : null;
  return {
    own: home,
    watch: home,
    idle: false,
    twoLegs: !!plan,
    moveSwap: (lane) => {
      if (shared === "token0" || shared === "token1") return shared === "token1"; // sell into the token the other pool has
      // the same pair (another fee tier), or waiting: hold what the owner chose, or the tokens as they are
      const to = get(lane, "move")?.to; // waiting: hold what the owner chose, or the tokens as they are
      return to ? (to === "base" ? home.base : home.quote).address === home.token1.address : undefined;
    },
  };
}

function awayCtx(home: Pool, plan: PlanB): Ctx {
  const { away } = legPools(home, plan);
  const shared = plan.where === "park" ? sharedToken(away, home) : null;
  return {
    own: away,
    watch: home, // coming back is about this position's pool
    idle: plan.where === "wait",
    twoLegs: true,
    moveSwap: (lane) => {
      if (shared === "token0" || shared === "token1") return shared === "token1"; // back into the token this pool shares
      const to = get(lane, "move")?.to; // the same pair (another fee tier): swap only if asked
      return to ? (to === "base" ? away.base : away.quote).address === away.token1.address : undefined;
    },
  };
}

/** Everything createOrder needs besides the amounts: the packed sides and the two legs. */
export type Encoded = { lower: bigint; upper: bigint; home: Leg; away: Leg; awayLower: bigint; awayUpper: bigint };

/** Encode a strategy for a new position in [tickLower, tickUpper] of pool `p`. */
export function encodeRules(p: Pool, r: Rules, range: [number, number] = [0, 0]): Encoded & { sides: { lower: Side; upper: Side } } {
  r = materialize(p, r, range);
  const sides = encodeLanes(homeCtx(p, r.plan), r);
  const out = { lower: encodeSide(sides.lower), upper: encodeSide(sides.upper), home: noLeg(), away: noLeg(), awayLower: 0n, awayUpper: 0n, sides };
  if (!r.plan) return out;
  const plan = r.plan;
  const s = p.key.tickSpacing;
  const half = alignUp((range[1] - range[0]) / 2, s);
  out.home = plan.returnTo === "same" ? { poolIndex: 0, kind: LEG.RANGE, a: range[0], b: range[1] } : { poolIndex: 0, kind: LEG.CENTERED, a: half, b: half };
  const { away } = legPools(p, plan);
  if (plan.where === "wait") out.away = { poolIndex: p.index, kind: LEG.IDLE, a: 0, b: 0 };
  else {
    const w = alignUp(ticksForPct(plan.parkWidthPct ?? 0.5), away.key.tickSpacing);
    out.away = { poolIndex: away.index, kind: LEG.CENTERED, a: w, b: w };
  }
  const back = encodeLanes(awayCtx(p, plan), plan.back);
  out.awayLower = encodeSide(back.lower);
  out.awayUpper = encodeSide(back.upper);
  return out;
}

/** Encode the live leg's lanes for updateOrder: the position's rules, or the "come back" lanes while it is moved. */
export function encodeLive(home: Pool, r: Rules, liveIsHome: boolean, range?: [number, number]): { lower: bigint; upper: bigint } {
  r = materialize(home, r, range);
  const c = liveIsHome ? homeCtx(home, r.plan) : awayCtx(home, r.plan!);
  const sides = encodeLanes(c, liveIsHome ? r : r.plan!.back);
  return { lower: encodeSide(sides.lower), upper: encodeSide(sides.upper) };
}

// ---------------------------------------------------------------- decode

function decodeTrigger(c: Ctx, laneId: LaneId, checker: number, value: number, checkPool: number): Trigger {
  if (checker === CHECK.EDGE) return { kind: "leave", bufferPct: round2(pctForTicks(value)) };
  if (checker === CHECK.TICK) {
    const w = checkPool ? poolByIndex(checkPool) ?? c.watch : c.own;
    if (w.index === c.watch.index) return { kind: "price", price: priceAtTick(w, value) };
    return { kind: "otherPool", price: priceAtTick(w, value), poolIndex: w.index };
  }
  if (checker === CHECK.LINK) {
    const w = checkPool ? poolByIndex(checkPool) ?? c.watch : c.own;
    const t: Trigger = { kind: "chainlink", price: priceAtTick(w, value) };
    if (w.index !== c.watch.index) t.poolIndex = w.index;
    return t;
  }
  if (checker === CHECK.TRAIL) {
    const t: Trigger = { kind: "trail", trailPct: round2(pctForMove(value, laneId === "up")) };
    const w = checkPool ? poolByIndex(checkPool) : c.own;
    if (w && w.index !== c.watch.index) t.poolIndex = w.index; // follows a pool other than the one this leg watches
    return t;
  }
  if (checker === CHECK.EXTERNAL) return { kind: "card" }; // its address is the order's conditionOf (withCondition)
  if (checker === CHECK.FEES) return { kind: "fees", feesPct: value / 100 };
  if (checker === CHECK.APR) return { kind: "apr", aprPct: value / 100 };
  return { kind: "timer", hours: round2(value / 60) };
}

function decodeLane(c: Ctx, s: Side, upper: boolean, laneId: LaneId): Lane {
  const lane = emptyLane();
  if (s.checker === CHECK.OFF) return lane;
  const p = c.own;
  lane.trigger = decodeTrigger(c, laneId, s.checker, s.value, s.checkPool);
  if (s.combine !== COMBINE.NONE && s.checker2 !== CHECK.OFF) {
    lane.trigger2 = decodeTrigger(c, laneId, s.checker2, s.value2, s.checkPool2);
    lane.combine = s.combine === COMBINE.OR ? "or" : "and";
  }
  if (s.holdMinutes) lane.holdMinutes = s.holdMinutes;

  if (s.actions & ACT.MOVE) {
    const move: Action = { kind: "move" };
    if (c.idle === false && s.actions & ACT.SWAP && c.twoLegs) {
      const target = s.swapToToken1 ? p.token1 : p.token0;
      move.to = target.address === p.base.address ? "base" : "quote";
    }
    lane.actions = [move];
    if (s.runsLeft) lane.maxRuns = s.runsLeft;
    return lane;
  }

  const keep = (s.actions & ACT.KEEP_FEES) !== 0;
  const remove = (s.actions & ACT.REMOVE) !== 0;
  const add = (s.actions & ACT.ADD) !== 0;
  if (add && s.addMode === ADD_CENTERED) {
    const w = s.shape & 2047;
    if (!keep) lane.actions.push({ kind: "collect" });
    lane.actions.push({ kind: "follow", widthPct: round2(pctForTicks(w * p.key.tickSpacing)) });
  } else {
    if (!keep) lane.actions.push({ kind: "collect" });
    if (remove && s.removeBps > 0) lane.actions.push({ kind: "withdraw", pct: s.removeBps / 100 });
    if (s.actions & ACT.SWAP) {
      const target = s.swapToToken1 ? p.token1 : p.token0;
      lane.actions.push({ kind: "convert", to: target.address === p.base.address ? "base" : "quote" });
    }
    if (add) lane.actions.push({ kind: "readd" });
  }
  lane.actions.sort((x, y) => ACTION_ORDER.indexOf(x.kind) - ACTION_ORDER.indexOf(y.kind));
  lane.repeat = s.repeat;
  const steps = isLevel(s.checker) || (lane.trigger2 && isLevel(s.checker2));
  if (s.repeat && steps && !(add && s.addMode === ADD_CENTERED)) lane.stepPct = round2(pctForTicks(s.shape));
  if (s.repeat && s.runsLeft) lane.maxRuns = s.runsLeft;
  return lane;
}

function decodeLanes(c: Ctx, lower: Side, upper: Side): { down: Lane; up: Lane } {
  const r = { down: emptyLane(), up: emptyLane() };
  // the inverse of slotsOf: a side whose conditions fix its lane gets it; a side on a timer or fees takes the other
  const flip = (l: LaneId): LaneId => (l === "up" ? "down" : "up");
  const fixedLane = (s: Side, isUpper: boolean): LaneId | null => {
    if (s.checker === CHECK.OFF) return null;
    if (s.checker === CHECK.APR || (s.combine && s.checker2 === CHECK.APR)) return contractSide(c.watch, "down") === "lower" ? "down" : "up";
    // the first condition that reads a pool's price decides the direction: that pool's (0 = the leg's own pool)
    const reads = (checker: number) => checker === CHECK.TICK || checker === CHECK.TRAIL || checker === CHECK.LINK;
    const dir = (checker: number) => reads(checker) || checker === CHECK.EDGE;
    if (!dir(s.checker) && !(s.combine && dir(s.checker2))) return null;
    const first = reads(s.checker) ? s.checkPool : s.combine && reads(s.checker2) ? s.checkPool2 : null;
    const w = first === null ? c.watch : first ? poolByIndex(first) ?? c.watch : c.own;
    return isUpper === w.baseIs0 ? "up" : "down";
  };
  const fl = fixedLane(lower, false);
  const fu = fixedLane(upper, true);
  const byOrientation = (isUpper: boolean): LaneId => (isUpper === c.watch.baseIs0 ? "up" : "down");
  let loLane = fl ?? (fu ? flip(fu) : byOrientation(false));
  let upLane = fu ?? (fl ? flip(fl) : byOrientation(true));
  if (loLane === upLane) {
    // both fixed to one lane: the editor cannot place them; keep both, by orientation
    loLane = byOrientation(false);
    upLane = byOrientation(true);
  }
  r[loLane] = decodeLane(c, lower, false, loLane);
  r[upLane] = decodeLane(c, upper, true, upLane);
  return r;
}

/** The contract's Plan, as getPlan returns it. */
export type ChainPlan = { here: Leg; there: Leg; thereLower: bigint; thereUpper: bigint; held0: bigint; held1: bigint };

/** A strategy from what the contract stores. `home` is the position's own pool (where the order was created). */
export function decodeStrategy(home: Pool, livePool: number, lowerWord: bigint, upperWord: bigint, plan?: ChainPlan): { rules: Rules; liveIsHome: boolean } {
  const lower = decodeSide(lowerWord);
  const upper = decodeSide(upperWord);
  if (!plan || plan.here.kind === LEG.NONE) return { rules: decodeLanes(homeCtx(home), lower, upper), liveIsHome: true };
  const liveIsHome = plan.here.kind !== LEG.IDLE && livePool === home.index;
  const homeLeg = liveIsHome ? plan.here : plan.there;
  const awayLeg = liveIsHome ? plan.there : plan.here;
  const parkPool = poolByIndex(awayLeg.poolIndex);
  const pb: PlanB = {
    where: awayLeg.kind === LEG.IDLE ? "wait" : "park",
    returnTo: homeLeg.kind === LEG.RANGE ? "same" : "recentre",
    back: { down: emptyLane(), up: emptyLane() },
  };
  if (pb.where === "park" && parkPool) {
    pb.parkPool = parkPool.index;
    pb.parkWidthPct = round2(pctForTicks(Number(awayLeg.a)));
  }
  const homeSides = liveIsHome ? [lower, upper] : [decodeSide(plan.thereLower), decodeSide(plan.thereUpper)];
  const awaySides = liveIsHome ? [decodeSide(plan.thereLower), decodeSide(plan.thereUpper)] : [lower, upper];
  const rules: Rules = { ...decodeLanes(homeCtx(home, pb), homeSides[0], homeSides[1]), plan: pb };
  pb.back = decodeLanes(awayCtx(home, pb), awaySides[0], awaySides[1]);
  return { rules, liveIsHome };
}

/** One-leg decode, kept for callers that only have two sides. */
export function decodeRules(p: Pool, lower: Side, upper: Side): Rules {
  return decodeLanes(homeCtx(p), lower, upper);
}

// ---------------------------------------------------------------- validation (mirrors Rules.checkSide / checkLegs)

function triggerErrors(c: Ctx, laneId: LaneId, t: Trigger, which: string): string[] {
  const e: string[] = [];
  if (t.kind === "timer" && !(Math.round((t.hours ?? 0) * 60) >= 1)) e.push(`The timer${which} needs at least 1 minute.`);
  if (t.kind === "leave" && !((t.bufferPct ?? 0) >= 0)) e.push(`The distance past the edge${which} cannot be negative.`);
  if (isPrice(t)) {
    if (!(t.price! > 0)) e.push(`Set the trigger price${which}.`);
    else if (Math.abs(Math.round(tickAtPrice(watchedBy(c.own, t, c.watch), t.price!))) >= MAX_TICK) e.push(`The trigger price${which} is outside what Uniswap can price.`);
  }
  if (t.kind === "chainlink" && t.poolIndex && !poolByIndex(t.poolIndex)) e.push(`Choose the pool whose Chainlink price to read${which}.`);
  if (t.kind === "otherPool" || (t.kind === "trail" && t.poolIndex)) {
    const w = t.poolIndex ? poolByIndex(t.poolIndex) : undefined;
    // the position's own pool is "price reaches a level"; a parked leg may still watch the pool it is parked in
    if (!w || (w.index === c.own.index && c.own.index === c.watch.index)) e.push(`Choose another pool to watch${which}.`);
  }
  if (t.kind === "trail") {
    const ok = t.trailPct! > 0 && (laneId === "up" || t.trailPct! < 100) && ticksForMove(t.trailPct!, laneId === "up") <= MAX_TRAIL_TICKS;
    if (!ok) e.push(`The trailing distance${which} must be above 0% (and a fall of less than 100%).`);
  }
  if (t.kind === "fees" && !(Math.round((t.feesPct ?? 0) * 100) >= 1 && t.feesPct! <= 100)) e.push(`The fees earned${which} must be 0.01% to 100% of the position.`);
  if (t.kind === "apr" && !(Math.round((t.aprPct ?? 0) * 100) >= 1 && t.aprPct! * 100 < 8_388_608)) e.push(`Set the fee rate${which} (above 0% a year).`);
  if (c.idle && (t.kind === "leave" || t.kind === "fees" || t.kind === "apr")) e.push(`While waiting there is no position: this condition${which} cannot be used.`);
  return e;
}

function laneErrors(c: Ctx, id: LaneId, lane: Lane): string[] {
  const e: string[] = [];
  if (!lane.trigger) {
    if (lane.actions.length && !has(lane, "move")) e.push("Add a trigger, or these steps never run.");
    return e;
  }
  if (lane.actions.length === 0) e.push("Add a step after the condition.");
  const t = lane.trigger;
  const t2 = lane.trigger2 ?? null;
  const moves = has(lane, "move");
  const follows = has(lane, "follow");
  e.push(...triggerErrors(c, id, t, ""));
  if (t2) e.push(...triggerErrors(c, id, t2, " (second condition)"));
  if (moves && !c.twoLegs) e.push("“Move” needs a place to go: choose a pool or a token to hold.");
  if (moves && lane.actions.length > 1) e.push("“Move” takes everything: remove the other steps.");
  if (c.idle && !moves) e.push("While waiting, the only step is coming back.");
  const w = get(lane, "withdraw");
  const leaves = moves || (!!w && (w.pct ?? 0) >= 100 && !has(lane, "readd") && !follows);
  if (!moves) {
    if (lane.repeat && leaves) e.push("This side withdraws everything, so there is nothing left to repeat on. Turn repeat off, or withdraw part of it.");
    if (lane.repeat && t.kind === "leave" && !follows)
      e.push("Repeating this would fire again straight away, because the range does not move. Turn repeat off or use “Follow the price”.");
    if (t2 && lane.combine === "or" && lane.repeat && t2.kind === "leave" && !follows)
      e.push("With “or”, a repeating “Leaves range” condition would fire again straight away. Use “and”, or turn repeat off.");
    if (lane.repeat && isPrice(t) && follows)
      e.push("A repeating price level cannot step when the side follows the price, so it would fire again straight away. Use “Leaves my range”, or turn repeat off.");
    if (t2 && lane.combine === "or" && lane.repeat && isPrice(t2) && follows)
      e.push("With “or” and “Follow the price”, a repeating price level cannot move, so it would fire again straight away. Use “and”, or turn repeat off.");
    const priceLevel = isPrice(t) || isPrice(t2);
    if (lane.repeat && priceLevel && !follows && !(ticksForPct(lane.stepPct ?? 0) > 0)) e.push("Set how far the trigger price moves after each run.");
  }
  if ((t.kind === "apr" || t2?.kind === "apr") && !leaves) e.push("“Fees earn less than” is a reason to leave: withdraw everything, or move the money.");
  if (t.kind === "trail" && t2?.kind === "trail") e.push("Only one trailing stop per side.");
  const hold = lane.holdMinutes ?? 0;
  if (hold && !(Number.isInteger(hold) && hold >= 1 && hold <= MAX_HOLD_MINUTES)) e.push(`“Only if it lasts” must be 1 to ${MAX_HOLD_MINUTES} whole minutes.`);
  const runs = lane.maxRuns ?? 0;
  if (runs && !lane.repeat && !moves) e.push("A run limit only applies when the side repeats.");
  if (runs && !(Number.isInteger(runs) && runs >= 1 && runs <= MAX_RUNS)) e.push(`The run limit must be 1 to ${MAX_RUNS}.`);
  // Both price conditions must point the same way on the contract's ticks.

  if (w && !(Math.round((w.pct ?? 0) * 100) >= 1 && w.pct! <= 100)) e.push("Withdraw must be between 0.01% and 100%.");
  if (has(lane, "convert") && !w) e.push("“Convert” needs a “Withdraw” step before it: there is nothing to convert otherwise.");
  if (has(lane, "convert") && (has(lane, "readd") || follows)) e.push("“Convert” cannot be followed by putting the tokens back in.");
  if (follows && (w || has(lane, "readd"))) e.push("“Follow the price” already moves everything: remove the other steps.");
  return e;
}

/** Everything the contract would refuse, by place; `advice` is what it would accept but would not work as meant
 * (a way back that is already true on arrival, say). The app blocks both. */
export type Validation = { down: string[]; up: string[]; general: string[]; backDown: string[]; backUp: string[]; plan: string[]; advice: string[] };

/** Every reason the contract would refuse this strategy, in plain words. `range` is the position's range (ticks). */
export function validate(p: Pool, r: Rules, range?: [number, number], opts: { planLocked?: boolean } = {}): Validation {
  r = materialize(p, r, range);
  const out: Validation = { down: [], up: [], general: [], backDown: [], backUp: [], plan: [], advice: conditionAdvice(r) };
  const hc = homeCtx(p, r.plan);
  out.down = laneErrors(hc, "down", r.down);
  out.up = laneErrors(hc, "up", r.up);
  // two price conditions on one side must move the same way on the contract's ticks: the contract takes any pair of
  // pools, but if they are quoted the opposite way round, "falls" would mean the opposite in one of them
  const directional = (t?: Trigger | null) => isPrice(t) || t?.kind === "trail";
  const opposite = (c: Ctx, l: Lane) => directional(l.trigger) && directional(l.trigger2) && watchedBy(c.own, l.trigger, c.watch).baseIs0 !== watchedBy(c.own, l.trigger2, c.watch).baseIs0;
  if (opposite(hc, r.down) || opposite(hc, r.up))
    out.advice.push("The two conditions watch pools whose prices are quoted the opposite way round. Pick pools with the same base token.");
  if (!live(r.down) && !live(r.up)) out.general.push("Add a condition and a step on at least one side.");
  if (slotsOf(p, r).conflict)
    out.general.push(
      isApr(r.down) || isApr(r.up)
        ? "“Fees earn less than” can only be used on one side, and the other side needs that place too. Move one of them to the other side."
        : "These two conditions watch prices quoted the opposite way round and would need the same place. Move one of them to the other side.",
    );
  if (r.plan) {
    const plan = r.plan;
    if (!opts.planLocked && !has(r.down, "move") && !has(r.up, "move")) out.plan.push("Nothing moves the money: add a “Move” step to a side.");
    if (range && plan.returnTo === "recentre" && alignUp((range[1] - range[0]) / 2, p.key.tickSpacing) > MAX_TRAIL_TICKS)
      out.plan.push("This range is too wide to re-centre: come back into the same range instead.");
    if (plan.where === "park") {
      const q = plan.parkPool ? poolByIndex(plan.parkPool) : undefined;
      if (!q) out.plan.push("Choose the pool to move into.");
      else if (!sharedToken(p, q)) out.plan.push("The other pool must share a token with this one.");
      if (!(ticksForPct(plan.parkWidthPct ?? 0) >= 1)) out.plan.push("Set the range in the other pool.");
      else if (q && alignUp(ticksForPct(plan.parkWidthPct!), q.key.tickSpacing) > MAX_TRAIL_TICKS) out.plan.push("The range in the other pool is too wide.");
    }
    const ac = awayCtx(p, plan);
    out.backDown = laneErrors(ac, "down", plan.back.down);
    out.backUp = laneErrors(ac, "up", plan.back.up);
    if (!live(plan.back.down) && !live(plan.back.up)) out.plan.push("Set when the money comes back.");
    if (slotsOf(ac.own, plan.back, ac.watch).conflict)
      out.plan.push("The two ways back need the same slot. Use one of them.");
    // a way back that is already true on arrival would bring the money straight back
    if (range) {
      const prices = [priceAtTick(p, range[0]), priceAtTick(p, range[1])].sort((a, b) => a - b);
      const level = (l: Lane) => (l.trigger?.kind === "price" ? l.trigger.price ?? 0 : null);
      const bd = level(plan.back.down);
      const bu = level(plan.back.up);
      // Both ways back are live whichever side moved the money out, so each must not be true the moment it arrives.
      const both = has(r.down, "move") && has(r.up, "move");
      if (has(r.down, "move") && bd !== null && bd >= prices[0])
        out.advice.push(
          both
            ? `Both sides move the money, so both ways back watch it: right after a fall out of the range, “${p.base.symbol} drops below ${fmt(bd)}” is already true. Use a turn (% from the high or low) or a timer for one of them.`
            : `After falling out of the range ${p.base.symbol} is already below ${fmt(bd)}, so the money would come straight back. Pick a level below the range.`,
        );
      if (has(r.up, "move") && bu !== null && bu <= prices[1])
        out.advice.push(
          both
            ? `Both sides move the money, so both ways back watch it: right after a rise out of the range, “${p.base.symbol} rises above ${fmt(bu)}” is already true. Use a turn (% from the high or low) or a timer for one of them.`
            : `After rising out of the range ${p.base.symbol} is already above ${fmt(bu)}, so the money would come straight back. Pick a level above the range.`,
        );
      // and a way back in the other direction must not be one the price is already past when it arrives
      if (has(r.down, "move") && bu !== null && bu < prices[0])
        out.advice.push(`${fmt(bu)} is below the range: right after falling out, ${p.base.symbol} can still be above it and the money would come straight back. Use the range's low edge or higher.`);
      if (has(r.up, "move") && bd !== null && bd > prices[1])
        out.advice.push(`${fmt(bd)} is above the range: right after rising out, ${p.base.symbol} can still be below it and the money would come straight back. Use the range's high edge or lower.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the position's own condition contract

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const cardTriggers = (r: Rules): Trigger[] =>
  [r.down, r.up, ...(r.plan ? [r.plan.back.down, r.plan.back.up] : [])].flatMap((l) => [l.trigger, l.trigger2]).filter((t): t is Trigger => t?.kind === "card");

/** The contract the order's "own condition" sides ask (one per position), or undefined. */
export const conditionOf = (r: Rules): `0x${string}` | undefined => {
  const c = cardTriggers(r).find((t) => t.contract && ADDRESS.test(t.contract))?.contract;
  return c as `0x${string}` | undefined;
};

/** Give every "own condition" side the order's contract (as read back from the chain). */
export function withCondition(r: Rules, address?: string): Rules {
  if (!address || /^0x0{40}$/.test(address)) return r;
  const fix = (l: Lane): Lane => ({
    ...l,
    trigger: l.trigger?.kind === "card" ? { ...l.trigger, contract: address } : l.trigger,
    trigger2: l.trigger2?.kind === "card" ? { ...l.trigger2, contract: address } : l.trigger2,
  });
  return { ...r, down: fix(r.down), up: fix(r.up), plan: r.plan ? { ...r.plan, back: { down: fix(r.plan.back.down), up: fix(r.plan.back.up) } } : r.plan };
}

/** What the contract accepts but would not work as meant: an own-condition side with no contract, or two contracts. */
function conditionAdvice(r: Rules): string[] {
  const cards = cardTriggers(r);
  if (!cards.length) return [];
  if (cards.some((t) => !t.contract || !ADDRESS.test(t.contract))) return ["Paste the address of your condition contract."];
  if (new Set(cards.map((t) => t.contract!.toLowerCase())).size > 1)
    return ["A position has one condition contract: use the same address on every side (it is told which side asks)."];
  return [];
}

export const isValid = (v: Validation) => Object.values(v).every((x) => x.length === 0);
/** Only what the contract itself would refuse (the parity test's notion of "the editor can build it"). */
export const contractValid = (v: Validation) => Object.entries(v).every(([k, x]) => k === "advice" || x.length === 0);
export const allErrors = (v: Validation) => [...v.down, ...v.up, ...v.general, ...v.plan, ...v.backDown, ...v.backUp, ...v.advice];

// ---------------------------------------------------------------- plain English

export function laneTitle(p: Pool, id: LaneId, lane?: Lane) {
  const t = lane?.trigger;
  if (t && (t.kind === "timer" || t.kind === "fees" || t.kind === "apr" || t.kind === "card") && (!lane!.trigger2 || lane!.trigger2.kind === t.kind)) {
    return t.kind === "timer" ? "On a timer" : t.kind === "card" ? "On my own condition" : "On fees earned";
  }
  const w = lane ? watched(p, lane) : p;
  return id === "down" ? `If ${w.base.symbol} falls` : `If ${w.base.symbol} rises`;
}

const every = (hours: number) =>
  hours < 1 ? `${Math.round(hours * 60)} min` : hours % 24 === 0 && hours >= 24 ? `${hours / 24} day${hours === 24 ? "" : "s"}` : `${hours} h`;

export function describeTrigger(p: Pool, id: LaneId, t: Trigger): string {
  const dir = id === "down" ? "below" : "above";
  switch (t.kind) {
    case "leave":
      return t.bufferPct ? `${p.base.symbol} moves ${t.bufferPct}% ${dir} my range` : `${p.base.symbol} leaves my range (${dir})`;
    case "price":
      if (t.backIn) return t.bufferPct ? `${p.base.symbol} is ${t.bufferPct}% back inside my range` : `${p.base.symbol} is back in my range`;
      return `${p.base.symbol} ${id === "down" ? "drops below" : "rises above"} ${fmt(t.price ?? 0)} ${p.quote.symbol}`;
    case "otherPool": {
      const other = t.poolIndex ? poolByIndex(t.poolIndex) : undefined;
      const w = other ?? p;
      return `${w.base.symbol} ${id === "down" ? "drops below" : "rises above"} ${fmt(t.price ?? 0)} ${w.quote.symbol} in ${other?.label ?? "another pool"}`;
    }
    case "chainlink": {
      const other = t.poolIndex ? poolByIndex(t.poolIndex) : undefined;
      const w = other ?? p;
      return `Chainlink's ${w.base.symbol} price ${id === "down" ? "drops below" : "rises above"} ${fmt(t.price ?? 0)} ${w.quote.symbol}`;
    }
    case "trail": {
      const other = t.poolIndex ? poolByIndex(t.poolIndex) : undefined;
      const b = (other ?? p).base.symbol;
      const where = other ? ` in ${other.label}` : "";
      return id === "down" ? `${b} falls ${t.trailPct}% from its highest price${where}` : `${b} rises ${t.trailPct}% from its lowest price${where}`;
    }
    case "fees":
      return `fees earned reach ${t.feesPct}% of the position`;
    case "apr":
      return `fees earn less than ${t.aprPct}% a year`;
    case "timer":
      return `every ${every(t.hours ?? 24)}`;
    case "card":
      return t.contract ? `my contract ${t.contract.slice(0, 6)}…${t.contract.slice(-4)} says yes` : "my contract says yes";
  }
}

/** The second condition as it reads after "and" / "or". */
function describeSecond(p: Pool, id: LaneId, lane: Lane): string {
  const t2 = lane.trigger2!;
  if (t2.kind === "timer") return lane.combine === "or" ? `every ${every(t2.hours ?? 24)}` : `at least ${every(t2.hours ?? 24)} since the last run`;
  return describeTrigger(p, id, t2);
}

/** The whole "when" part of a lane, e.g. "When ETH leaves my range and at least 1 day since the last run". */
export function describeWhen(p: Pool, id: LaneId, lane: Lane): string {
  const t = lane.trigger!;
  let when = t.kind === "timer" ? `Every ${every(t.hours ?? 24)}` : `When ${describeTrigger(p, id, t)}`;
  if (lane.trigger2) when += `${lane.combine === "or" ? ", or" : " and"} ${describeSecond(p, id, lane)}`;
  if (lane.holdMinutes) when += `, for ${lane.holdMinutes} min in a row`;
  return when;
}

/** Where a move takes the money, e.g. "into USDT / USDC · 0.01% (±0.2%)" or "hold USDC". */
export function describePlan(p: Pool, plan: PlanB, to?: "base" | "quote"): string {
  if (plan.where === "wait") return to ? `hold ${to === "base" ? p.base.symbol : p.quote.symbol}` : "hold the tokens as they are";
  const q = plan.parkPool ? poolByIndex(plan.parkPool) : undefined;
  return q ? `into ${q.label} (±${plan.parkWidthPct}%)` : "into another pool";
}

export function describeAction(p: Pool, a: Action, plan?: PlanB): string {
  switch (a.kind) {
    case "collect":
      return "send earned fees to my wallet";
    case "withdraw":
      return a.pct === 100 ? "withdraw everything" : `withdraw ${a.pct}%`;
    case "convert":
      return `convert it all to ${a.to === "base" ? p.base.symbol : p.quote.symbol}`;
    case "readd":
      return "put it back into the same range (compound)";
    case "follow":
      return `re-centre around the price (±${a.widthPct}%)`;
    case "move": {
      if (!plan) return "move the money";
      const q = plan.where === "park" && plan.parkPool ? poolByIndex(plan.parkPool) : undefined;
      if (!q) return describePlan(p, plan, a.to);
      const shared = sharedToken(p, q);
      const via = shared === "token0" ? p.token0.symbol : shared === "token1" ? p.token1.symbol : null;
      return `${via ? `swap to ${via} and ` : ""}move it ${describePlan(p, plan)}`;
    }
  }
}

export function describeLane(p: Pool, id: LaneId, lane: Lane, plan?: PlanB): string | null {
  if (!lane.trigger || !lane.actions.length) return null;
  const steps = lane.actions.map((a) => describeAction(p, a, plan)).join(", then ");
  const limit = lane.maxRuns ? ` up to ${lane.maxRuns} time${lane.maxRuns === 1 ? "" : "s"}` : "";
  if (has(lane, "move")) return `${describeWhen(p, id, lane)}: ${steps}${limit ? `. At most${limit}` : ""}.`;
  const priceLevel = isPrice(lane.trigger) || isPrice(lane.trigger2);
  const tail = lane.repeat ? (priceLevel && !has(lane, "follow") ? `. Repeats${limit}, moving the trigger price ${lane.stepPct}% further each time.` : `. Repeats${limit}.`) : ". Runs once.";
  return `${describeWhen(p, id, lane)}: ${steps}${tail}`;
}

/** "Comes back when …" lines of a move. */
export function describeBack(p: Pool, plan: PlanB): string[] {
  const into = plan.returnTo === "same" ? "the same range" : "a range of the same width around the price";
  return (["down", "up"] as LaneId[])
    .filter((id) => live(plan.back[id]))
    .map((id) => `${describeWhen(p, id, plan.back[id])}: come back into ${into}.`);
}

// ---------------------------------------------------------------- templates

export type Template = {
  id: string;
  name: string;
  hint: string;
  /** null when this pool cannot use the template (no pool to park in, say). */
  build: (p: Pool, price: number, range: [number, number]) => Rules | null;
};

const exitTo = (to: "base" | "quote" | null): Action[] => [{ kind: "withdraw", pct: 100 }, ...(to ? [{ kind: "convert" as const, to }] : [])];
const leave = (bufferPct = 0): Trigger => ({ kind: "leave", bufferPct });

export const TEMPLATES: Template[] = [
  {
    id: "otherPool",
    name: "Move to another pool while out of range",
    hint: "Below the range: move the money into another pool; come back once the price is 1% back inside the range",
    build: (p) => {
      const q = defaultPark(p);
      if (!q) return null;
      return {
        down: { trigger: leave(), actions: [{ kind: "move" }], repeat: false },
        up: emptyLane(),
        plan: { where: "park", parkPool: q.index, parkWidthPct: defaultWidthPct(q), returnTo: "same", back: { down: emptyLane(), up: moveLane({ kind: "price", backIn: true, bufferPct: 1 }) } },
      };
    },
  },
  {
    id: "waitReenter",
    name: "Hold a token, come back on a turn",
    hint: "Out of range: hold one token; come back centred on the price after a 10% turn",
    build: () => ({
      down: { trigger: leave(), actions: [{ kind: "move", to: "quote" }], repeat: false },
      up: { trigger: leave(), actions: [{ kind: "move", to: "base" }], repeat: false },
      plan: {
        where: "wait",
        returnTo: "recentre",
        back: { down: moveLane({ kind: "trail", trailPct: 10 }), up: moveLane({ kind: "trail", trailPct: 10 }) },
      },
    }),
  },
  {
    id: "takeProfit",
    name: "Take profit",
    hint: "Withdraw when the price rises out of range",
    build: () => ({ down: emptyLane(), up: { trigger: leave(), actions: exitTo(null), repeat: false } }),
  },
  {
    id: "stopLoss",
    name: "Stop loss",
    hint: "Exit to the stable token if the price falls",
    build: () => ({ down: { trigger: leave(), actions: exitTo("quote"), repeat: false }, up: emptyLane() }),
  },
  {
    id: "confirmedStop",
    name: "Confirmed stop loss",
    hint: "Exit only if the price stays below the range for 30 minutes in a row",
    build: () => ({ down: { trigger: leave(), actions: exitTo("quote"), repeat: false, holdMinutes: 30 }, up: emptyLane() }),
  },
  {
    id: "trailingStop",
    name: "Trailing stop",
    hint: "Exit to the stable token if the price falls 5% from its high",
    build: () => ({ down: { trigger: { kind: "trail", trailPct: 5 }, actions: exitTo("quote"), repeat: false }, up: emptyLane() }),
  },
  {
    id: "follow",
    name: "Auto re-range",
    hint: "Re-centre the range around the price whenever it leaves",
    build: () => ({
      down: { trigger: leave(1), actions: [{ kind: "follow", widthPct: 5 }], repeat: true },
      up: { trigger: leave(1), actions: [{ kind: "follow", widthPct: 5 }], repeat: true },
    }),
  },
  {
    id: "compound",
    name: "Auto-compound",
    hint: "Reinvest fees every day",
    build: () => ({ down: emptyLane(), up: { trigger: { kind: "timer", hours: 24 }, actions: [{ kind: "readd" }], repeat: true } }),
  },
  {
    id: "compoundFees",
    name: "Compound when fees add up",
    hint: "Reinvest once fees reach 0.5% of the position",
    build: () => ({ down: emptyLane(), up: { trigger: { kind: "fees", feesPct: 0.5 }, actions: [{ kind: "readd" }], repeat: true } }),
  },
  {
    id: "aprExit",
    name: "Leave when fees dry up",
    hint: "Withdraw if the position earns less than 5% a year",
    build: (p) => {
      const lane: Lane = { trigger: { kind: "apr", aprPct: 5 }, actions: exitTo(null), repeat: false };
      return contractSide(p, "down") === "lower" ? { down: lane, up: emptyLane() } : { down: emptyLane(), up: lane };
    },
  },
  {
    id: "ladder",
    name: "Take profit in steps",
    hint: "Withdraw 25% every 5% up, at most 4 times",
    build: (p, price, range) => ({
      down: emptyLane(),
      up: { trigger: { kind: "price", price: outside(p, price, range, "up", 5) }, actions: [{ kind: "withdraw", pct: 25 }], repeat: true, stepPct: 5, maxRuns: 4 },
    }),
  },
  {
    id: "bracket",
    name: "Exit both ways",
    hint: "Take profit above, stop loss below",
    build: (p, price, range) => ({
      down: { trigger: { kind: "price", price: outside(p, price, range, "down", 10) }, actions: exitTo("quote"), repeat: false },
      up: { trigger: { kind: "price", price: outside(p, price, range, "up", 10) }, actions: exitTo(null), repeat: false },
    }),
  },
];

/** A price `pct`% away from now in the lane's direction, and at least 2% past the range's edge (a level inside the
 * range would fire at once). */
export function outside(p: Pool, price: number, range: [number, number] | undefined, lane: LaneId, pct: number): number {
  const away = price * (lane === "down" ? 1 - pct / 100 : 1 + pct / 100);
  if (!range || range[0] === range[1]) return away;
  const [lo, hi] = [priceAtTick(p, range[0]), priceAtTick(p, range[1])].sort((a, b) => a - b);
  return lane === "down" ? Math.min(away, lo * 0.98) : Math.max(away, hi * 1.02);
}

/** Sensible defaults for a new condition, so nobody has to type every value. Price levels start outside the range. */
export function defaultTrigger(kind: TriggerKind, p: Pool, lane: LaneId, price: number, otherPools: Pool[], range?: [number, number]): Trigger {
  switch (kind) {
    case "leave":
      return { kind, bufferPct: 0 };
    case "price":
      return { kind, price: outside(p, price, range, lane, 5) };
    case "otherPool":
      return { kind, price: lane === "down" ? price * 0.95 : price * 1.05, poolIndex: otherPools[0]?.index ?? p.index };
    case "chainlink":
      return { kind, price: outside(p, price, range, lane, 5) };
    case "trail":
      return { kind, trailPct: 5 };
    case "fees":
      return { kind, feesPct: 0.5 };
    case "apr":
      return { kind, aprPct: 5 };
    case "timer":
      return { kind, hours: 24 };
    case "card":
      return { kind };
  }
}

export function defaultAction(kind: ActionKind): Action {
  switch (kind) {
    case "withdraw":
      return { kind, pct: 100 };
    case "convert":
      return { kind, to: "quote" };
    case "follow":
      return { kind, widthPct: 5 };
    default:
      return { kind };
  }
}

// ---------------------------------------------------------------- contract calls

const expiryOf = (adv: Advanced) => Math.floor(Date.now() / 1000) + Math.max(1, Math.round(adv.expiryDays)) * 86400;
/** maxSlippage is kept in steps of 0.1% (uint8): 0.1% to 25.5%. */
const slippageOf = (adv: Advanced) => Math.min(255, Math.max(1, Math.round(adv.slippagePct * 10)));

/** The argument of ConditionalOrders.createOrder. */
export function createParams(
  p: Pool,
  range: [number, number],
  amounts: { liquidity: bigint; amount0Max: bigint; amount1Max: bigint },
  adv: Advanced,
  r: Rules,
) {
  const enc = encodeRules(p, r, range);
  return {
    key: p.key,
    tickLower: range[0],
    tickUpper: range[1],
    ...amounts,
    expiry: expiryOf(adv),
    keeperFeeBps: Math.min(100, Math.max(0, Math.round(adv.keeperFeeBps))),
    maxSlippage: slippageOf(adv),
    lower: enc.lower,
    upper: enc.upper,
    home: enc.home,
    away: enc.away,
    awayLower: enc.awayLower,
    awayUpper: enc.awayUpper,
    condition: conditionOf(r) ?? ZERO_ADDRESS,
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** The argument of ConditionalOrders.updateOrder: new rules for the live leg. */
export function updateParams(home: Pool, r: Rules, liveIsHome: boolean, adv: Advanced, range?: [number, number]) {
  const enc = encodeLive(home, r, liveIsHome, range);
  return {
    expiry: expiryOf(adv),
    keeperFeeBps: Math.min(100, Math.max(0, Math.round(adv.keeperFeeBps))),
    maxSlippage: slippageOf(adv),
    lower: enc.lower,
    upper: enc.upper,
    condition: conditionOf(r) ?? ZERO_ADDRESS,
  };
}
