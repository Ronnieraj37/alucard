// The rule model the UI works with, and its translation to the contract's two sides.
//
// The UI talks about the BASE token's price ("if WETH falls"). The contract talks about ticks of token1 per token0
// ("lower side" fires when the tick falls). When the base token is token1 the two point opposite ways, so every
// mapping below goes through `contractSide`.

import { type Pool, pctForTicks, priceAtTick, poolByIndex, ticksForPct, tickAtPrice, fmt } from "./pools";

export type LaneId = "down" | "up"; // base price falls / rises

export type TriggerKind = "leave" | "price" | "otherPool" | "oracle" | "timer" | "trail";
export type Trigger = {
  kind: TriggerKind;
  bufferPct?: number; // leave: how far past the range edge
  price?: number; // price, otherPool, oracle: base price in quote
  poolIndex?: number; // otherPool
  hours?: number; // timer
  trailPct?: number; // trail: how far the price turns back from its best
};

export type ActionKind = "collect" | "withdraw" | "convert" | "readd" | "follow";
export type Action = {
  kind: ActionKind;
  pct?: number; // withdraw: % of the liquidity
  to?: "base" | "quote"; // convert
  widthPct?: number; // follow: width of the new range
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
  /** The condition must be true when the side is armed and still true this many minutes later. 0 / unset = no hold. */
  holdMinutes?: number;
  /** With repeat: switch the side off after this many runs. 0 / unset = no limit. */
  maxRuns?: number;
};
export type Rules = { down: Lane; up: Lane };

export type Advanced = { keeperFeeBps: number; slippagePct: number; expiryDays: number };
export const DEFAULT_ADVANCED: Advanced = { keeperFeeBps: 10, slippagePct: 1, expiryDays: 30 };

export const ACTION_ORDER: ActionKind[] = ["collect", "withdraw", "convert", "readd", "follow"];
export const emptyLane = (): Lane => ({ trigger: null, actions: [], repeat: false });
export const emptyRules = (): Rules => ({ down: emptyLane(), up: emptyLane() });

// Contract constants (OrderState.sol)
const CHECK = { OFF: 0, EDGE: 1, TICK: 2, TIME: 3, TRAIL: 4, ORACLE: 5 } as const;
/** A price level: the pool's price or the pair's Chainlink price against a fixed tick. A repeating level steps. */
const isLevel = (checker: number) => checker === CHECK.TICK || checker === CHECK.ORACLE;
const ACT = { KEEP_FEES: 1, REMOVE: 2, SWAP: 4, ADD: 8 } as const;
const COMBINE = { NONE: 0, AND: 1, OR: 2 } as const;
const ADD_SAME = 0;
const ADD_ONE_SIDED = 1;
export const MAX_RUNS = 127;
export const MAX_HOLD_MINUTES = 65_535;
/** OrderState.MAX_TRAIL: a 99.99% fall in ticks. */
export const MAX_TRAIL_TICKS = 92_108;
const MAX_TICK = 887_272;

export type Side = {
  edge: number;
  checker: number;
  value: number;
  checkPool: number;
  actions: number;
  removeBps: number;
  swapToToken1: boolean;
  addMode: number;
  repeat: boolean;
  shape: number;
  lastRun: number;
  checker2: number;
  value2: number;
  checkPool2: number;
  combine: number;
  holdMinutes: number;
  armedAt: number;
  best: number;
  runsLeft: number;
};

const offSide = (): Side => ({
  edge: 0,
  checker: 0,
  value: 0,
  checkPool: 0,
  actions: 0,
  removeBps: 0,
  swapToToken1: false,
  addMode: 0,
  repeat: false,
  shape: 0,
  lastRun: 0,
  checker2: 0,
  value2: 0,
  checkPool2: 0,
  combine: 0,
  holdMinutes: 0,
  armedAt: 0,
  best: 0,
  runsLeft: 0,
});

