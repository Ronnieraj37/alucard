"use client";

// The strategy editor. One layout everywhere: two columns, "If WETH falls" and "If WETH rises", each a short stack of
// cards read top to bottom (When → Then → …). A card opens in place to show its settings; the "Add" menu opens in
// place under the column it belongs to; the plain-words summary stays on the right (below, on a phone). Nothing
// slides in from the sides.

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Clock,
  Coins,
  Crosshair,
  GitMerge,
  Layers,
  LineChart as LineChartIcon,
  Link2,
  LogOut,
  MoveHorizontal,
  Percent,
  Plus,
  Repeat,
  RotateCcw,
  Shuffle,
  Target,
  Timer,
  Trash2,
  TrendingDown,
  TrendingUp,
  Undo2,
  Wallet,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import Backtest, { type BacktestRange } from "@/components/Backtest";
import { Field, Suffix } from "@/components/ui";
import { rulesAbi } from "@/lib/generated/abis";
import { CORE, type Pool, fmt, poolByIndex, priceAtTick } from "@/lib/pools";
import {
  type Action,
  type Advanced,
  type LaneId,
  type Lane,
  type PlanB,
  type Rules,
  type Trigger,
  type TriggerKind,
  type Validation,
  TEMPLATES,
  allErrors,
  backLaneOf,
  contractSide,
  defaultTrigger,
  defaultWidthPct,
  describeAction,
  describeLane,
  describeTrigger,
  emptyLane,
  get,
  has,
  isValid,
  laneTitle,
  newPlan,
  outside,
  parkable,
  sharedToken,
  validate,
  watchable,
  watchedBy,
  withAction,
} from "@/lib/rules";

// ---------------------------------------------------------------- what a card is

type CardId =
  | { lane: LaneId; part: "trigger" | "trigger2" | "hold" | "repeat" | "move" | "back" | "into" }
  | { lane: LaneId; part: "step"; kind: Action["kind"] };
const cardKey = (c: CardId) => `${c.lane}:${c.part}${"kind" in c ? `:${c.kind}` : ""}`;

/** One entry of the Add menu. Its label already names the tokens and direction of this column. */
type Option = { id: string; label: string; hint: string; icon: LucideIcon; apply: (r: Rules) => Rules; open?: CardId; second?: boolean; why?: string };


const ICONS: Record<string, LucideIcon> = {
  leave: LogOut,
  price: Target,
  trail: TrendingDown,
  timer: Clock,
  fees: Percent,
  apr: Coins,
  otherPool: Crosshair,
  withdraw: ArrowDownRight,
  convert: Shuffle,
  follow: MoveHorizontal,
  readd: Layers,
  collect: Wallet,
};
const TITLES: Record<string, string> = {
  leave: "Leaves my range",
  price: "Reaches a price",
  trail: "Turns from its best price",
  timer: "On a timer",
  fees: "Fees earned",
  apr: "Fee rate falls",
  otherPool: "Price in another pool",
  withdraw: "Withdraw",
  convert: "Swap",
  follow: "Follow the price",
  readd: "Compound",
  collect: "Send fees out",
};

// ---------------------------------------------------------------- moves

/** Add "move" to a lane, with a place to go and a way back if there is none yet. */
function addMove(p: Pool, r: Rules, lane: LaneId): Rules {
  const next: Rules = { ...r, [lane]: withAction(r[lane], { kind: "move" }) };
  const back = backLaneOf(lane);
  if (!next.plan) next.plan = newPlan(lane, p);
  else if (!next.plan.back[back].trigger) next.plan = { ...next.plan, back: { ...next.plan.back, [back]: { trigger: { kind: "price", backIn: true }, actions: [{ kind: "move" }], repeat: true } } };
  if (next.plan.where === "wait") next[lane] = withAction(next[lane], { kind: "move", to: lane === "down" ? "quote" : "base" });
  return next;
}

/** Remove a lane's move, its way back, and the place to go once nothing moves any more. */
function removeMove(r: Rules, lane: LaneId): Rules {
  const next: Rules = { ...r, [lane]: { ...r[lane], actions: r[lane].actions.filter((a) => a.kind !== "move") } };
  if (!next.plan) return next;
  const other: LaneId = lane === "down" ? "up" : "down";
  if (!has(next[other], "move")) delete next.plan;
  else next.plan = { ...next.plan, back: { ...next.plan.back, [backLaneOf(lane)]: emptyLane() } };
  return next;
}

// ---------------------------------------------------------------- the Add menu's options

function triggerOptions(pool: Pool, lane: LaneId, price: number, range: [number, number] | undefined, second: boolean): Option[] {
  const b = pool.base.symbol;
  const down = lane === "down";
  const set =
    (t: Trigger) =>
    (r: Rules): Rules => {
      const l = r[lane];
      if (second) return { ...r, [lane]: { ...l, trigger2: t, combine: l.combine ?? "and" } };
      return { ...r, [lane]: { ...l, trigger: t } };
    };
  const t = (k: TriggerKind) => defaultTrigger(k, pool, lane, price, watchable(pool), range);
  const part = second ? "trigger2" : "trigger";
  const list: Option[] = [
    { id: "leave", label: `${b} leaves my range ${down ? "below" : "above"}`, hint: "As soon as the price is out of your range", icon: LogOut, apply: set(t("leave")) },
    { id: "price", label: `${b} ${down ? "drops below" : "rises above"} a price`, hint: `A ${pool.quote.symbol} price you choose`, icon: Target, apply: set(t("price")) },
    {
      id: "trail",
      label: down ? `${b} falls a % from its highest price` : `${b} rises a % from its lowest price`,
      hint: down ? "A trailing stop: the high is remembered as it climbs" : "Waits for a turn up: the low is remembered as it falls",
      icon: down ? TrendingDown : TrendingUp,
      apply: set(t("trail")),
    },
    { id: "timer", label: "Every few hours or days", hint: "On a timer", icon: Clock, apply: set(t("timer")) },
    { id: "fees", label: "Fees reach a share of the position", hint: "When enough fees have built up", icon: Percent, apply: set(t("fees")) },
    { id: "otherPool", label: `${b} in another pool ${down ? "drops below" : "rises above"} a price`, hint: "Watch a bigger pool's price", icon: Crosshair, apply: set(t("otherPool")) },
  ];
  // "fee rate falls" uses the contract's lower slot: offer it in the lane that maps there
  if (contractSide(pool, lane) === "lower") list.push({ id: "apr", label: "Fees earn less than a yearly rate", hint: "Leave a pool that stopped paying", icon: Coins, apply: set(t("apr")) });
  return list.map((o) => ({ ...o, open: { lane, part } }));
}

