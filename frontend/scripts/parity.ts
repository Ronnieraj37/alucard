// Parity between the rule editor (lib/rules.ts), the contract and the backtest engine. Called by
// test/EditorParity.t.sol through forge's ffi; prints ABI-encoded data for the Solidity test to decode.
//
//   npx tsx scripts/parity.ts count              number of acceptance cases
//   npx tsx scripts/parity.ts cases <from> <n>   acceptance cases: (lower, upper, home, away, awayLower, awayUpper,
//                                                editorCanBuild)
//   npx tsx scripts/parity.ts engineCount        number of engine cases
//   npx tsx scripts/parity.ts engine <from> <n>  engine cases: what the backtest engine says each order does on
//                                                synthetic price paths, for the contract to replay
//   npx tsx scripts/parity.ts stats              human-readable summary
//
// "editorCanBuild" is decided by the editor's own code: an order counts only if decodeStrategy turns it into rules
// that validate() accepts and encodeRules turns those rules back into the same order. Everything else must revert.
// Leg widths are numbers the editor derives (the range's half width, a % for the parking range): the cases use the
// editor's own widths and invalid ones, not every valid number.
import { execFileSync } from "node:child_process";
import { encodeAbiParameters, type AbiParameter } from "viem";
import { POOLS, type Pool } from "../lib/pools";
import {
  type Action,
  type ChainPlan,
  type Lane,
  type PlanB,
  type Rules,
  type Trigger,
  TEMPLATES,
  decodeStrategy,
  emptyLane,
  sharedToken,
  contractValid,
  encodeRules,
  validate,
  withAction,
} from "../lib/rules";
import { type Leg, type Side, decodeSide, encodeSide, noLeg } from "../lib/side";

// ---------------------------------------------------------------- the pools of test/EditorParity.t.sol

const T0 = "0x0000000000000000000000000000000000000a00" as const;
const T1 = "0x0000000000000000000000000000000000000b00" as const;
const T2 = "0x0000000000000000000000000000000000000c00" as const; // above T1, like the test's third token
const HOOK = "0x0000000000000000000000000000000000004444" as const;
const RANGE: [number, number] = [-600, 600]; // the test's position
const ORACLE_START = 1_790_000_000; // RuleSetup creates the pool (and the hook starts its average) at this time

// The contract has no idea which token people think of as the base; the editor does ("if WETH falls"), and maps
// falls/rises to the lower/upper side by it. So every acceptance case is built in both orientations.
const tok = (symbol: string, address: `0x${string}`) => ({ symbol, address, decimals: 18 });
const mk = (index: number, c0: `0x${string}`, c1: `0x${string}`, fee: number, tickSpacing: number, hooked: boolean, s0: string, s1: string, baseIs0: boolean): Pool => {
  const token0 = tok(s0, c0);
  const token1 = tok(s1, c1);
  return {
    name: `P${index}`,
    index,
    key: { currency0: c0, currency1: c1, fee, tickSpacing, hooks: hooked ? HOOK : "0x0000000000000000000000000000000000000000" },
    token0,
    token1,
    base: baseIs0 ? token0 : token1,
    quote: baseIs0 ? token1 : token0,
    baseIs0,
    hooked,
    label: `${s0}/${s1} ${fee}`,
  };
};
let OWN!: Pool;
let PARK!: Pool;
const orient = (baseIs0: boolean) => {
  const [a, b] = baseIs0 ? ["WETH", "USDC"] : ["USDC", "WETH"];
  OWN = mk(1, T0, T1, 3000, 60, true, a, b, baseIs0); // RuleSetup's poolKey
  PARK = mk(4, T1, T2, 100, 1, true, b, "USDT", true); // shares T1 with the main pool
  POOLS.splice(
    0,
    POOLS.length,
    OWN,
    mk(2, T0, T1, 500, 10, true, a, b, baseIs0), // #2: a hook pool of the same pair
    mk(3, T0, T1, 100, 1, false, a, b, baseIs0), // #3: a hookless pool of the same pair (any pool can be used)
    PARK,
  );
};
orient(true);

// ---------------------------------------------------------------- every lane the editor can build