const isPrice = (t?: Trigger | null) => t?.kind === "price" || t?.kind === "otherPool" || t?.kind === "oracle";

/** Which contract side a lane uses: "up" (base rises) is the upper side when base is token0. */
export const contractSide = (p: Pool, lane: LaneId): "lower" | "upper" =>
  (lane === "up") === p.baseIs0 ? "upper" : "lower";

/** The pool one trigger reads: another pool for "price in another pool", else this one. */
export const watchedBy = (p: Pool, t?: Trigger | null): Pool =>
  t?.kind === "otherPool" && t.poolIndex ? poolByIndex(t.poolIndex) ?? p : p;

/** The pool whose price direction decides a lane's contract side: the first trigger that reads another pool. */
export const watched = (p: Pool, lane: Lane): Pool =>
  lane.trigger?.kind === "otherPool" ? watchedBy(p, lane.trigger) : lane.trigger2?.kind === "otherPool" ? watchedBy(p, lane.trigger2) : p;

/** Contract side a lane uses. A price check runs on the watched pool's ticks, so that pool's orientation decides. */
export const sideFor = (p: Pool, id: LaneId, lane: Lane) => contractSide(watched(p, lane), id);

export const has = (lane: Lane, k: ActionKind) => lane.actions.some((a) => a.kind === k);
export const get = (lane: Lane, k: ActionKind) => lane.actions.find((a) => a.kind === k);

/** Insert or replace an action, keeping the order the contract runs them in. Adds what an action needs. */
export function withAction(lane: Lane, a: Action): Lane {
  let actions = [...lane.actions.filter((x) => x.kind !== a.kind), a];
  if (a.kind === "convert" && !actions.some((x) => x.kind === "withdraw")) actions.push({ kind: "withdraw", pct: 100 });
  if (a.kind === "convert") actions = actions.filter((x) => x.kind !== "readd" && x.kind !== "follow");
  if (a.kind === "readd" || a.kind === "follow") {
    actions = actions.filter((x) => x.kind !== "convert" && (a.kind === "readd" ? x.kind !== "follow" : x.kind !== "readd"));
  }
  if (a.kind === "follow") actions = actions.filter((x) => x.kind !== "withdraw"); // follow moves everything
  actions.sort((x, y) => ACTION_ORDER.indexOf(x.kind) - ACTION_ORDER.indexOf(y.kind));
  return { ...lane, actions };
}

// ---------------------------------------------------------------- trailing distance <-> ticks

const LN = Math.log(1.0001);
/** Ticks for a base-price move of `pct`: a fall of x% (down lane) or a rise of x% (up lane). */
const ticksForMove = (pct: number, rise: boolean) =>
  Math.max(1, Math.round((rise ? Math.log(1 + pct / 100) : -Math.log(1 - Math.min(pct, 99.99) / 100)) / LN));
const pctForMove = (ticks: number, rise: boolean) => (rise ? Math.exp(ticks * LN) - 1 : 1 - Math.exp(-ticks * LN)) * 100;

// ---------------------------------------------------------------- encode / decode

type Cond = { checker: number; value: number; checkPool: number };

function encodeTrigger(p: Pool, laneId: LaneId, t: Trigger): Cond {
  if (t.kind === "leave") return { checker: CHECK.EDGE, value: ticksForPct(t.bufferPct ?? 0), checkPool: 0 };
  if (t.kind === "price" || t.kind === "otherPool") {
    return {
      checker: CHECK.TICK,
      value: Math.round(tickAtPrice(watchedBy(p, t), t.price ?? 0)),
      checkPool: t.kind === "otherPool" ? t.poolIndex ?? 0 : 0,
    };
  }
  // the pair's Chainlink price, as a tick of this pool: the same number a pool price level would use
  if (t.kind === "oracle") return { checker: CHECK.ORACLE, value: Math.round(tickAtPrice(p, t.price ?? 0)), checkPool: 0 };
  if (t.kind === "trail") return { checker: CHECK.TRAIL, value: ticksForMove(t.trailPct ?? 5, laneId === "up"), checkPool: 0 };
  return { checker: CHECK.TIME, value: Math.max(1, Math.round((t.hours ?? 24) * 60)), checkPool: 0 };
}