function stepOptions(pool: Pool, rules: Rules, lane: LaneId): Option[] {
  const L = rules[lane];
  const b = pool.base.symbol;
  const q = pool.quote.symbol;
  const down = lane === "down";
  const add =
    (a: Action) =>
    (r: Rules): Rules => ({ ...r, [lane]: withAction(r[lane], a) });
  const withdrawn = has(L, "withdraw");
  const pools = parkable(pool);
  const out: Option[] = [
    {
      id: "move",
      label: pools.length ? "Move the money to another pool" : `Move the money and hold ${down ? q : b}`,
      hint: pools.length ? `Any pool sharing ${pool.token0.symbol} or ${pool.token1.symbol}, or hold one token; it comes back by itself` : "It comes back by itself",
      icon: Waypoints,
      apply: (r) => addMove(pool, r, lane),
      open: { lane, part: "move" },
    },
  ];
  if (!withdrawn) {
    out.push({ id: "withdraw", label: "Withdraw everything", hint: "To your wallet", icon: ArrowDownRight, apply: add({ kind: "withdraw", pct: 100 }), open: { lane, part: "step", kind: "withdraw" } });
    out.push({ id: "withdrawPart", label: "Withdraw part of it", hint: "25% to start; it can repeat, like a ladder", icon: ArrowDownRight, apply: add({ kind: "withdraw", pct: 25 }), open: { lane, part: "step", kind: "withdraw" } });
  }
  for (const to of down ? (["quote", "base"] as const) : (["base", "quote"] as const)) {
    const sym = to === "quote" ? q : b;
    out.push({
      id: `convert-${to}`,
      label: withdrawn ? `Swap it to ${sym}` : `Withdraw and swap to ${sym}`,
      hint: "Swapped at once, never worse than your slippage limit",
      icon: Shuffle,
      apply: add({ kind: "convert", to }),
      open: { lane, part: "step", kind: "convert" },
    });
  }
  out.push({ id: "follow", label: "Move the range next to the price", hint: "Re-range in the token you hold then", icon: MoveHorizontal, apply: add({ kind: "follow", widthPct: 5 }), open: { lane, part: "step", kind: "follow" } });
  out.push({ id: "readd", label: "Compound the fees", hint: "Put earned fees back into the range", icon: Layers, apply: add({ kind: "readd" }), open: { lane, part: "step", kind: "readd" } });
  out.push({ id: "collect", label: "Send the fees to my wallet", hint: "Instead of keeping them in", icon: Wallet, apply: add({ kind: "collect" }), open: { lane, part: "step", kind: "collect" } });
  // once all of it is withdrawn, nothing is left in the range to compound, follow or move
  const allOut = (get(L, "withdraw")?.pct ?? 0) >= 100;
  const after = new Set(["readd", "collect", "follow", "move"]);
  return out.filter((o) => !L.actions.some((a) => o.id.startsWith(a.kind) || (o.id === "withdrawPart" && a.kind === "withdraw")) && !(allOut && after.has(o.id)));
}

function moreOptions(rules: Rules, lane: LaneId): Option[] {
  const L = rules[lane];
  const out: Option[] = [];
  if (!L.trigger2) out.push({ id: "second", label: "And another condition", hint: "Both must be true, or either one", icon: GitMerge, apply: (r) => r, second: true });
  if (!L.holdMinutes)
    out.push({ id: "hold", label: "Only if it lasts", hint: "The condition must stay true for some minutes first", icon: Timer, apply: (r) => ({ ...r, [lane]: { ...r[lane], holdMinutes: 10 } }), open: { lane, part: "hold" } });
  const allOut = (get(L, "withdraw")?.pct ?? 0) >= 100;
  if (!L.repeat && !has(L, "move") && !allOut)
    out.push({ id: "repeat", label: "Repeat it", hint: "Run again the next time", icon: Repeat, apply: (r) => ({ ...r, [lane]: { ...r[lane], repeat: true, stepPct: r[lane].stepPct ?? 5 } }), open: { lane, part: "repeat" } });
  return out;
}

const laneProblems = (v: Validation, lane: LaneId) => [...v[lane], ...v.general, ...v.plan, ...v.backDown, ...v.backUp, ...v.advice];
/** Not a problem with a card, just the next thing to do: the "Then what?" button is right there. */
const NEXT_STEP = new Set(["Add a step after the condition."]);
const GENERIC = new Set(["Add a condition and a step on at least one side.", "Set when the money comes back."]);

// ---------------------------------------------------------------- editor

export type StrategyEditorProps = {
  pool: Pool;
  price: number;
  rangeLabel: string;
  amountsLabel?: string;
  initialRules: Rules;
  initialAdvanced: Advanced;
  saveLabel: string;
  busy?: boolean;
  /** The position's range relative to the current price, for backtests. */
  range?: BacktestRange;
  /** The position's range in ticks: checks the ways back and places default price levels outside it. */
  ticks?: [number, number];
  /** Editing an open position: where a move goes is fixed, and only the sides of where the money is now change. */
  existing?: { liveIsHome: boolean };
  onSave: (rules: Rules, advanced: Advanced) => void;
  onClose: () => void;
};

