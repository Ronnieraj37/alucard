// Parity between the rule editor (lib/rules.ts), the contract and the backtest engine. Called by
// test/EditorParity.t.sol through forge's ffi; prints ABI-encoded data for the Solidity test to decode.
//
//   npx tsx scripts/parity.ts count              number of acceptance cases
//   npx tsx scripts/parity.ts sides <from> <n>   acceptance cases: (Side[] lower, Side[] upper, bool[] editorCanBuild)
//   npx tsx scripts/parity.ts engine <from> <n>  engine cases: what the backtest engine says each order does on
//                                                synthetic price paths, for the contract to replay
//   npx tsx scripts/parity.ts stats              human-readable summary
//
// "editorCanBuild" is decided by the editor's own code: a pair of sides counts only if decodeRules turns it into rules
// that validate() accepts and encodeRules turns those rules back into the same sides. Everything else must revert.
import { execFileSync } from "node:child_process";
import { encodeAbiParameters, type AbiParameter } from "viem";
import { conditionalOrdersAbi } from "../lib/generated/abis";
import { POOLS, type Pool } from "../lib/pools";
import { type Action, type Lane, type Rules, type Side, type Trigger, TEMPLATES, decodeRules, encodeRules, isValid, validate, withAction, emptyLane } from "../lib/rules";

// ---------------------------------------------------------------- the pools of test/EditorParity.t.sol

const T0 = "0x0000000000000000000000000000000000000a00" as const;
const T1 = "0x0000000000000000000000000000000000000b00" as const;
// The contract has no idea which token people think of as the base; the editor does ("if WETH falls"), and maps
// falls/rises to the lower/upper side by it. So every acceptance case is built in both orientations.
const mk = (index: number, fee: number, tickSpacing: number, hooked: boolean, baseIs0: boolean): Pool => {
  const token0 = { symbol: baseIs0 ? "WETH" : "USDC", address: T0, decimals: 18 };
  const token1 = { symbol: baseIs0 ? "USDC" : "WETH", address: T1, decimals: 18 };
  return {
    name: `P${index}`,
    index,
    key: { currency0: T0, currency1: T1, fee, tickSpacing, hooks: hooked ? "0x0000000000000000000000000000000000004444" : "0x0000000000000000000000000000000000000000" },
    token0,
    token1,
    base: baseIs0 ? token0 : token1,
    quote: baseIs0 ? token1 : token0,
    baseIs0,
    hooked,
    label: `WETH / USDC · ${fee / 10_000}%`,
  };
};
let OWN = mk(1, 3000, 60, true, true); // the order's pool: RuleSetup's poolKey
const orient = (baseIs0: boolean) => {
  OWN = mk(1, 3000, 60, true, baseIs0);
  POOLS.splice(0, POOLS.length, OWN, mk(2, 500, 10, false, baseIs0)); // #2: a hookless pool of the same pair
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
    { kind: "oracle", price: down ? 0.95 : 1.05 },
    { kind: "timer", hours: 1 },
    { kind: "timer", hours: 0.5 },
    { kind: "trail", trailPct: 3 },
  ];
}

/** Every set of steps the editor's withAction can produce (it adds and removes what each step needs). */
function actionSets(): Action[][] {
  const blocks: Action[][] = [
    [],
    [{ kind: "collect" }],
    [{ kind: "withdraw", pct: 25 }],
    [{ kind: "withdraw", pct: 100 }],
    [{ kind: "convert", to: "quote" }],
    [{ kind: "convert", to: "base" }],
    [{ kind: "readd" }],
    [{ kind: "follow", widthPct: 5 }],
  ];
  const seen = new Map<string, Action[]>();
  // every ordered sequence of up to three blocks, run through withAction like the editor does
  const rec = (lane: Lane, depth: number) => {
    const k = JSON.stringify(lane.actions);
    if (lane.actions.length) seen.set(k, lane.actions);
    if (depth === 3) return;
    for (const b of blocks) for (const a of b) rec(withAction(lane, a), depth + 1);
  };
  rec(off(), 0);
  return [...seen.values()];
}