const off = (): Lane => emptyLane();

function triggersFor(lane: "down" | "up"): Trigger[] {
  const down = lane === "down";
  return [
    { kind: "leave", bufferPct: 0 },
    { kind: "leave", bufferPct: 1.5 },
    { kind: "price", price: down ? 0.97 : 1.03 },
    { kind: "otherPool", poolIndex: 2, price: down ? 0.96 : 1.04 },
    { kind: "otherPool", poolIndex: 3, price: down ? 0.96 : 1.04 }, // a hookless pool: any pool can be watched
    { kind: "timer", hours: 1 },
    { kind: "trail", trailPct: 3 },
    { kind: "fees", feesPct: 0.5 },
    { kind: "apr", aprPct: 5 },
  ];
}

/** Every set of steps the editor's withAction can produce (it adds and removes what each step needs). */
function actionSets(): Action[][] {
  const blocks: Action[] = [
    { kind: "collect" },
    { kind: "withdraw", pct: 25 },
    { kind: "withdraw", pct: 100 },
    { kind: "convert", to: "quote" },
    { kind: "convert", to: "base" },
    { kind: "readd" },
    { kind: "follow", widthPct: 5 },
  ];
  const seen = new Map<string, Action[]>();
  const rec = (lane: Lane, depth: number) => {
    const k = JSON.stringify(lane.actions);
    if (lane.actions.length) seen.set(k, lane.actions);
    if (depth === 3) return;
    for (const a of blocks) rec(withAction(lane, a), depth + 1);
  };
  rec(off(), 0);
  return [...seen.values()];
}

type Flow = { repeat: boolean; maxRuns?: number; holdMinutes?: number };
const FLOWS: Flow[] = [{ repeat: false }, { repeat: false, holdMinutes: 15 }, { repeat: true }, { repeat: true, maxRuns: 3 }, { repeat: true, maxRuns: 2, holdMinutes: 60 }];

function lanesFor(lane: "down" | "up"): Lane[] {
  const out: Lane[] = [];
  const trig = triggersFor(lane);
  const second: (Trigger | null)[] = [null, ...trig.filter((t) => t.kind !== "leave" || t.bufferPct === 0)];
  const acts = actionSets();
  for (const t of trig)
    for (const t2 of second)
      for (const combine of t2 ? (["and", "or"] as const) : ([undefined] as const))
        for (const actions of acts)
          for (const f of FLOWS) {
            // keep the product manageable: second conditions only with a few step sets
            if (t2 && actions.length > 1) continue;
            const l: Lane = { trigger: t, actions, repeat: f.repeat, stepPct: 5 };
            if (t2) {
              l.trigger2 = t2;
              l.combine = combine;
            }
            if (f.maxRuns) l.maxRuns = f.maxRuns;
            if (f.holdMinutes) l.holdMinutes = f.holdMinutes;
            out.push(l);
          }
  return out;
}

const rulesOf = (lane: "down" | "up", l: Lane): Rules => (lane === "down" ? { down: l, up: off() } : { down: off(), up: l });

/** Two-leg strategies: a lane that moves (hold a token, or into another pool), and its ways back. */
function plans(): Rules[] {
  const out: Rules[] = [];
  const backs: (Trigger | null)[] = [null, { kind: "price", price: 1.1 }, { kind: "price", price: 0.9 }, { kind: "trail", trailPct: 3 }, { kind: "timer", hours: 2 }, { kind: "fees", feesPct: 1 }];
  const homes: Trigger[] = [{ kind: "leave" }, { kind: "trail", trailPct: 4 }, { kind: "apr", aprPct: 3 }, { kind: "price", price: 0.9 }];
  for (const where of ["wait", "park"] as const)
    for (const returnTo of ["same", "recentre"] as const)
      for (const lane of ["down", "up"] as const)
        for (const ht of homes)
          for (const to of [undefined, "quote", "base"] as const)
            for (const bu of backs)
              for (const bd of [null, { kind: "timer", hours: 3 } as Trigger]) {
                if (where === "park" && to) continue; // a park sells into the shared token anyway
                const move: Lane = { trigger: ht, actions: [{ kind: "move", to }], repeat: false, maxRuns: bu?.kind === "timer" ? 2 : undefined };
                const plan: PlanB = {
                  where,
                  returnTo,
                  parkPool: where === "park" ? 4 : undefined,
                  parkWidthPct: where === "park" ? 0.3 : undefined,
                  back: { down: { trigger: bd, actions: [{ kind: "move" }], repeat: true }, up: { trigger: bu, actions: [{ kind: "move" }], repeat: true, holdMinutes: bu?.kind === "trail" ? 10 : undefined } },
                };
                out.push({ ...rulesOf(lane, move), plan });
              }
  return out;
}