export default function StrategyEditor(p: StrategyEditorProps) {
  const { pool, price } = p;
  const [rules, setRules] = useState<Rules>(p.initialRules);
  const [advanced, setAdvanced] = useState<Advanced>(p.initialAdvanced);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ lane: LaneId; second?: boolean } | null>(null);
  const [backtest, setBacktest] = useState(false);
  const [template, setTemplate] = useState("");
  const v = useMemo(() => validate(pool, rules, p.ticks, { planLocked: !!p.existing }), [pool, rules, p.ticks, p.existing]);
  const empty = !rules.down.trigger && !rules.up.trigger;
  // An open position: where a move goes was set when it was created. While the money is moved, only the ways back change.
  const moved = !!p.existing && !p.existing.liveIsHome;
  const planLocked = !!p.existing;
  const backLocked = !!p.existing && p.existing.liveIsHome;
  const errors = allErrors(v);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (adding) setAdding(null);
      else if (open) setOpen(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [adding, open]);

  const setLane = useCallback((lane: LaneId, fn: (l: Lane) => Lane) => setRules((r) => ({ ...r, [lane]: fn(r[lane]) })), []);
  const setPlan = useCallback((fn: (pl: PlanB) => PlanB) => setRules((r) => (r.plan ? { ...r, plan: fn(r.plan) } : r)), []);

  const templateFor = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!.build(pool, price, p.ticks ?? [0, 0]);
    if (!t || (planLocked && (t.plan || rules.plan))) return null; // an open position keeps where its move goes
    return t;
  };
  const applyTemplate = (id: string) => {
    const t = id ? templateFor(id) : null;
    if (!t) return;
    if (!empty && !window.confirm("Replace the current strategy with this template?")) return;
    setRules(t);
    setTemplate(id);
    setOpen(null);
    setAdding(null);
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[var(--paper)]">
      {/* top bar */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--line)] bg-white px-3 sm:gap-3 sm:px-4">
        <button className="btn btn-light !px-2.5" onClick={p.onClose} aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Strategy · {pool.label}</div>
          <div className="truncate text-[11px] text-[var(--muted)]">
            Now 1 {pool.base.symbol} = {fmt(price)} {pool.quote.symbol} · range {p.rangeLabel}
          </div>
        </div>
        <select
          className="input hidden !w-auto max-w-[240px] !py-1.5 text-[13px] md:block"
          value={template}
          onChange={(e) => applyTemplate(e.target.value)}
          disabled={moved}
          aria-label="Start from a template"
        >
          <option value="">{template ? "Custom" : "Start from a template…"}</option>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id} disabled={!templateFor(t.id)}>
              {t.name}
            </option>
          ))}
        </select>
        {p.range && (
          <button className="btn btn-light !px-3" disabled={empty || !isValid(v)} onClick={() => setBacktest(true)} title="Replay a pool's real swap history with this strategy">
            <LineChartIcon className="h-4 w-4" />
            <span className="hidden sm:inline">Backtest</span>
          </button>
        )}
        <button className="btn btn-dark !px-4" disabled={p.busy || empty || !isValid(v)} onClick={() => p.onSave(rules, advanced)}>
          {p.saveLabel}
        </button>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-6 sm:px-6">
          {moved && (
            <Notice>
              The money is moved right now. You can change when it comes back; the position's own rules run again once it is back.
            </Notice>
          )}
          {/* template picker on small screens; the header already has it from md up */}
          <select className="input !py-2 text-[13px] md:hidden" value={template} onChange={(e) => applyTemplate(e.target.value)} disabled={moved}>
            <option value="">{template ? "Custom" : "Start from a template…"}</option>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id} disabled={!templateFor(t.id)}>
                {t.name}
              </option>
            ))}
          </select>

          {empty && !moved && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-[var(--muted)]">Or start from an example</span>
              {TEMPLATES.filter((t) => templateFor(t.id))
                .slice(0, 5)
                .map((t) => (
                  <button key={t.id} className="chip" onClick={() => applyTemplate(t.id)} title={t.hint}>
                    {t.name}
                  </button>
                ))}
            </div>
          )}
          <div className="grid items-start gap-x-6 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_340px]">
          {(["down", "up"] as LaneId[]).map((lane) => (
            <Column
              key={lane}
              lane={lane}
              pool={pool}
              price={price}
              rules={rules}
              v={v}
              ticks={p.ticks}
              rangeLabel={p.rangeLabel}
              open={open}
              setOpen={(k) => {
                setOpen(k);
                setAdding(null);
              }}
              adding={adding?.lane === lane ? adding : null}
              setAdding={setAdding}
              setRules={(fn) => {
                setRules(fn);
                setTemplate("");
              }}
              setLane={(l, fn) => {
                setLane(l, fn);
                setTemplate("");
              }}
              setPlan={(fn) => {
                setPlan(fn);
                setTemplate("");
              }}
              moved={moved}
              planLocked={planLocked}
              backLocked={backLocked}
            />
          ))}

          {/* summary: always on the right (below on a phone) */}
          <aside className="flex flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
            <section className="card p-4">
              <div className="label mb-3">In plain words</div>
              <div className="flex flex-col gap-3 text-[14px] leading-relaxed">
                {(["down", "up"] as LaneId[]).map((lane) => (
                  <Sentence key={lane} pool={pool} lane={lane} rules={rules} rangeLabel={p.rangeLabel} />
                ))}
              </div>
              {errors.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--line2)] pt-3">
                  {errors.map((e) => (
                    <div key={e} className="flex gap-2 text-[12px] text-[var(--amber)]">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{e}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <AdvancedBox value={advanced} onChange={setAdvanced} />
            <p className="px-1 text-[12px] leading-relaxed text-[var(--muted)]">
              A price counts only while it is within about 2% of Chainlink's, so nobody can push a pool's price to fire your strategy. Any keeper can
              run a step once its condition is true; it is paid your keeper fee, set under Settings.
            </p>
          </aside>
          </div>
        </div>
      </main>

      {backtest && p.range && <Backtest pool={pool} price={price} range={p.range} rules={rules} advanced={advanced} onClose={() => setBacktest(false)} />}
    </div>
  );
}

function Notice({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[var(--r-lg)] border border-[var(--amber)]/30 bg-[var(--amber-lt)] px-4 py-2.5 text-[13px] text-[var(--amber)] ${className}`}>{children}</div>;
}

// ---------------------------------------------------------------- one column ("If WETH falls")

type ColumnProps = {
  lane: LaneId;
  pool: Pool;
  price: number;
  rules: Rules;
  v: Validation;
  ticks?: [number, number];
  rangeLabel: string;
  open: string | null;
  setOpen: (k: string | null) => void;
  adding: { lane: LaneId; second?: boolean } | null;
  setAdding: (a: { lane: LaneId; second?: boolean } | null) => void;
  setRules: (fn: (r: Rules) => Rules) => void;
  setLane: (lane: LaneId, fn: (l: Lane) => Lane) => void;
  setPlan: (fn: (pl: PlanB) => PlanB) => void;
  moved: boolean;
  planLocked: boolean;
  backLocked: boolean;
};

function Column(c: ColumnProps) {
  const { lane, pool, rules } = c;
  const L = rules[lane];
  const up = lane === "up";
  const move = get(L, "move");
  const plan = rules.plan;
  const toggle = (id: CardId) => c.setOpen(c.open === cardKey(id) ? null : cardKey(id));
  const isOpen = (id: CardId) => c.open === cardKey(id);
  const locked = c.moved; // the position's own sides wait while the money is moved
  const Icon = up ? ArrowUpRight : ArrowDownRight;

  const cards: { id: CardId; kicker: string; title: string; sub?: string; icon: LucideIcon; tone?: "when" | "move"; warn?: string; body: React.ReactNode; remove?: () => void; editable?: boolean }[] = [];
  const update = (fn: (l: Lane) => Lane) => c.setLane(lane, fn);
  const num = (s: string) => (s === "" ? NaN : Number(s));

  if (L.trigger) {
    cards.push({
      id: { lane, part: "trigger" },
      kicker: "When",
      title: TITLES[L.trigger.kind],
      sub: describeTrigger(pool, lane, L.trigger),
      icon: L.trigger.kind === "trail" && up ? TrendingUp : ICONS[L.trigger.kind],
      tone: "when",
      warn: c.v[lane].find((e) => !NEXT_STEP.has(e)),
      remove: () => c.setRules((r) => removeMove({ ...r, [lane]: emptyLane() }, lane)),
      body: <TriggerFields pool={pool} price={c.price} lane={lane} t={L.trigger} onChange={(nt) => update((l) => ({ ...l, trigger: nt }))} />,
    });
  }
  if (L.trigger && L.trigger2) {
    cards.push({
      id: { lane, part: "trigger2" },
      kicker: L.combine === "or" ? "Or when" : "And when",
      title: TITLES[L.trigger2.kind],
      sub: describeTrigger(pool, lane, L.trigger2),
      icon: L.trigger2.kind === "trail" && up ? TrendingUp : ICONS[L.trigger2.kind],
      tone: "when",
      remove: () => update((l) => ({ ...l, trigger2: null, combine: undefined })),
      body: (
        <>
          <Choices
            items={[
              { id: "and", title: "Both must be true" },
              { id: "or", title: "Either one is enough" },
            ]}
            value={L.combine ?? "and"}
            onChange={(x) => update((l) => ({ ...l, combine: x as "and" | "or" }))}
          />
          <TriggerFields pool={pool} price={c.price} lane={lane} t={L.trigger2} onChange={(nt) => update((l) => ({ ...l, trigger2: nt }))} />
        </>
      ),
    });
  }
  if (L.trigger && L.holdMinutes) {
    cards.push({
      id: { lane, part: "hold" },
      kicker: "Only if it lasts",
      title: `${L.holdMinutes} min in a row`,
      sub: "A short move or a wick does not count",
      icon: Timer,
      tone: "when",
      remove: () => update((l) => ({ ...l, holdMinutes: undefined })),
      body: (
        <Field label="True for" hint="Minutes in a row (up to a day), counted from when a keeper first sees it true.">
          <Suffix value={L.holdMinutes} suffix="minutes" onChange={(x) => update((l) => ({ ...l, holdMinutes: num(x) }))} />
          <Chips values={[5, 15, 60, 240]} current={L.holdMinutes} label={(m) => (m >= 60 ? `${m / 60} h` : `${m} min`)} onPick={(m) => update((l) => ({ ...l, holdMinutes: m }))} />
        </Field>
      ),
    });
  }
  for (const a of L.actions) {
    if (a.kind === "move") continue;
    const set = (patch: Partial<Action>) => update((l) => withAction(l, { ...a, ...patch }));
    cards.push({
      id: { lane, part: "step", kind: a.kind },
      kicker: "Then",
      title: TITLES[a.kind],
      sub: describeAction(pool, a, plan),
      icon: ICONS[a.kind],
      remove: () => update((l) => ({ ...l, actions: l.actions.filter((x) => x.kind !== a.kind && !(a.kind === "withdraw" && x.kind === "convert")) })),
      body: <StepFields pool={pool} a={a} set={set} num={num} />,
    });
  }
  if (move && plan) {
    const backId = backLaneOf(lane);
    const B = plan.back[backId];
    cards.push({
      id: { lane, part: "move" },
      kicker: "Then move it",
      title: plan.where === "park" && plan.parkPool ? `Into ${poolByIndex(plan.parkPool)?.label ?? "another pool"}` : `Hold ${move.to === "base" ? pool.base.symbol : pool.quote.symbol}`,
      sub: describeAction(pool, move, plan),
      icon: Waypoints,
      tone: "move",
      remove: c.planLocked ? undefined : () => c.setRules((r) => removeMove(r, lane)),
      editable: !c.planLocked,
      body: <MoveFields pool={pool} lane={lane} plan={plan} move={move} locked={c.planLocked} setPlan={c.setPlan} update={update} num={num} />,
    });
    cards.push({
      id: { lane, part: "back" },
      kicker: "Come back when",
      title: B.trigger ? describeTrigger(pool, backId, B.trigger) : "Choose when",
      icon: RotateCcw,
      tone: "move",
      warn: B.trigger ? c.v[backId === "down" ? "backDown" : "backUp"][0] : "Set when the money comes back",
      editable: !c.backLocked,
      body: <BackFields pool={pool} price={c.price} lane={backId} plan={plan} locked={c.backLocked} setPlan={c.setPlan} ticks={c.ticks} />,
    });
    cards.push({
      id: { lane, part: "into" },
      kicker: "Back into",
      title: plan.returnTo === "same" ? "The same range" : "A new range around the price",
      sub: plan.returnTo === "same" ? c.rangeLabel : "Same width as now, centred on the price then",
      icon: Undo2,
      tone: "move",
      editable: !c.planLocked,
      body: (
        <Choices
          disabled={c.planLocked}
          items={[
            { id: "same", title: "The same range", hint: c.rangeLabel },
            { id: "recentre", title: "A new range around the price", hint: "Same width, centred on the price when it comes back" },
          ]}
          value={plan.returnTo}
          onChange={(x) => c.setPlan((pl) => ({ ...pl, returnTo: x as "same" | "recentre" }))}
        />
      ),
    });
  }
  if (L.trigger && L.repeat && !move) {
    const level = [L.trigger, L.trigger2].some((t) => t?.kind === "price" || t?.kind === "otherPool");
    cards.push({
      id: { lane, part: "repeat" },
      kicker: "Finally",
      title: "Repeat",
      sub: L.maxRuns ? `At most ${L.maxRuns} times` : "Runs again the next time",
      icon: Repeat,
      remove: () => update((l) => ({ ...l, repeat: false, maxRuns: undefined })),
      body: (
        <>
          {level && !get(L, "follow") && (
            <Field label="Move the price level after each run by">
              <Suffix value={L.stepPct ?? 5} suffix="%" onChange={(x) => update((l) => ({ ...l, stepPct: num(x) }))} />
            </Field>
          )}
          <Field label="Stop after" hint="Empty = no limit">
            <Suffix value={L.maxRuns ?? undefined} suffix="runs" onChange={(x) => update((l) => ({ ...l, maxRuns: num(x) || undefined }))} />
          </Field>
        </>
      ),
    });
  }

  const canAdd = !locked && !(move && L.trigger);
  return (
    <section className="flex min-w-0 flex-col">
      <div className={`mb-3 inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 ${up ? "bg-[var(--sage-lt)] text-[var(--sage)]" : "bg-[var(--rose-lt)] text-[var(--rose)]"}`}>
        <Icon className="h-4 w-4" />
        <span className="text-[13px] font-semibold">{laneTitle(pool, lane, L)}</span>
        {locked && <span className="ml-auto text-[11px] opacity-80">waits while the money is moved</span>}
      </div>

      <ol className="relative flex flex-col gap-2">
        {/* the rail that ties the cards of one side together */}
        {cards.length > 1 && <span aria-hidden className="absolute bottom-6 left-[27px] top-6 w-px bg-[var(--line)]" />}
        {cards.map((card) => {
          const k = cardKey(card.id);
          const editable = card.editable ?? !locked;
          return (
            <Card
              key={k}
              open={isOpen(card.id)}
              onToggle={() => toggle(card.id)}
              kicker={card.kicker}
              title={card.title}
              sub={card.sub}
              icon={card.icon}
              tone={card.tone}
              warn={card.warn}
              locked={!editable}
              onRemove={editable ? card.remove : undefined}
            >
              {card.body}
            </Card>
          );
        })}
      </ol>

      {canAdd && (
        <div className="relative mt-2">
          <button
            className={`flex w-full items-center gap-3 rounded-[var(--r-lg)] border border-dashed px-3 py-3 text-left text-[13px] transition-colors ${
              c.adding ? "border-[var(--ink)] bg-white text-[var(--ink)]" : "border-[var(--line)] text-[var(--muted)] hover:border-[var(--ink)] hover:text-[var(--ink)]"
            }`}
            onClick={() => c.setAdding(c.adding ? null : { lane })}
            aria-expanded={!!c.adding}
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--line2)]">
              <Plus className="h-4 w-4" />
            </span>
            <span className="font-medium">{!L.trigger ? "Choose when" : L.actions.length ? "Add a step" : "Then what?"}</span>
            {!L.trigger && <span className="ml-auto text-[11px]">Nothing happens on this side yet</span>}
          </button>
          {c.adding && <AddMenu {...c} second={!!c.adding.second} onClose={() => c.setAdding(null)} />}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- a card that opens in place

function Card({
  open,
  onToggle,
  kicker,
  title,
  sub,
  icon: Icon,
  tone,
  warn,
  locked,
  onRemove,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  kicker: string;
  title: string;
  sub?: string;
  icon: LucideIcon;
  tone?: "when" | "move";
  warn?: string;
  locked: boolean;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const iconCls = tone === "when" ? "bg-[var(--ink)] text-white" : tone === "move" ? "bg-[var(--blue-lt)] text-[var(--blue)]" : "bg-[var(--line2)] text-[var(--ink)]";
  return (
    <li
      ref={ref}
      className={`relative overflow-hidden rounded-[var(--r-lg)] border bg-white transition-[border-color,box-shadow] duration-200 ${
        open ? "border-[var(--ink)] shadow-[0_8px_24px_-12px_rgba(27,29,34,0.25)]" : tone === "move" ? "border-[var(--blue)]/25 hover:border-[var(--blue)]/60" : "border-[var(--line)] hover:border-[var(--muted2)]"
      }`}
    >
      <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left" onClick={onToggle} aria-expanded={open}>
        <span className={`relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full ${iconCls}`}>
          <Icon className="h-[17px] w-[17px]" strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{kicker}</span>
          <span className="block truncate text-[14px] font-semibold">{title}</span>
          {sub && <span className="block truncate text-[12px] text-[var(--muted)]">{sub}</span>}
        </span>
        {warn && (
          <span title={warn} className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--amber)] text-white">
            <AlertTriangle className="h-3 w-3" />
          </span>
        )}
        <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--muted)] transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {/* height animates with the grid-rows trick: 0fr closed, 1fr open */}
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-4 border-t border-[var(--line2)] px-3 pb-3 pt-3">
            {warn && <div className="rounded-[var(--r)] bg-[var(--amber-lt)] px-2.5 py-2 text-[12px] text-[var(--amber)]">{warn}</div>}
            <fieldset disabled={locked} className="flex flex-col gap-4 disabled:opacity-60">
              {children}
            </fieldset>
            {locked && <p className="text-[12px] text-[var(--muted)]">This part is fixed for an open position.</p>}
            {onRemove && (
              <button className="btn btn-danger self-start !px-3 !py-1.5 text-[13px]" onClick={onRemove}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- the Add menu: only what fits after the cards above

function AddMenu(c: ColumnProps & { second: boolean; onClose: () => void }) {
  const { pool, rules, lane, ticks } = c;
  const L = rules[lane];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) c.onClose();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [c]);
  const opts = { planLocked: c.planLocked };
  const before = useMemo(() => new Set(laneProblems(validate(pool, rules, ticks, opts), lane)), [pool, rules, ticks, lane, c.planLocked]); // eslint-disable-line react-hooks/exhaustive-deps
  // an option is offered when it leaves this side no worse; one that does not fit is shown greyed with the reason
  const problem = (o: Option) => laneProblems(validate(pool, o.apply(rules), ticks, opts), lane).find((e) => !before.has(e) && !GENERIC.has(e));
  const why = (list: Option[]) => list.map((o) => ({ ...o, why: o.second ? undefined : problem(o) })).sort((a, b) => Number(!!a.why) - Number(!!b.why));

  const groups: [string, Option[]][] = [];
  if (c.second || !L.trigger) groups.push([c.second ? `${L.combine === "or" ? "Or" : "And"} when…` : "When…", triggerOptions(pool, lane, c.price, ticks, c.second)]);
  else {
    const steps = why(stepOptions(pool, rules, lane).filter((o) => o.id !== "move" || !c.planLocked || !!rules.plan));
    if (steps.length) groups.push([L.actions.length ? "Then also…" : "Then…", steps]);
    const more = why(moreOptions(rules, lane));
    if (more.length) groups.push(["More", more]);
  }

  const pick = (o: Option) => {
    if (o.second) {
      c.setAdding({ lane, second: true });
      return;
    }
    c.setRules((r) => o.apply(r));
    c.setAdding(null);
    if (o.open) c.setOpen(cardKey(o.open));
  };

  return (
    <div
      ref={ref}
      className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-[60vh] origin-top animate-[menu-in_140ms_ease-out] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--line)] bg-white p-1.5 shadow-[0_16px_40px_-16px_rgba(27,29,34,0.35)]"
    >
      {groups.map(([title, list]) => (
        <div key={title} className="mb-1 last:mb-0">
          <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</div>
          {list.map((o) => (
            <button
              key={o.id}
              disabled={!!o.why}
              onClick={() => pick(o)}
              className="flex w-full items-center gap-3 rounded-[var(--r)] px-2.5 py-2 text-left enabled:hover:bg-[var(--line2)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${o.id === "move" ? "bg-[var(--blue-lt)] text-[var(--blue)]" : "bg-[var(--line2)]"}`}>
                <o.icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">{o.label}</span>
                <span className="block text-[11px] text-[var(--muted)]">{o.why ? `Not here: ${o.why}` : o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ))}
      {!groups.length && <div className="p-4 text-center text-[13px] text-[var(--muted)]">Nothing more fits on this side.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- settings inside the cards

function Choices({
  items,
  value,
  onChange,
  disabled,
  grid,
}: {
  items: { id: string; title: string; hint?: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** two columns, for longer lists */
  grid?: boolean;
}) {
  return (
    <div className={grid ? "grid grid-cols-1 gap-1.5 sm:grid-cols-2" : "flex flex-col gap-1.5"} role="radiogroup">
      {items.map((x) => (
        <button
          key={x.id}
          role="radio"
          aria-checked={value === x.id}
          disabled={disabled}
          onClick={() => onChange(x.id)}
          className={`flex items-start gap-2.5 rounded-[var(--r)] border px-3 py-2 text-left transition-colors ${value === x.id ? "border-[var(--ink)] bg-[var(--line2)]" : "border-[var(--line)] hover:border-[var(--muted2)]"}`}
        >
          <span className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border ${value === x.id ? "border-[4px] border-[var(--ink)]" : "border-[var(--muted2)]"}`} />
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold">{x.title}</span>
            {x.hint && <span className="block text-[11px] text-[var(--muted)]">{x.hint}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

function Chips<T extends number>({ values, current, label, onPick }: { values: T[]; current: T | undefined; label: (x: T) => string; onPick: (x: T) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {values.map((x) => (
        <button key={x} className="chip" data-on={current === x} onClick={() => onPick(x)}>
          {label(x)}
        </button>
      ))}
    </div>
  );
}

function StepFields({ pool, a, set, num }: { pool: Pool; a: Action; set: (patch: Partial<Action>) => void; num: (s: string) => number }) {
  if (a.kind === "withdraw")
    return (
      <Field label="How much">
        <Chips values={[25, 50, 100]} current={a.pct} label={(x) => (x === 100 ? "All of it" : `${x}%`)} onPick={(x) => set({ pct: x })} />
        <div className="mt-1.5">
          <Suffix value={a.pct ?? 100} suffix="%" onChange={(x) => set({ pct: num(x) })} />
        </div>
      </Field>
    );
  if (a.kind === "convert")
    return (
      <>
        <Choices
          items={(["quote", "base"] as const).map((to) => ({ id: to, title: `Swap to ${to === "quote" ? pool.quote.symbol : pool.base.symbol}` }))}
          value={a.to ?? "quote"}
          onChange={(x) => set({ to: x as "base" | "quote" })}
        />
        <p className="text-[12px] text-[var(--muted)]">Swapped at once, never worse than your slippage limit. If the pool's price is far from Chainlink's, it waits.</p>
      </>
    );
  if (a.kind === "follow")
    return (
      <Field label="New range width" hint="Placed right next to the price, in the token you hold then">
        <Suffix value={a.widthPct ?? 5} suffix="%" onChange={(x) => set({ widthPct: num(x) })} />
      </Field>
    );
  if (a.kind === "collect") return <p className="text-[13px] text-[var(--muted)]">Fees earned so far go to your wallet instead of staying in the position.</p>;
  return <p className="text-[13px] text-[var(--muted)]">Fees go back into the same range.</p>;
}

/** Where a move takes the money: any other pool sharing a token, or holding one token. */
function MoveFields({
  pool,
  lane,
  plan,
  move,
  locked,
  setPlan,
  update,
  num,
}: {
  pool: Pool;
  lane: LaneId;
  plan: PlanB;
  move: Action;
  locked: boolean;
  setPlan: (fn: (pl: PlanB) => PlanB) => void;
  update: (fn: (l: Lane) => Lane) => void;
  num: (s: string) => number;
}) {
  const pools = parkable(pool);
  const holds = (lane === "down" ? (["quote", "base"] as const) : (["base", "quote"] as const)).map((to) => ({
    id: `hold-${to}`,
    title: `Hold ${to === "quote" ? pool.quote.symbol : pool.base.symbol}`,
    hint: "no pool, kept for you",
  }));
  const items = [
    ...pools.map((q) => {
      const sh = sharedToken(pool, q);
      const via = sh === "token0" ? pool.token0.symbol : sh === "token1" ? pool.token1.symbol : null;
      return { id: `pool-${q.index}`, title: q.label, hint: via ? `via ${via}` : "same pair, another fee" };
    }),
    ...holds,
  ];
  const value = plan.where === "park" ? `pool-${plan.parkPool}` : `hold-${move.to ?? (lane === "down" ? "quote" : "base")}`;
  const choose = (id: string) => {
    if (id.startsWith("pool-")) {
      const q = poolByIndex(Number(id.slice(5)));
      setPlan((pl) => ({ ...pl, where: "park", parkPool: q?.index, parkWidthPct: q ? defaultWidthPct(q) : pl.parkWidthPct }));
      update((l) => withAction(l, { kind: "move" }));
    } else {
      setPlan((pl) => ({ ...pl, where: "wait", parkPool: undefined }));
      update((l) => withAction(l, { kind: "move", to: id.slice(5) as "base" | "quote" }));
    }
  };
  return (
    <>
      <div className="text-[13px] text-[var(--muted)]">
        Everything is taken out of the range and goes here until it comes back by itself. Into another pool it is swapped to the token both pools share
        (“via”), then added there.
      </div>
      <Choices items={items} value={value} onChange={choose} disabled={locked} grid />
      {plan.where === "park" && (
        <Field label="Range in that pool" hint="Around that pool's price when the money arrives">
          <Suffix value={plan.parkWidthPct ?? 5} suffix="% each way" onChange={(x) => setPlan((pl) => ({ ...pl, parkWidthPct: num(x) }))} />
          <Chips values={[0.2, 1, 5, 10]} current={plan.parkWidthPct} label={(x) => `±${x}%`} onPick={(x) => setPlan((pl) => ({ ...pl, parkWidthPct: x }))} />
        </Field>
      )}
      <p className="text-[12px] text-[var(--muted)]">Both sides share this place if both move the money.</p>
    </>
  );
}

/** When the moved money comes back. `lane` is the direction of the way back. */
function BackFields({
  pool,
  price,
  lane,
  plan,
  locked,
  setPlan,
  ticks,
}: {
  pool: Pool;
  price: number;
  lane: LaneId;
  plan: PlanB;
  locked: boolean;
  setPlan: (fn: (pl: PlanB) => PlanB) => void;
  ticks?: [number, number];
}) {
  const B = plan.back[lane];
  const set = (t: Trigger | null) => setPlan((pl) => ({ ...pl, back: { ...pl.back, [lane]: { ...pl.back[lane], trigger: t, actions: [{ kind: "move" }], repeat: true } } }));
  const b = pool.base.symbol;
  const rising = lane === "up";
  const kinds: { id: string; title: string; hint: string; t: () => Trigger }[] = [
    { id: "backIn", title: `${b} is back in my range`, hint: "Optionally a margin inside it, so a price hovering at the edge does not bounce it back", t: () => ({ kind: "price", backIn: true }) },
    { id: "trail", title: rising ? `${b} turns up a % from its low` : `${b} turns down a % from its high`, hint: "Waits for the turn", t: () => ({ kind: "trail", trailPct: 5 }) },
    { id: "timer", title: "After a time", hint: "Waits, then comes back", t: () => ({ kind: "timer", hours: 24 }) },
    { id: "price", title: `${b} ${rising ? "rises above" : "drops below"} a price`, hint: "A price you choose", t: () => ({ kind: "price", price: outside(pool, price, ticks, lane, 5) }) },
  ];
  const current = B.trigger?.backIn ? "backIn" : (B.trigger?.kind ?? "");
  return (
    <>
      <Choices items={kinds} value={current} onChange={(id) => set(kinds.find((k) => k.id === id)!.t())} disabled={locked} />
      {B.trigger?.backIn && (
        <Field label="Margin inside the range">
          <Chips values={[0, 0.5, 1, 2]} current={B.trigger.bufferPct ?? 0} label={(x) => (x ? `${x}%` : "At the edge")} onPick={(x) => set({ kind: "price", backIn: true, bufferPct: x || undefined })} />
        </Field>
      )}
      {B.trigger && !B.trigger.backIn && <TriggerFields pool={pool} price={price} lane={lane} t={B.trigger} onChange={(nt) => set(nt)} />}
      {locked && <p className="text-[12px] text-[var(--muted)]">This can be changed while the money is moved.</p>}
    </>
  );
}

/** The settings of one condition. Reads the watched pool's price for hints and quick buttons. */
function TriggerFields({ pool, price, lane, t, onChange }: { pool: Pool; price: number; lane: LaneId; t: Trigger; onChange: (t: Trigger) => void }) {
  const num = (s: string) => (s === "" ? NaN : Number(s));
  const w = watchedBy(pool, t);
  const { data: wState } = useReadContract({ address: CORE.rules, abi: rulesAbi, functionName: "poolState", args: [w.index] });
  const wPrice = wState ? priceAtTick(w, Number(wState[1])) : price;

  const from = wPrice;
  useEffect(() => {
    if (t.kind === "otherPool" && t.price === undefined && wState) onChange({ ...t, price: wPrice * (lane === "down" ? 0.95 : 1.05) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wState, t.poolIndex, t.kind]);

  return (
    <>
      {t.kind === "leave" && (
        <Field label="How far past the edge" hint="0 = as soon as the price leaves your range">
          <Suffix value={t.bufferPct ?? 0} suffix="%" onChange={(x) => onChange({ ...t, bufferPct: num(x) })} />
        </Field>
      )}
      {t.kind === "otherPool" && (
        <Field label="Pool to watch">
          <select className="input" value={t.poolIndex ?? ""} onChange={(e) => onChange({ ...t, poolIndex: Number(e.target.value), price: undefined })}>
            {watchable(pool).map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {(t.kind === "price" || t.kind === "otherPool") && !t.backIn && (
        <Field label={`${w.base.symbol} price`} hint={`Now ${fmt(wPrice)} ${w.quote.symbol}${t.kind === "otherPool" ? ` in ${w.label}` : ""}`}>
          <Suffix value={t.price === undefined ? undefined : round(t.price)} suffix={w.quote.symbol} onChange={(x) => onChange({ ...t, price: num(x) })} />
          <Chips values={[-10, -5, 5, 10]} current={undefined} label={(d) => `${d > 0 ? "+" : ""}${d}%`} onPick={(d) => onChange({ ...t, price: from * (1 + d / 100) })} />
        </Field>
      )}
      {t.kind === "trail" && (
        <Field label={lane === "down" ? `How far ${pool.base.symbol} falls from its high` : `How far ${pool.base.symbol} rises from its low`} hint="The best price is remembered on-chain; keepers update it.">
          <Suffix value={t.trailPct ?? 5} suffix="%" onChange={(x) => onChange({ ...t, trailPct: num(x) })} />
          <Chips values={[2, 5, 10, 20]} current={t.trailPct} label={(x) => `${x}%`} onPick={(x) => onChange({ ...t, trailPct: x })} />
        </Field>
      )}
      {t.kind === "fees" && (
        <Field label="When the fees earned reach" hint="Of the position's value, since the fees were last collected">
          <Suffix value={t.feesPct ?? 0.5} suffix="%" onChange={(x) => onChange({ ...t, feesPct: num(x) })} />
          <Chips values={[0.1, 0.5, 1, 2]} current={t.feesPct} label={(x) => `${x}%`} onPick={(x) => onChange({ ...t, feesPct: x })} />
        </Field>
      )}
      {t.kind === "apr" && (
        <Field label="When the fees earn less than" hint="A yearly rate, from the fees since they were last collected (after at least an hour)">
          <Suffix value={t.aprPct ?? 5} suffix="% a year" onChange={(x) => onChange({ ...t, aprPct: num(x) })} />
          <Chips values={[2, 5, 10, 20]} current={t.aprPct} label={(x) => `${x}%`} onPick={(x) => onChange({ ...t, aprPct: x })} />
        </Field>
      )}
      {t.kind === "timer" && (
        <Field label="Every">
          <Suffix value={t.hours ?? 24} suffix="hours" onChange={(x) => onChange({ ...t, hours: num(x) })} />
          <Chips values={[1, 6, 24, 168]} current={t.hours} label={(h) => (h === 168 ? "1 week" : `${h}h`)} onPick={(h) => onChange({ ...t, hours: h })} />
        </Field>
      )}
    </>
  );
}

// ---------------------------------------------------------------- summary

/** One side in plain words, with the way back of a move. */
function Sentence({ pool, lane, rules, rangeLabel }: { pool: Pool; lane: LaneId; rules: Rules; rangeLabel: string }) {
  const L = rules[lane];
  const text = describeLane(pool, lane, L, rules.plan);
  const back = rules.plan && has(L, "move") ? rules.plan.back[backLaneOf(lane)] : null;
  const into = rules.plan?.returnTo === "same" ? `the same range (${rangeLabel})` : "a new range around the price";
  return (
    <p>
      <span className={`font-semibold ${lane === "up" ? "text-[var(--sage)]" : "text-[var(--rose)]"}`}>{laneTitle(pool, lane, L)}: </span>
      {text ?? <span className="text-[var(--muted)]">nothing happens.</span>}
      {back?.trigger && (
        <span>
          {" "}
          It comes back into {into} when {lowerFirst(describeTrigger(pool, backLaneOf(lane), back.trigger))}.
        </span>
      )}
    </p>
  );
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function AdvancedBox({ value, onChange }: { value: Advanced; onChange: (a: Advanced) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="card overflow-hidden">
      <button className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="label">Settings</span>
        <span className="flex items-center gap-2 text-[12px] text-[var(--muted)]">
          keeper {value.keeperFeeBps / 100}% · slippage {value.slippagePct}% · {value.expiryDays}d
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      <div className={`grid transition-[grid-template-rows] duration-200 ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-3 border-t border-[var(--line2)] p-4">
            <Field label="Keeper fee per run" hint="Paid to whoever runs a step, out of what the step moves. 0 = you run it yourself">
              <Suffix value={value.keeperFeeBps / 100} suffix="%" onChange={(x) => onChange({ ...value, keeperFeeBps: Math.min(100, Math.round(Number(x) * 100)) })} />
            </Field>
            <Field label="Swap slippage limit" hint="How far a swap may move the price">
              <Suffix value={value.slippagePct} suffix="%" onChange={(x) => onChange({ ...value, slippagePct: Number(x) })} />
            </Field>
            <Field label="Strategy expires after">
              <Suffix value={value.expiryDays} suffix="days" onChange={(x) => onChange({ ...value, expiryDays: Math.max(1, Number(x)) })} />
            </Field>
          </div>
        </div>
      </div>
    </section>
  );
}

const round = (n: number) => (n >= 100 ? Math.round(n * 100) / 100 : Number(n.toPrecision(6)));