type Flow = { repeat: boolean; maxRuns?: number; holdMinutes?: number };
const FLOWS: Flow[] = [
  { repeat: false },
  { repeat: false, holdMinutes: 15 },
  { repeat: true },
  { repeat: true, maxRuns: 3 },
  { repeat: true, holdMinutes: 15 },
  { repeat: true, maxRuns: 2, holdMinutes: 5 },
];

function lanesFor(lane: "down" | "up"): Lane[] {
  const out: Lane[] = [];
  const trig = triggersFor(lane);
  const second: (Trigger | null)[] = [null, ...trig];
  for (const t of trig)
    for (const t2 of second)
      for (const combine of t2 ? (["and", "or"] as const) : ([undefined] as const))
        for (const actions of actionSets())
          for (const f of FLOWS) {
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

// ---------------------------------------------------------------- can the editor build these sides?

const NUMERIC_TOLERANCE = new Set(["value", "value2", "shape"]); // display rounding when decoding (2 decimals of %)

function sameSide(a: Side, b: Side): boolean {
  for (const k of Object.keys(a) as (keyof Side)[]) {
    const x = a[k];
    const y = b[k];
    // zero means "unused" for these fields, so it never matches a non-zero value
    if (typeof x === "number" && typeof y === "number" && NUMERIC_TOLERANCE.has(k) && x !== 0 && y !== 0) {
      // widths of a re-range are small integers; levels and steps are ticks
      if (Math.abs(x - y) > Math.max(1, Math.abs(x) * 0.0005)) return false;
      // the shape field packs two widths: both halves must match on their own
      if (k === "shape" && ((x >> 11) === 0) !== ((y >> 11) === 0)) return false;
      if (k === "shape" && ((x & 2047) === 0) !== ((y & 2047) === 0)) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** The numeric domain the editor's encoder can produce for one condition (it never writes other values). */
function condInDomain(checker: number, value: number, pool: number): boolean {
  if (checker === 1) return value >= 0 && pool === 0;
  if (checker === 2) return Math.abs(value) < 887_272 && (pool === 0 || pool === 2);
  if (checker === 3) return value >= 1 && pool === 0;
  if (checker === 4) return value >= 1 && value <= 92_108 && pool === 0;
  if (checker === 5) return Math.abs(value) < 887_272 && pool === 0; // the pair's Chainlink price: own pair only
  return false;
}

function editorCanBuild(lower: Side, upper: Side): boolean {
  for (const s of [lower, upper]) {
    if (s.checker !== 0 && !condInDomain(s.checker, s.value, s.checkPool)) return false;
    if (s.combine !== 0 && !condInDomain(s.checker2, s.value2, s.checkPool2)) return false;
    if (s.shape < 0 || s.shape > 4_194_303 || s.holdMinutes > 65_535 || s.runsLeft > 127) return false;
    // a repeating Follow sits next to the price: the editor never writes a distance under one tick spacing (it raises
    // it), so a smaller one is not something it builds, even though it is within the rounding tolerance below
    const follows = (s.actions & 8) !== 0 && s.addMode === 1;
    if (follows && s.repeat && s.checker === 1 && s.value < OWN.key.tickSpacing) return false;
  }
  let rules: Rules;
  try {
    rules = decodeRules(OWN, lower, upper);
  } catch {
    return false;
  }
  if (!isValid(validate(OWN, rules))) return false;
  const again = encodeRules(OWN, rules);
  return sameSide(again.lower, lower) && sameSide(again.upper, upper);
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
  checker: [0, 1, 2, 3, 4, 5, 6, 63],
  value: [-1, 0, 1, 59, 60, 61, 120, 300, -300, 488, 92_108, 92_109, 887_271, -887_271],
  checkPool: [0, 0, 1, 2, 3],
  actions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  removeBps: [0, 1, 2500, 9999, 10_000, 10_001],
  swapToToken1: [false, true],
  addMode: [0, 1, 2, 3],
  repeat: [false, true],
  shape: [0, 1, 9, 9 << 11, 9 | (9 << 11), 488, 4_194_303],
  lastRun: [0, 0, 0, 1_790_000_000],
  checker2: [0, 1, 2, 3, 4, 5, 6],
  value2: [-1, 0, 1, 60, 300, -300, 30, 92_109],
  checkPool2: [0, 0, 1, 2, 3],
  combine: [0, 1, 2, 3],
  holdMinutes: [0, 0, 1, 15, 65_535],
  armedAt: [0, 0, 0, 1_790_000_000],
  best: [0, 0, 0, 5],
  runsLeft: [0, 0, 1, 3, 127],
};
const FIELDS = Object.keys(FIELD_VALUES) as (keyof Side)[];

function mutate(s: Side, n: number): Side {
  const out = { ...s } as Record<string, number | boolean>;
  for (let i = 0; i < n; i++) {
    const f = pick(FIELDS);
    out[f] = pick(FIELD_VALUES[f]);
  }
  return out as unknown as Side;
}

type Case = { lower: Side; upper: Side; ok: boolean };

let ACCEPTANCE: { cases: Case[]; valid: number; lanes: number } | null = null;

/** Both orientations, base = token0 first, then base = token1. */
function acceptanceCases(): { cases: Case[]; valid: number; lanes: number } {
  if (ACCEPTANCE) return ACCEPTANCE;
  const a = acceptanceFor(true);
  const b = acceptanceFor(false);
  orient(true);
  ACCEPTANCE = { cases: [...a.cases, ...b.cases], valid: a.valid + b.valid, lanes: a.lanes + b.lanes };
  return ACCEPTANCE;
}

function acceptanceFor(baseIs0: boolean): { cases: Case[]; valid: number; lanes: number } {
  orient(baseIs0);
  seed = baseIs0 ? 0x2545f491 : 0x7f4a7c15;
  const seen = new Set<string>();
  const cases: Case[] = [];
  const add = (lower: Side, upper: Side) => {
    const key = JSON.stringify([lower, upper]);
    if (seen.has(key)) return;
    seen.add(key);
    cases.push({ lower, upper, ok: editorCanBuild(lower, upper) });
  };
  let lanes = 0;
  const validEncodings: { lower: Side; upper: Side }[] = [];
  for (const lane of ["down", "up"] as const) {
    for (const l of lanesFor(lane)) {
      lanes++;
      const r = rulesOf(lane, l);
      const enc = encodeRules(OWN, r);
      if (isValid(validate(OWN, r))) {
        if (!editorCanBuild(enc.lower, enc.upper)) throw new Error(`editor cannot read back its own rule: ${JSON.stringify(l)}`);
        validEncodings.push(enc);
      }
      add(enc.lower, enc.upper); // invalid lanes too: what the encoder writes for them must revert
    }
  }
  // every template, at this pool's price
  for (const t of TEMPLATES) {
    const r = t.build(OWN, 1);
    const enc = encodeRules(OWN, r);
    if (!isValid(validate(OWN, r)) || !editorCanBuild(enc.lower, enc.upper)) throw new Error(`template ${t.id} is not valid`);
    validEncodings.push(enc);
    add(enc.lower, enc.upper);
  }
  // both lanes at once (a sample of pairs)
  const downs = validEncodings.filter((e) => e.lower.checker !== 0 || e.upper.checker !== 0);
  for (let i = 0; i < 1500; i++) {
    const a = pick(downs);
    const b = pick(downs);
    add(a.lower.checker ? a.lower : b.lower, b.upper.checker ? b.upper : a.upper);
  }
  // mutations of rules the editor builds: one, two or three fields changed
  for (let i = 0; i < 6000; i++) {
    const e = pick(validEncodings);
    const n = 1 + Math.floor(rnd() * 3);
    if (rnd() < 0.5) add(mutate(e.lower, n), e.upper);
    else add(e.lower, mutate(e.upper, n));
  }
  return { cases, valid: validEncodings.length, lanes };
}

// ---------------------------------------------------------------- engine cases

type Path = { ts: number[]; ticks: number[] };

function paths(): Path[] {
  const out: Path[] = [];
  const t0 = 1_790_000_000; // RuleSetup's start time
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
  // (every path is longer than a day: the engine starts a window at most a day before the data ends)
  mkPath(90, () => gauss() * 220, () => 600 + rnd() * 2100); // random walk
  mkPath(90, () => gauss() * 150, () => 600 + rnd() * 3000, 25); // drifting up
  mkPath(90, () => gauss() * 300, () => 600 + rnd() * 1800, -30); // drifting down, more volatile
  // a rise then a crash, with a wick back: holds and trails behave differently here
  const up = Array.from({ length: 30 }, (_, i) => i * 40);
  const crash = [1100, 600, 100, -400, -700, -650, -300, -900, -1300, -1250, -1400, -1600];
  const rest = Array.from({ length: 30 }, (_, i) => -1600 + Math.round(Math.sin(i / 2) * 300));
  const ticks = [...up, ...crash, ...rest];
  out.push({ ticks, ts: ticks.map((_, i) => t0 + i * 1500) });
  return out;
}

function engineLanes(): Rules[] {
  // everything the editor builds except swaps (the contract's own swap would move later prices, the replay's not) and
  // other pools (the synthetic path has one pool)
  const out: Rules[] = [];
  for (const lane of ["down", "up"] as const)
    for (const l of lanesFor(lane)) {
      if (l.actions.some((a) => a.kind === "convert")) continue;
      if (l.trigger?.kind === "otherPool" || l.trigger2?.kind === "otherPool") continue;
      const r = rulesOf(lane, l);
      if (isValid(validate(OWN, r))) out.push(r);
    }
  // one rule set per distinct encoding, then a fixed sample (the replay is slow), plus orders with both lanes
  const distinct = new Map<string, Rules>();
  for (const r of out) distinct.set(JSON.stringify(encodeRules(OWN, r)), r);
  seed = 0x1234567;
  const all = [...distinct.values()];
  const sample: Rules[] = [];
  for (let i = 0; i < ENGINE_SINGLE; i++) sample.push(all[Math.floor(rnd() * all.length)]);
  for (let i = 0; i < ENGINE_PAIRS; ) {
    const a = pick(all);
    const b = pick(all);
    const r = { down: a.down.trigger ? a.down : b.down, up: b.up.trigger ? b.up : a.up };
    if (isValid(validate(OWN, r))) {
      sample.push(r);
      i++;
    }
  }
  return sample;
}

// PARITY_ENGINE=3000 for a bigger sample (the default keeps `forge test` around a minute and a half)
const ENGINE_SINGLE = Number(process.env.PARITY_ENGINE ?? 800);
const ENGINE_PAIRS = Math.round(ENGINE_SINGLE / 4);

const sideParam = (conditionalOrdersAbi.find((f) => f.type === "function" && f.name === "createOrder")!.inputs[0] as unknown as { components: AbiParameter[] }).components.find(
  (c) => c.name === "lower",
)! as AbiParameter;

function engineCases(from: number, n: number) {
  const ps = paths();
  const rules = engineLanes();
  const jobs: { rules: Rules; path: number }[] = [];
  for (const r of rules) for (let p = 0; p < ps.length; p++) jobs.push({ rules: r, path: p });
  const slice = jobs.slice(from, from + n);
  const py = `${process.cwd()}/.venv/bin/python`; // npm run setup:api
  const out = execFileSync(py, ["-I", "scripts/parity_engine.py"], {
    input: JSON.stringify({ paths: ps, jobs: slice }),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const res: { ticks: [number, number]; sides: Record<"lower" | "upper", Record<string, number | boolean>>; swaps: number; events: [number, boolean][] }[] =
    JSON.parse(out);
  // the engine must encode exactly what the editor sends on-chain
  const lowers: Side[] = [];
  const uppers: Side[] = [];
  slice.forEach((j, i) => {
    const enc = encodeRules(OWN, j.rules);
    for (const name of ["lower", "upper"] as const) {
      const py_ = res[i].sides[name];
      for (const k of Object.keys(py_)) {
        if ((enc[name] as Record<string, unknown>)[k] !== py_[k]) {
          throw new Error(`engine encodes ${name}.${k} = ${py_[k]}, editor ${(enc[name] as Record<string, unknown>)[k]} for ${JSON.stringify(j.rules)}`);
        }
      }
    }
    lowers.push(enc.lower);
    uppers.push(enc.upper);
  });
  return {
    total: jobs.length,
    data: encodeAbiParameters(
      [
        { type: "uint32[][]" },
        { type: "int24[][]" },
        { ...sideParam, type: "tuple[]" } as AbiParameter,
        { ...sideParam, type: "tuple[]" } as AbiParameter,
        { type: "int24[]" },
        { type: "int24[]" },
        { type: "uint256[]" },
        { type: "uint256[]" },
        { type: "uint256[][]" },
      ],
      [
        ps.map((p) => p.ts),
        ps.map((p) => p.ticks),
        lowers,
        uppers,
        res.map((r) => r.ticks[0]),
        res.map((r) => r.ticks[1]),
        slice.map((j) => BigInt(j.path)),
        res.map((r) => BigInt(r.swaps)),
        res.map((r) => r.events.map(([k, up]) => (BigInt(k) << 1n) | (up ? 1n : 0n))),
      ],
    ),
  };
}

// ---------------------------------------------------------------- main

const [mode, a, b] = process.argv.slice(2);
if (mode === "count") {
  process.stdout.write(encodeAbiParameters([{ type: "uint256" }], [BigInt(acceptanceCases().cases.length)]));
} else if (mode === "sides") {
  const { cases } = acceptanceCases();
  const slice = cases.slice(Number(a), Number(a) + Number(b));
  process.stdout.write(
    encodeAbiParameters(
      [{ ...sideParam, type: "tuple[]" } as AbiParameter, { ...sideParam, type: "tuple[]" } as AbiParameter, { type: "bool[]" }],
      [slice.map((c) => c.lower), slice.map((c) => c.upper), slice.map((c) => c.ok)],
    ),
  );
} else if (mode === "engineCount") {
  const ps = paths().length;
  process.stdout.write(encodeAbiParameters([{ type: "uint256" }], [BigInt(engineLanes().length * ps)]));
} else if (mode === "engine") {
  process.stdout.write(engineCases(Number(a), Number(b)).data);
} else if (mode === "show") {
  // one acceptance case as the editor reads it, for debugging a mismatch
  const half = acceptanceFor(true).cases.length;
  const i = Number(a);
  const c = (i < half ? acceptanceFor(true).cases[i] : acceptanceFor(false).cases[i - half]);
  orient(i < half);
  const nz = (x: Side) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== 0 && v !== false));
  console.log(JSON.stringify({ ok: c.ok, lower: nz(c.lower), upper: nz(c.upper) }));
  const r = decodeRules(OWN, c.lower, c.upper);
  console.log(JSON.stringify(r));
  console.log(JSON.stringify(validate(OWN, r)));
} else if (mode === "engineJob") {
  // one engine job as JSON (rules + path), for debugging a mismatch in Python
  const ps = paths();
  const rules = engineLanes();
  const j = Number(a);
  console.log(JSON.stringify({ paths: ps, jobs: [{ rules: rules[Math.floor(j / ps.length)], path: j % ps.length }] }));
} else if (mode === "stats") {
  const { cases, valid, lanes } = acceptanceCases();
  console.log(`${lanes} lanes built with the editor's blocks, ${valid} valid`);
  console.log(`${cases.length} acceptance cases: ${cases.filter((c) => c.ok).length} the editor can build, ${cases.filter((c) => !c.ok).length} it cannot`);
  console.log(`${engineLanes().length} rule sets x ${paths().length} price paths for the engine replay`);
} else {
  console.error("usage: parity.ts count | sides <from> <n> | engineCount | engine <from> <n> | stats");
  process.exit(2);
}