// ---------------------------------------------------------------- can the editor build this order?

const NUMERIC_TOLERANCE = new Set(["value", "value2", "shape"]); // display rounding when decoding (2 decimals of %)

function sameSide(a: Side, b: Side): boolean {
  for (const k of Object.keys(a) as (keyof Side)[]) {
    const x = a[k];
    const y = b[k];
    // zero means "unused" for these fields, so it never matches a non-zero value
    if (typeof x === "number" && typeof y === "number" && NUMERIC_TOLERANCE.has(k) && x !== 0 && y !== 0) {
      if (Math.abs(x - y) > Math.max(1, Math.abs(x) * 0.0005)) return false;
      if (k === "shape" && (x >> 11 === 0) !== (y >> 11 === 0)) return false;
      if (k === "shape" && ((x & 2047) === 0) !== ((y & 2047) === 0)) return false;
    } else if (x !== y) return false;
  }
  return true;
}
const sameLeg = (a: Leg, b: Leg) =>
  a.kind === b.kind && a.poolIndex === b.poolIndex && Math.abs(a.a - b.a) <= Math.max(1, Math.abs(a.a) * 0.0005) && Math.abs(a.b - b.b) <= Math.max(1, Math.abs(a.b) * 0.0005);

/** The numeric domain the editor's encoder can produce for one condition (it never writes other values). */
function condInDomain(checker: number, value: number, pool: number): boolean {
  if (checker === 1) return value >= 0 && pool === 0;
  if (checker === 2) return Math.abs(value) < 887_272; // any pool: the editor and the contract decide
  if (checker === 3) return value >= 1 && pool === 0;
  if (checker === 4) return value >= 1 && value <= 92_108;
  // 5 (the retired Chainlink condition) is outside the domain: the contract refuses it, the editor never builds it
  if (checker === 6) return value >= 1 && value <= 10_000 && pool === 0;
  if (checker === 7) return value >= 1 && pool === 0;
  return false;
}

type Case = { lower: bigint; upper: bigint; home: Leg; away: Leg; awayLower: bigint; awayUpper: bigint; ok: boolean };

function sidesInDomain(words: bigint[]): boolean {
  for (const w of words) {
    if (w >> 254n) return false; // spare bits
    const s = decodeSide(w);
    if (encodeSide(s) !== w) return false; // not canonical
    if (s.checker !== 0 && !condInDomain(s.checker, s.value, s.checkPool)) return false;
    if (s.combine !== 0 && !condInDomain(s.checker2, s.value2, s.checkPool2)) return false;
  }
  return true;
}

function editorCanBuild(c: Omit<Case, "ok">): boolean {
  const twoLegs = c.away.kind !== 0;
  if (c.home.poolIndex !== 0) return false;
  if (!twoLegs && (c.home.kind || c.home.a || c.home.b || c.away.poolIndex || c.away.a || c.away.b || c.awayLower || c.awayUpper)) return false;
  if (twoLegs && c.home.kind !== 2 && c.home.kind !== 3) return false;
  if (!sidesInDomain([c.lower, c.upper])) return false;
  if (twoLegs && !sidesInDomain([c.awayLower, c.awayUpper])) return false;
  let rules: Rules;
  try {
    const plan: ChainPlan | undefined = twoLegs ? { here: { ...c.home, poolIndex: OWN.index }, there: c.away, thereLower: c.awayLower, thereUpper: c.awayUpper, held0: 0n, held1: 0n } : undefined;
    rules = decodeStrategy(OWN, OWN.index, c.lower, c.upper, plan).rules;
  } catch {
    return false;
  }
  if (!contractValid(validate(OWN, rules, RANGE))) return false;
  const again = encodeRules(OWN, rules, RANGE);
  return (
    sameSide(decodeSide(again.lower), decodeSide(c.lower)) &&
    sameSide(decodeSide(again.upper), decodeSide(c.upper)) &&
    sameSide(decodeSide(again.awayLower), decodeSide(c.awayLower)) &&
    sameSide(decodeSide(again.awayUpper), decodeSide(c.awayUpper)) &&
    sameLeg(again.home, c.home) &&
    sameLeg(again.away, c.away)
  );
}