function encodeLane(p: Pool, lane: Lane, laneId: LaneId): Side {
  const s = offSide();
  if (!lane.trigger || lane.actions.length === 0) return s;
  const upper = sideFor(p, laneId, lane) === "upper";
  const follow = get(lane, "follow");
  const spacing = p.key.tickSpacing;

  Object.assign(s, encodeTrigger(p, laneId, lane.trigger));
  if (lane.trigger.kind === "leave" && follow && lane.repeat) s.value = Math.max(s.value, spacing); // the new range sits next to the price
  if (lane.trigger2) {
    const b = encodeTrigger(p, laneId, lane.trigger2);
    s.checker2 = b.checker;
    s.value2 = b.value;
    s.checkPool2 = b.checkPool;
    s.combine = lane.combine === "or" ? COMBINE.OR : COMBINE.AND;
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
    bits |= ACT.ADD | ACT.REMOVE;
    s.removeBps = 10_000;
    s.addMode = ADD_ONE_SIDED;
    const w = Math.max(1, Math.min(2047, Math.ceil(ticksForPct(follow.widthPct ?? 5) / spacing)));
    s.shape = upper ? w : w << 11; // upper side builds below the price, lower side above it
  }
  s.actions = bits;
  s.repeat = lane.repeat;
  const stepsA = isLevel(s.checker);
  const stepsB = !!lane.trigger2 && isLevel(s.checker2);
  // a repeating price level steps after each run; with Follow the shape field holds the new range's width instead
  if (lane.repeat && (stepsA || stepsB) && !follow) s.shape = ticksForPct(lane.stepPct ?? 5);
  s.holdMinutes = Math.max(0, Math.round(lane.holdMinutes ?? 0));
  s.runsLeft = lane.repeat ? Math.max(0, Math.round(lane.maxRuns ?? 0)) : 0;
  return s;
}

export function encodeRules(p: Pool, r: Rules): { lower: Side; upper: Side } {
  const out = { lower: offSide(), upper: offSide() };
  const live = (l: Lane) => !!l.trigger && l.actions.length > 0;
  if (live(r.down)) out[sideFor(p, "down", r.down)] = encodeLane(p, r.down, "down");
  if (live(r.up)) out[sideFor(p, "up", r.up)] = encodeLane(p, r.up, "up");
  return out;
}

function decodeTrigger(p: Pool, laneId: LaneId, checker: number, value: number, checkPool: number): Trigger {
  if (checker === CHECK.EDGE) return { kind: "leave", bufferPct: round2(pctForTicks(value)) };
  if (checker === CHECK.TICK) {
    const other = checkPool ? poolByIndex(checkPool) : undefined;
    return { kind: checkPool ? "otherPool" : "price", price: priceAtTick(other ?? p, value), poolIndex: checkPool || undefined };
  }
  if (checker === CHECK.ORACLE) return { kind: "oracle", price: priceAtTick(p, value) };
  if (checker === CHECK.TRAIL) return { kind: "trail", trailPct: round2(pctForMove(value, laneId === "up")) };
  return { kind: "timer", hours: round2(value / 60) };
}