// ---------------------------------------------------------------- acceptance cases

let seed = 0x2545f491;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

const FIELD_VALUES: Record<keyof Side, (number | boolean)[]> = {
  edge: [0, 0, 0, 60],
  checker: [0, 1, 2, 3, 4, 5, 6, 7, 8, 63],
  value: [-1, 0, 1, 59, 60, 61, 120, 300, -300, 488, 10_000, 10_001, 92_108, 92_109, 887_271, -887_271],
  checkPool: [0, 0, 1, 2, 3, 4, 5],
  actions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 22, 23, 24, 26, 31],
  removeBps: [0, 1, 2500, 9999, 10_000, 10_001],
  swapToToken1: [false, true],
  addMode: [0, 1, 2, 3],
  repeat: [false, true],
  shape: [0, 1, 9, 9 << 11, 9 | (9 << 11), 488, 4_194_303],
  lastRun: [0, 0, 0, 1_790_000_040],
  checker2: [0, 1, 2, 3, 4, 5, 6, 7],
  value2: [-1, 0, 1, 60, 300, -300, 30, 92_109],
  checkPool2: [0, 0, 1, 2, 3, 4],
  combine: [0, 1, 2, 3],
  holdMinutes: [0, 0, 1, 15, 60, 61, 65_535],
  best: [0, 0, 0, 5],
  runsLeft: [0, 0, 1, 3, 127],
};
const FIELDS = Object.keys(FIELD_VALUES) as (keyof Side)[];

function mutate(w: bigint, n: number): bigint {
  const out = decodeSide(w) as unknown as Record<string, number | boolean>;
  for (let i = 0; i < n; i++) {
    const f = pick(FIELDS);
    out[f] = pick(FIELD_VALUES[f]);
  }
  return encodeSide(out as unknown as Side);
}

/** Leg changes: the kinds and pools the editor builds, and invalid numbers (never other valid widths). */
function mutateLeg(l: Leg, home: boolean): Leg {
  const x = { ...l };
  const r = rnd();
  if (r < 0.3) x.kind = pick([0, 1, 2, 3, 4]);
  else if (r < 0.55) x.poolIndex = pick([0, 1, 2, 3, 4, 5]);
  else {
    const w = pick([0, -60, 61, 7, 92_160, -887_280]);
    x.a = w;
    x.b = home && x.kind === 2 ? 600 : w;
  }
  return x;
}

let ACCEPTANCE: { cases: Case[]; valid: number; lanes: number } | null = null;

/** Both orientations, base = token0 first, then base = token1. */
function acceptanceCases() {
  if (ACCEPTANCE) return ACCEPTANCE;
  const a = acceptanceFor(true);
  const b = acceptanceFor(false);
  orient(true);
  ACCEPTANCE = { cases: [...a.cases, ...b.cases], valid: a.valid + b.valid, lanes: a.lanes + b.lanes };
  return ACCEPTANCE;
}

type Enc = Omit<Case, "ok">;
const encOf = (r: Rules): Enc => {
  const e = encodeRules(OWN, r, RANGE);
  return { lower: e.lower, upper: e.upper, home: e.home, away: e.away, awayLower: e.awayLower, awayUpper: e.awayUpper };
};