function decodeSide(p: Pool, s: Side, upper: boolean, laneId: LaneId): Lane {
  const lane = emptyLane();
  if (s.checker === CHECK.OFF) return lane;
  lane.trigger = decodeTrigger(p, laneId, s.checker, s.value, s.checkPool);
  if (s.combine !== COMBINE.NONE && s.checker2 !== CHECK.OFF) {
    lane.trigger2 = decodeTrigger(p, laneId, s.checker2, s.value2, s.checkPool2);
    lane.combine = s.combine === COMBINE.OR ? "or" : "and";
  }

  const keep = (s.actions & ACT.KEEP_FEES) !== 0;
  const remove = (s.actions & ACT.REMOVE) !== 0;
  const add = (s.actions & ACT.ADD) !== 0;
  if (add && s.addMode === ADD_ONE_SIDED) {
    const w = upper ? s.shape & 2047 : (s.shape >> 11) & 2047;
    if (!keep) lane.actions.push({ kind: "collect" });
    lane.actions.push({ kind: "follow", widthPct: round2(pctForTicks(w * p.key.tickSpacing)) });
  } else {
    if (!keep) lane.actions.push({ kind: "collect" });
    if (remove && s.removeBps > 0) lane.actions.push({ kind: "withdraw", pct: s.removeBps / 100 });
    if (s.actions & ACT.SWAP) {
      const toToken1 = s.swapToToken1;
      const target = toToken1 ? p.token1 : p.token0;
      lane.actions.push({ kind: "convert", to: target.address === p.base.address ? "base" : "quote" });
    }
    if (add) lane.actions.push({ kind: "readd" });
  }
  lane.actions.sort((x, y) => ACTION_ORDER.indexOf(x.kind) - ACTION_ORDER.indexOf(y.kind));
  lane.repeat = s.repeat;
  const steps = isLevel(s.checker) || (lane.trigger2 && isLevel(s.checker2));
  if (s.repeat && steps && !(add && s.addMode === ADD_ONE_SIDED)) lane.stepPct = round2(pctForTicks(s.shape));
  if (s.holdMinutes) lane.holdMinutes = s.holdMinutes;
  if (s.repeat && s.runsLeft) lane.maxRuns = s.runsLeft;
  return lane;
}