function acceptanceFor(baseIs0: boolean) {
  orient(baseIs0);
  seed = baseIs0 ? 0x2545f491 : 0x7f4a7c15;
  const seen = new Set<string>();
  const cases: Case[] = [];
  const key = (c: Enc) => JSON.stringify(c, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const add = (c: Enc) => {
    const k = key(c);
    if (seen.has(k)) return;
    seen.add(k);
    cases.push({ ...c, ok: editorCanBuild(c) });
  };
  let lanes = 0;
  const valid: Enc[] = [];
  const keep = (r: Rules, what: string) => {
    lanes++;
    const e = encOf(r);
    if (contractValid(validate(OWN, r, RANGE))) {
      if (!editorCanBuild(e)) throw new Error(`editor cannot read back its own ${what}: ${JSON.stringify(r)}`);
      valid.push(e);
    }
    add(e); // invalid rules too: what the encoder writes for them must revert
  };
  for (const lane of ["down", "up"] as const) for (const l of lanesFor(lane)) keep(rulesOf(lane, l), "rule");
  for (const r of plans()) keep(r, "plan");
  for (const t of TEMPLATES) {
    const r = t.build(OWN, 1, RANGE);
    if (!r) continue;
    if (!contractValid(validate(OWN, r, RANGE))) throw new Error(`template ${t.id} is not valid`);
    keep(r, `template ${t.id}`);
  }
  // both lanes at once (a sample of pairs of one-leg rules)
  const singles = valid.filter((e) => e.away.kind === 0);
  for (let i = 0; i < 1500; i++) {
    const a = pick(singles);
    const b = pick(singles);
    add({ ...a, lower: decodeSide(a.lower).checker ? a.lower : b.lower, upper: decodeSide(b.upper).checker ? b.upper : a.upper });
  }
  // mutations of orders the editor builds: one, two or three fields changed
  for (let i = 0; i < 9000; i++) {
    const e = { ...pick(valid) };
    const n = 1 + Math.floor(rnd() * 3);
    const r = rnd();
    if (r < 0.3) e.lower = mutate(e.lower, n);
    else if (r < 0.6) e.upper = mutate(e.upper, n);
    else if (r < 0.7) e.awayLower = mutate(e.awayLower, n);
    else if (r < 0.8) e.awayUpper = mutate(e.awayUpper, n);
    else if (r < 0.9) e.away = mutateLeg(e.away, false);
    else e.home = mutateLeg(e.home, true);
    add(e);
  }
  return { cases, valid: valid.length, lanes };
}

// ---------------------------------------------------------------- engine cases

type Path = { ts: number[]; ticks: number[] };

function paths(): Path[] {
  const out: Path[] = [];
  const t0 = ORACLE_START + 200_000; // after test/EditorParity.t.sol's setUp (an hour, the 2-day feed timelock, an hour)
  const mkPath = (n: number, step: () => number, gap: () => number, drift = 0) => {
    const ts = [t0];
    const ticks = [0];
    for (let i = 1; i < n; i++) {
      ts.push(ts[i - 1] + Math.round(gap()));
      ticks.push(Math.max(-6000, Math.min(6000, Math.round(ticks[i - 1] + step() + drift))));
    }
    out.push({ ts, ticks });
  };
  seed = 0x9e3779b9;
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.7;
  mkPath(80, () => gauss() * 220, () => 300 + rnd() * 1500); // random walk
  mkPath(80, () => gauss() * 150, () => 300 + rnd() * 2000, 25); // drifting up
  mkPath(80, () => gauss() * 300, () => 300 + rnd() * 1200, -30); // drifting down, more volatile
  // a rise then a crash, with a wick back: averages and trails behave differently here
  const up = Array.from({ length: 30 }, (_, i) => i * 40);
  const crash = [1100, 600, 100, -400, -700, -650, -300, -900, -1300, -1250, -1400, -1600];
  const rest = Array.from({ length: 30 }, (_, i) => -1600 + Math.round(Math.sin(i / 2) * 300));
  const ticks = [...up, ...crash, ...rest];
  out.push({ ticks, ts: ticks.map((_, i) => t0 + i * 900) });
  return out;
}

function engineRules(): Rules[] {
  // everything the editor builds except swaps (the contract's own swap would move later prices, the replay's not),
  // other pools (the synthetic path has one pool) and fee conditions (the replay has no other traders paying fees)
  const skip = (t?: Trigger | null) => t?.kind === "otherPool" || t?.kind === "fees" || t?.kind === "apr";
  const out: Rules[] = [];
  for (const lane of ["down", "up"] as const)
    for (const l of lanesFor(lane)) {
      if (l.actions.some((a) => a.kind === "convert") || skip(l.trigger) || skip(l.trigger2)) continue;
      const r = rulesOf(lane, l);
      if (contractValid(validate(OWN, r, RANGE))) out.push(r);
    }
  // a move that holds the tokens, without a swap (moving into another pool needs a second pool's prices)
  for (const r of plans()) {
    const lanes = [r.down, r.up, r.plan!.back.down, r.plan!.back.up];
    if (r.plan!.where !== "wait" || lanes.some((l) => skip(l.trigger) || l.actions.some((a) => a.kind === "move" && a.to))) continue;
    if (contractValid(validate(OWN, r, RANGE))) out.push(r);
  }
  const distinct = new Map<string, Rules>();
  for (const r of out) distinct.set(JSON.stringify(encOf(r), (_, v) => (typeof v === "bigint" ? v.toString() : v)), r);
  seed = 0x1234567;
  const all = [...distinct.values()];
  const sample: Rules[] = [];
  for (let i = 0; i < ENGINE_SINGLE; i++) sample.push(all[Math.floor(rnd() * all.length)]);
  return sample;
}

// PARITY_ENGINE=2000 for a bigger sample (the default keeps `forge test` around a minute)
const ENGINE_SINGLE = Number(process.env.PARITY_ENGINE ?? 500);

const LEG_T: AbiParameter = {
  type: "tuple[]",
  components: [
    { name: "poolIndex", type: "uint24" },
    { name: "kind", type: "uint8" },
    { name: "a", type: "int24" },
    { name: "b", type: "int24" },
  ],
};

/** The order the editor sends, as the engine reads it (words as decimal strings, the shared token of a move). */
function orderJson(r: Rules) {
  const e = encOf(r);
  const park = r.plan?.where === "park" && r.plan.parkPool ? POOLS.find((q) => q.index === r.plan!.parkPool) : undefined;
  const shared = park ? sharedToken(OWN, park) : null;
  return {
    lower: e.lower.toString(),
    upper: e.upper.toString(),
    home: e.home,
    away: { ...e.away, shared },
    awayLower: e.awayLower.toString(),
    awayUpper: e.awayUpper.toString(),
  };
}

function engineCases(from: number, n: number) {
  const ps = paths();
  const rules = engineRules();
  const jobs: { rules: Rules; path: number }[] = [];
  for (const r of rules) for (let p = 0; p < ps.length; p++) jobs.push({ rules: r, path: p });
  const slice = jobs.slice(from, from + n);
  const py = `${process.cwd()}/.venv/bin/python`; // npm run setup:api
  const out = execFileSync(py, ["-I", "scripts/parity_engine.py"], {
    input: JSON.stringify({ paths: ps, oracleStart: ORACLE_START, range: RANGE, jobs: slice.map((j) => ({ order: orderJson(j.rules), path: j.path })) }),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const res: { swaps: number; events: [number, boolean][]; ratio: number }[] = JSON.parse(out);
  const encs = slice.map((j) => encOf(j.rules));
  return encodeAbiParameters(
    [
      { type: "uint32[][]" },
      { type: "int24[][]" },
      { type: "uint256[]" },
      { type: "uint256[]" },
      LEG_T,
      LEG_T,
      { type: "uint256[]" },
      { type: "uint256[]" },
      { type: "uint256[]" },
      { type: "uint256[]" },
      { type: "uint256[][]" },
      { type: "uint256[]" },
    ],
    [
      ps.map((p) => p.ts),
      ps.map((p) => p.ticks),
      encs.map((e) => e.lower),
      encs.map((e) => e.upper),
      encs.map((e) => e.home),
      encs.map((e) => e.away),
      encs.map((e) => e.awayLower),
      encs.map((e) => e.awayUpper),
      slice.map((j) => BigInt(j.path)),
      res.map((r) => BigInt(r.swaps)),
      res.map((r) => r.events.map(([k, up]) => (BigInt(k) << 1n) | (up ? 1n : 0n))),
      res.map((r) => BigInt(Math.round(r.ratio * 1e18))),
    ] as never,
  );
}

// ---------------------------------------------------------------- main

const [mode, a, b] = process.argv.slice(2);
if (mode === "count") {
  process.stdout.write(encodeAbiParameters([{ type: "uint256" }], [BigInt(acceptanceCases().cases.length)]));
} else if (mode === "cases") {
  const slice = acceptanceCases().cases.slice(Number(a), Number(a) + Number(b));
  process.stdout.write(
    encodeAbiParameters(
      [{ type: "uint256[]" }, { type: "uint256[]" }, LEG_T, LEG_T, { type: "uint256[]" }, { type: "uint256[]" }, { type: "bool[]" }],
      [
        slice.map((c) => c.lower),
        slice.map((c) => c.upper),
        slice.map((c) => c.home),
        slice.map((c) => c.away),
        slice.map((c) => c.awayLower),
        slice.map((c) => c.awayUpper),
        slice.map((c) => c.ok),
      ] as never,
    ),
  );
} else if (mode === "engineCount") {
  process.stdout.write(encodeAbiParameters([{ type: "uint256" }], [BigInt(engineRules().length * paths().length)]));
} else if (mode === "engine") {
  process.stdout.write(engineCases(Number(a), Number(b)));
} else if (mode === "show") {
  const { cases } = acceptanceCases();
  const c = cases[Number(a)];
  orient(Number(a) < cases.length / 2);
  const nz = (x: Side) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== 0 && v !== false));
  console.log(JSON.stringify({ ok: c.ok, lower: nz(decodeSide(c.lower)), upper: nz(decodeSide(c.upper)), home: c.home, away: c.away, awayLower: nz(decodeSide(c.awayLower)), awayUpper: nz(decodeSide(c.awayUpper)) }));
} else if (mode === "why") {
  // why the editor cannot build case <a>: its validation, and what it would encode instead
  const { cases } = acceptanceCases();
  const c = cases[Number(a)];
  orient(Number(a) < cases.length / 2);
  const twoLegs = c.away.kind !== 0;
  const plan: ChainPlan | undefined = twoLegs ? { here: { ...c.home, poolIndex: OWN.index }, there: c.away, thereLower: c.awayLower, thereUpper: c.awayUpper, held0: 0n, held1: 0n } : undefined;
  const rules = decodeStrategy(OWN, OWN.index, c.lower, c.upper, plan).rules;
  console.log(JSON.stringify(rules));
  console.log(JSON.stringify(validate(OWN, rules, RANGE)));
  const e = encodeRules(OWN, rules, RANGE);
  const nz = (x: bigint) => JSON.stringify(Object.fromEntries(Object.entries(decodeSide(x)).filter(([, v]) => v !== 0 && v !== false)));
  for (const k of ["lower", "upper", "awayLower", "awayUpper"] as const) if (e[k] !== c[k]) console.log(k, "was", nz(c[k]), "now", nz(e[k]));
  console.log("home", JSON.stringify(e.home), "away", JSON.stringify(e.away));
} else if (mode === "engineJob") {
  const ps = paths();
  const rules = engineRules();
  const j = Number(a);
  console.log(JSON.stringify({ paths: ps, oracleStart: ORACLE_START, range: RANGE, jobs: [{ order: orderJson(rules[Math.floor(j / ps.length)]), path: j % ps.length }] }));
} else if (mode === "stats") {
  const { cases, valid, lanes } = acceptanceCases();
  console.log(`${lanes} strategies built with the editor's blocks, ${valid} valid`);
  console.log(`${cases.length} acceptance cases: ${cases.filter((c) => c.ok).length} the editor can build, ${cases.filter((c) => !c.ok).length} it cannot`);
} else {
  console.error("usage: parity.ts count | cases <from> <n> | engineCount | engine <from> <n> | stats");
  process.exit(2);
}
void noLeg;