export function decodeRules(p: Pool, lower: Side, upper: Side): Rules {
  const r = emptyRules();
  const laneOf = (s: Side, isUpper: boolean): LaneId => {
    const pool = s.checker === CHECK.TICK && s.checkPool ? s.checkPool : s.combine && s.checker2 === CHECK.TICK && s.checkPool2 ? s.checkPool2 : 0;
    const w = pool ? poolByIndex(pool) ?? p : p;
    return isUpper === w.baseIs0 ? "up" : "down";
  };
  let loLane = laneOf(lower, false);
  let upLane = laneOf(upper, true);
  if (lower.checker === CHECK.OFF) loLane = upLane === "up" ? "down" : "up";
  if (upper.checker === CHECK.OFF) upLane = loLane === "up" ? "down" : "up";
  if (loLane === upLane) {
    loLane = contractSide(p, "down") === "lower" ? "down" : "up";
    upLane = loLane === "down" ? "up" : "down";
  }
  r[loLane] = decodeSide(p, lower, false, loLane);
  r[upLane] = decodeSide(p, upper, true, upLane);
  return r;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- validation (mirrors ConditionalOrders._validateSide)

function triggerErrors(p: Pool, laneId: LaneId, t: Trigger, which: string): string[] {
  const e: string[] = [];
  if (t.kind === "timer" && !(Math.round((t.hours ?? 0) * 60) >= 1)) e.push(`The timer${which} needs at least 1 minute.`);
  if (t.kind === "leave" && !((t.bufferPct ?? 0) >= 0)) e.push(`The distance past the edge${which} cannot be negative.`);
  if (isPrice(t)) {
    if (!(t.price! > 0)) e.push(`Set the trigger price${which}.`);
    else if (Math.abs(Math.round(tickAtPrice(watchedBy(p, t), t.price!))) >= MAX_TICK) e.push(`The trigger price${which} is outside what Uniswap can price.`);
  }
  if (t.kind === "otherPool" && (!t.poolIndex || t.poolIndex === p.index)) e.push(`Choose another pool to watch${which}.`);
  if (t.kind === "trail") {
    const ok = t.trailPct! > 0 && (laneId === "up" || t.trailPct! < 100) && ticksForMove(t.trailPct!, laneId === "up") <= MAX_TRAIL_TICKS;
    if (!ok) e.push(`The trailing distance${which} must be above 0% (and a fall of less than 100%).`);
  }
  return e;
}

export function validate(p: Pool, r: Rules): { down: string[]; up: string[]; general: string[] } {
  const out = { down: [] as string[], up: [] as string[], general: [] as string[] };
  (["down", "up"] as LaneId[]).forEach((id) => {
    const lane = r[id];
    const e = out[id];
    if (!lane.trigger) {
      if (lane.actions.length) e.push("Add a trigger, or these steps never run.");
      return;
    }
    if (lane.actions.length === 0) e.push("Add at least one step after the trigger.");
    const t = lane.trigger;
    const t2 = lane.trigger2 ?? null;
    const moves = has(lane, "follow");
    e.push(...triggerErrors(p, id, t, ""));
    if (t2) e.push(...triggerErrors(p, id, t2, " (second condition)"));
    if (moves && t.kind !== "leave") e.push("“Follow the price” only works when the first condition is “Leaves range”.");
    if (moves && t2 && lane.combine === "or")
      e.push("“Follow the price” needs the price to have left the range: use “and” for the second condition, not “or”.");
    if (lane.repeat && t.kind === "leave" && !moves)
      e.push("Repeating this would fire again straight away, because the range does not move. Turn repeat off or use “Follow the price”.");
    if (t2 && lane.combine === "or" && lane.repeat && t2.kind === "leave" && !moves)
      e.push("With “or”, a repeating “Leaves range” condition would fire again straight away. Use “and”, or turn repeat off.");
    if (t2 && lane.combine === "or" && lane.repeat && isPrice(t2) && moves)
      e.push("With “or” and “Follow the price”, a repeating price level cannot move, so it would fire again straight away. Use “and”, or turn repeat off.");
    const priceLevel = isPrice(t) || isPrice(t2);
    if (lane.repeat && priceLevel && !moves && !(ticksForPct(lane.stepPct ?? 0) > 0))
      e.push("Set how far the trigger price moves after each run.");
    const trails = (t.kind === "trail" ? 1 : 0) + (t2?.kind === "trail" ? 1 : 0);
    if (trails > 1) e.push("Only one trailing stop per side.");
    const hold = lane.holdMinutes ?? 0;
    if (hold && trails) e.push("A trailing stop cannot also have a hold: they share one stored value.");
    if (hold && !(Number.isInteger(hold) && hold >= 1 && hold <= MAX_HOLD_MINUTES)) e.push(`The hold must be 1 to ${MAX_HOLD_MINUTES} whole minutes.`);
    const runs = lane.maxRuns ?? 0;
    if (runs && !lane.repeat) e.push("A run limit only applies when the side repeats.");
    if (runs && !(Number.isInteger(runs) && runs >= 1 && runs <= MAX_RUNS)) e.push(`The run limit must be 1 to ${MAX_RUNS}.`);
    // Both price conditions must point the same way on the contract's ticks.
    if (isPrice(t) && isPrice(t2) && watchedBy(p, t).baseIs0 !== watchedBy(p, t2).baseIs0)
      e.push("The two conditions watch pools whose prices are quoted the opposite way round. Pick pools with the same base token.");
    const w = get(lane, "withdraw");
    if (w && !(Math.round((w.pct ?? 0) * 100) >= 1 && w.pct! <= 100)) e.push("Withdraw must be between 0.01% and 100%.");
    if (has(lane, "convert") && !w) e.push("“Convert” needs a “Withdraw” step before it: there is nothing to convert otherwise.");
    if (has(lane, "convert") && (has(lane, "readd") || moves)) e.push("“Convert” cannot be followed by putting the tokens back in (that needs a swap to the right ratio, not built yet).");
    if (has(lane, "follow") && (w || has(lane, "readd"))) e.push("“Follow the price” already moves everything: remove the other steps.");
  });
  if (!r.down.trigger && !r.up.trigger) out.general.push("Add at least one trigger.");
  if (r.down.trigger && r.up.trigger && sideFor(p, "down", r.down) === sideFor(p, "up", r.up))
    out.general.push("These two triggers watch prices that move the opposite way and would need the same slot. Move one of them to the other lane.");
  return out;
}

export const isValid = (v: ReturnType<typeof validate>) => !v.down.length && !v.up.length && !v.general.length;

// ---------------------------------------------------------------- plain English

export function laneTitle(p: Pool, id: LaneId, lane?: Lane) {
  if (lane?.trigger?.kind === "timer" && (!lane.trigger2 || lane.trigger2.kind === "timer")) return "On a timer";
  const w = lane ? watched(p, lane) : p;
  return id === "down" ? `If ${w.base.symbol} falls` : `If ${w.base.symbol} rises`;
}

const every = (hours: number) =>
  hours < 1 ? `${Math.round(hours * 60)} min` : hours % 24 === 0 && hours >= 24 ? `${hours / 24} day${hours === 24 ? "" : "s"}` : `${hours} h`;

const minutesText = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

export function describeTrigger(p: Pool, id: LaneId, t: Trigger): string {
  const dir = id === "down" ? "below" : "above";
  switch (t.kind) {
    case "leave":
      return t.bufferPct ? `${p.base.symbol} moves ${t.bufferPct}% ${dir} my range` : `${p.base.symbol} leaves my range (${dir})`;
    case "price":
      return `${p.base.symbol} ${id === "down" ? "drops below" : "rises above"} ${fmt(t.price ?? 0)} ${p.quote.symbol}`;
    case "otherPool": {
      const other = t.poolIndex ? poolByIndex(t.poolIndex) : undefined;
      const w = other ?? p;
      return `${w.base.symbol} ${id === "down" ? "drops below" : "rises above"} ${fmt(t.price ?? 0)} ${w.quote.symbol} in ${other?.label ?? "another pool"}`;
    }
    case "oracle":
      return `${p.base.symbol} ${id === "down" ? "drops below" : "rises above"} ${fmt(t.price ?? 0)} ${p.quote.symbol} on Chainlink`;
    case "trail":
      return id === "down"
        ? `${p.base.symbol} falls ${t.trailPct}% from its highest price`
        : `${p.base.symbol} rises ${t.trailPct}% from its lowest price`;
    case "timer":
      return `every ${every(t.hours ?? 24)}`;
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
  if (lane.holdMinutes) when += `, and it is still true ${minutesText(lane.holdMinutes)} later`;
  return when;
}

export function describeAction(p: Pool, a: Action): string {
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
      return `move the range next to the new price (${a.widthPct}% wide)`;
  }
}

export function describeLane(p: Pool, id: LaneId, lane: Lane): string | null {
  if (!lane.trigger || !lane.actions.length) return null;
  const steps = lane.actions.map((a) => describeAction(p, a)).join(", then ");
  const limit = lane.maxRuns ? ` up to ${lane.maxRuns} time${lane.maxRuns === 1 ? "" : "s"}` : "";
  const priceLevel = isPrice(lane.trigger) || isPrice(lane.trigger2);
  const tail = lane.repeat
    ? priceLevel && !has(lane, "follow")
      ? `. Repeats${limit}, moving the trigger price ${lane.stepPct}% further each time.`
      : `. Repeats${limit}.`
    : ". Runs once.";
  return `${describeWhen(p, id, lane)}: ${steps}${tail}`;
}

// ---------------------------------------------------------------- templates

export type Template = { id: string; name: string; hint: string; build: (p: Pool, price: number) => Rules };

export const TEMPLATES: Template[] = [
  {
    id: "takeProfit",
    name: "Take profit",
    hint: "Withdraw when the price rises out of range",
    build: () => ({ down: emptyLane(), up: { trigger: { kind: "leave", bufferPct: 0 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false } }),
  },
  {
    id: "stopLoss",
    name: "Stop loss",
    hint: "Exit to the stable token if the price falls",
    build: () => ({
      down: {
        trigger: { kind: "leave", bufferPct: 0 },
        actions: [
          { kind: "withdraw", pct: 100 },
          { kind: "convert", to: "quote" },
        ],
        repeat: false,
      },
      up: emptyLane(),
    }),
  },
  {
    id: "confirmedStop",
    name: "Confirmed stop loss",
    hint: "Exit only if the price stays below the range for 30 minutes",
    build: () => ({
      down: {
        trigger: { kind: "leave", bufferPct: 0 },
        actions: [
          { kind: "withdraw", pct: 100 },
          { kind: "convert", to: "quote" },
        ],
        repeat: false,
        holdMinutes: 30,
      },
      up: emptyLane(),
    }),
  },
  {
    id: "trailingStop",
    name: "Trailing stop",
    hint: "Exit to the stable token if the price falls 5% from its high",
    build: () => ({
      down: {
        trigger: { kind: "trail", trailPct: 5 },
        actions: [
          { kind: "withdraw", pct: 100 },
          { kind: "convert", to: "quote" },
        ],
        repeat: false,
      },
      up: emptyLane(),
    }),
  },
  {
    id: "follow",
    name: "Auto re-range",
    hint: "Keep moving the range next to the price",
    build: () => ({
      down: { trigger: { kind: "leave", bufferPct: 1 }, actions: [{ kind: "follow", widthPct: 5 }], repeat: true },
      up: { trigger: { kind: "leave", bufferPct: 1 }, actions: [{ kind: "follow", widthPct: 5 }], repeat: true },
    }),
  },
  {
    id: "compound",
    name: "Auto-compound",
    hint: "Reinvest fees every day",
    build: () => ({ down: emptyLane(), up: { trigger: { kind: "timer", hours: 24 }, actions: [{ kind: "readd" }], repeat: true } }),
  },
  {
    id: "ladder",
    name: "Take profit in steps",
    hint: "Withdraw 25% every 5% up, at most 4 times",
    build: (p, price) => ({
      down: emptyLane(),
      up: { trigger: { kind: "price", price: price * 1.05 }, actions: [{ kind: "withdraw", pct: 25 }], repeat: true, stepPct: 5, maxRuns: 4 },
    }),
  },
  {
    id: "bracket",
    name: "Exit both ways",
    hint: "Take profit above, stop loss below",
    build: (p, price) => ({
      down: {
        trigger: { kind: "price", price: price * 0.9 },
        actions: [
          { kind: "withdraw", pct: 100 },
          { kind: "convert", to: "quote" },
        ],
        repeat: false,
      },
      up: { trigger: { kind: "price", price: price * 1.1 }, actions: [{ kind: "withdraw", pct: 100 }], repeat: false },
    }),
  },
];

/** Sensible defaults when a block is dropped, so nobody has to type every value. */
export function defaultTrigger(kind: TriggerKind, p: Pool, lane: LaneId, price: number, otherPools: Pool[]): Trigger {
  switch (kind) {
    case "leave":
      return { kind, bufferPct: 0 };
    case "price":
      return { kind, price: lane === "down" ? price * 0.95 : price * 1.05 };
    case "otherPool":
      return { kind, price: lane === "down" ? price * 0.95 : price * 1.05, poolIndex: otherPools[0]?.index ?? p.index };
    case "oracle":
      return { kind }; // the editor fills the level in from the Chainlink price once it has read it
    case "trail":
      return { kind, trailPct: 5 };
    case "timer":
      return { kind, hours: 24 };
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
