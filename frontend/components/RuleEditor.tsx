"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
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
  Umbrella,
  Undo2,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import Backtest, { type BacktestRange } from "@/components/Backtest";
import { Field, Suffix } from "@/components/ui";
import { conditionalOrdersAbi, priceFeedsAbi, rulesAbi } from "@/lib/generated/abis";
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
  describeAction,
  describeLane,
  describePlan,
  describeTrigger,
  emptyLane,
  emptyRules,
  get,
  has,
  isValid,
  laneTitle,
  newPlan,
  parkable,
  sharedToken,
  validate,
  watchable,
  watchedBy,
  withAction,
} from "@/lib/rules";

// ---------------------------------------------------------------- what can be added, given what is already there

type Selection =
  { lane: LaneId; part: "trigger" | "trigger2" | "hold" | "repeat" | "move" | "back" | "into" } | { lane: LaneId; part: "step"; kind: Action["kind"] } | null;

/** One thing the "Add" list offers: its label already says what it does here (this lane, these tokens). */
type Option = { id: string; label: string; hint: string; icon: LucideIcon; apply: (r: Rules) => Rules; select?: Selection; second?: boolean };

const GENERIC = new Set(["Add at least one step after the trigger.", "Add at least one trigger."]);
const laneErrors = (v: Validation, lane: LaneId) => [...v[lane], ...v.general, ...v.plan, ...v.backDown, ...v.backUp, ...v.advice];

/** Steps that take the money out to plan B, and the way back that goes with them. */
function addMove(r: Rules, lane: LaneId, to?: "base" | "quote"): Rules {
  const next: Rules = { ...r, [lane]: withAction(r[lane], { kind: "move", to }) };
  const back = backLaneOf(lane);
  if (!next.plan) next.plan = newPlan(lane);
  else if (!next.plan.back[back].trigger)
    next.plan = { ...next.plan, back: { ...next.plan.back, [back]: { trigger: { kind: "price", backIn: true }, actions: [{ kind: "move" }], repeat: true } } };
  return next;
}

function removeMove(r: Rules, lane: LaneId): Rules {
  const next: Rules = { ...r, [lane]: { ...r[lane], actions: [] } };
  if (!next.plan) return next;
  const plan = { ...next.plan, back: { ...next.plan.back, [backLaneOf(lane)]: emptyLane() } };
  const other = lane === "down" ? "up" : "down";
  if (!has(next[other], "move")) delete next.plan;
  else next.plan = plan;
  return next;
}

function triggerOptions(pool: Pool, lane: LaneId, price: number, second: boolean): Option[] {
  const b = pool.base.symbol;
  const down = lane === "down";
  const set =
    (t: Trigger) =>
    (r: Rules): Rules => ({ ...r, [lane]: second ? { ...r[lane], trigger2: t, combine: r[lane].combine ?? "and" } : { ...r[lane], trigger: t } });
  const t = (k: TriggerKind) => defaultTrigger(k, pool, lane, price, watchable(pool));
  const part = second ? "trigger2" : "trigger";
  const list: Option[] = [
    {
      id: "leave",
      label: `${b} leaves my range (${down ? "below" : "above"})`,
      hint: "As soon as the price is out of your range",
      icon: LogOut,
      apply: set(t("leave")),
    },
    {
      id: "price",
      label: `${b} ${down ? "drops below" : "rises above"} a price`,
      hint: `A ${pool.quote.symbol} price you choose`,
      icon: Target,
      apply: set(t("price")),
    },
    {
      id: "trail",
      label: down ? `${b} falls a % from its high` : `${b} rises a % from its low`,
      hint: "A trailing stop: it follows the best price",
      icon: TrendingDown,
      apply: set(t("trail")),
    },
    { id: "timer", label: "Every few hours or days", hint: "On a timer", icon: Clock, apply: set(t("timer")) },
    { id: "fees", label: "Fees reach a share of the position", hint: "For compounding: when enough fees have built up", icon: Percent, apply: set(t("fees")) },
    {
      id: "oracle",
      label: `${b} on Chainlink ${down ? "drops below" : "rises above"} a price`,
      hint: "The market price, which a swap in this pool cannot move",
      icon: Link2,
      apply: set(t("oracle")),
    },
    {
      id: "otherPool",
      label: `${b} in another pool ${down ? "drops below" : "rises above"} a price`,
      hint: "Watch a bigger pool",
      icon: Crosshair,
      apply: set(t("otherPool")),
    },
  ];
  // "fees dry up" is the contract's lower slot: offer it in the lane that uses it
  if (contractSide(pool, lane) === "lower")
    list.push({ id: "apr", label: "Fees earn less than a yearly rate", hint: "Leave when the position stops paying", icon: Coins, apply: set(t("apr")) });
  return list.map((o) => ({ ...o, select: { lane, part } }));
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
  const out: Option[] = [];
  out.push({
    id: "move",
    label: "Move to plan B",
    hint: down ? `Wait in ${q}, or park in a stable pool, and come back by itself` : `Wait in ${b}, or park elsewhere, and come back by itself`,
    icon: Umbrella,
    apply: (r) => addMove(r, lane, down ? "quote" : "base"),
    select: { lane, part: "move" },
  });
  if (!withdrawn) {
    out.push({
      id: "withdraw",
      label: "Withdraw everything",
      hint: "To your wallet",
      icon: ArrowDownRight,
      apply: add({ kind: "withdraw", pct: 100 }),
      select: { lane, part: "step", kind: "withdraw" },
    });
    out.push({
      id: "withdrawPart",
      label: "Withdraw part of it",
      hint: "25% to start; it can repeat, like a ladder",
      icon: ArrowDownRight,
      apply: add({ kind: "withdraw", pct: 25 }),
      select: { lane, part: "step", kind: "withdraw" },
    });
  }
  for (const to of down ? (["quote", "base"] as const) : (["base", "quote"] as const)) {
    const sym = to === "quote" ? q : b;
    out.push({
      id: `convert-${to}`,
      label: withdrawn ? `Swap it to ${sym}` : `Withdraw and swap to ${sym}`,
      hint: "Swapped at once, never worse than your slippage limit",
      icon: Shuffle,
      apply: add({ kind: "convert", to }),
      select: { lane, part: "step", kind: "convert" },
    });
  }
  out.push({
    id: "follow",
    label: "Move the range next to the price",
    hint: "Follow the price, in the token you hold then",
    icon: MoveHorizontal,
    apply: add({ kind: "follow", widthPct: 5 }),
    select: { lane, part: "step", kind: "follow" },
  });
  out.push({
    id: "readd",
    label: "Compound the fees",
    hint: "Put earned fees back into the range",
    icon: Layers,
    apply: add({ kind: "readd" }),
    select: { lane, part: "step", kind: "readd" },
  });
  out.push({
    id: "collect",
    label: "Send the fees to my wallet",
    hint: "Instead of keeping them in",
    icon: Wallet,
    apply: add({ kind: "collect" }),
    select: { lane, part: "step", kind: "collect" },
  });
  // once all of it is withdrawn, nothing is left in the range to compound, follow or move
  const allOut = (get(L, "withdraw")?.pct ?? 0) >= 100;
  const after = new Set(["readd", "collect", "follow", "move"]);
  return out.filter(
    (o) => !L.actions.some((a) => o.id.startsWith(a.kind) || (o.id === "withdrawPart" && a.kind === "withdraw")) && !(allOut && after.has(o.id)),
  );
}

function moreOptions(rules: Rules, lane: LaneId): Option[] {
  const L = rules[lane];
  const out: Option[] = [];
  if (!L.trigger2)
    out.push({ id: "second", label: "And another condition", hint: "Both must be true, or either one", icon: GitMerge, apply: (r) => r, second: true });
  if (!L.holdMinutes)
    out.push({
      id: "hold",
      label: "Only if it lasts",
      hint: "Read the average price over up to an hour, not a short move",
      icon: Timer,
      apply: (r) => ({ ...r, [lane]: { ...r[lane], holdMinutes: 15 } }),
      select: { lane, part: "hold" },
    });
  const allOut = (get(L, "withdraw")?.pct ?? 0) >= 100;
  if (!L.repeat && !has(L, "move") && !allOut)
    out.push({
      id: "repeat",
      label: "Repeat it",
      hint: "Run again the next time",
      icon: Repeat,
      apply: (r) => ({ ...r, [lane]: { ...r[lane], repeat: true, stepPct: r[lane].stepPct ?? 5 } }),
      select: { lane, part: "repeat" },
    });
  return out;
}

// ---------------------------------------------------------------- cards

type CardData = {
  kicker: string;
  title: string;
  sub?: string;
  icon?: LucideIcon;
  tone?: "dark" | "ghost" | "plan";
  warn?: string;
  selected?: boolean;
  action?: () => void;
};

const handleCls = "!h-2 !w-2 !border-2 !border-white !bg-[var(--ink)]";

const CardNode = memo(function CardNode({ data }: NodeProps) {
  const d = data as CardData;
  const Icon = d.icon ?? Plus;
  const ghost = d.tone === "ghost";
  const plan = d.tone === "plan";
  return (
    <div
      className={`relative flex h-[76px] w-[260px] cursor-pointer items-center gap-3 rounded-[var(--r-lg)] border px-3 transition-colors ${
        ghost
          ? "border-dashed border-[var(--line)] bg-white/60 text-[var(--muted)] hover:border-[var(--ink)] hover:text-[var(--ink)]"
          : d.selected
            ? "border-[var(--ink)] bg-white shadow-[0_0_0_3px_var(--line2)]"
            : plan
              ? "border-[var(--amber)]/40 bg-[var(--amber-lt)] hover:border-[var(--amber)]"
              : "border-[var(--line)] bg-white hover:border-[var(--muted2)]"
      }`}
    >
      <Handle type="target" position={Position.Top} className={handleCls} />
      <div
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r)] ${d.tone === "dark" ? "bg-[var(--ink)] text-white" : ghost ? "bg-transparent" : plan ? "bg-white text-[var(--amber)]" : "bg-[var(--line2)]"}`}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        {d.kicker && <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{d.kicker}</div>}
        <div className="truncate text-[13px] font-semibold">{d.title}</div>
        {d.sub && <div className="truncate text-[11px] text-[var(--muted)]">{d.sub}</div>}
      </div>
      {d.warn && (
        <div title={d.warn} className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-[var(--amber)] text-white">
          <AlertTriangle className="h-3 w-3" />
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className={handleCls} />
    </div>
  );
});

const PositionNode = memo(function PositionNode({ data }: NodeProps) {
  const d = data as { title: string; range: string; amounts: string };
  return (
    <div className="flex w-[280px] flex-col gap-0.5 rounded-[var(--r-lg)] bg-[var(--ink)] px-4 py-3 text-white">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-white/60">Your position</div>
      <div className="text-sm font-semibold">{d.title}</div>
      <div className="text-[12px] text-white/80">{d.range}</div>
      {d.amounts && <div className="text-[11px] text-white/60">{d.amounts}</div>}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-2 !border-[var(--ink)] !bg-white" />
    </div>
  );
});

const SideNode = memo(function SideNode({ data }: NodeProps) {
  const d = data as { up: boolean; title: string };
  const Icon = d.up ? ArrowUpRight : ArrowDownRight;
  return (
    <div
      className={`flex w-[260px] items-center gap-2 rounded-full border px-3 py-2 ${d.up ? "border-[var(--sage)]/30 bg-[var(--sage-lt)]" : "border-[var(--rose)]/30 bg-[var(--rose-lt)]"}`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Icon className={`h-4 w-4 ${d.up ? "text-[var(--sage)]" : "text-[var(--rose)]"}`} />
      <div className={`text-[12px] font-semibold ${d.up ? "text-[var(--sage)]" : "text-[var(--rose)]"}`}>{d.title}</div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
});

const nodeTypes = { card: CardNode, position: PositionNode, side: SideNode };

// ---------------------------------------------------------------- editor

export type RuleEditorProps = {
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
  /** The position's range in ticks: checks plan B's ways back and "back in my range". */
  ticks?: [number, number];
  /** Editing an open position: plan B is fixed, and only the leg the money is in now can change. */
  existing?: { liveIsHome: boolean };
  onSave: (rules: Rules, advanced: Advanced) => void;
  onClose: () => void;
};

export default function RuleEditor(props: RuleEditorProps) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

const LANE_X: Record<LaneId, number> = { down: -330, up: 330 };
const Y_SIDE = 140;
const Y0 = 210;
const DY = 104;

const ICONS: Record<string, LucideIcon> = {
  leave: LogOut,
  price: Target,
  trail: TrendingDown,
  timer: Clock,
  fees: Percent,
  apr: Coins,
  oracle: Link2,
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
  trail: "Trailing stop",
  timer: "On a timer",
  fees: "Fees earned",
  apr: "Fees dry up",
  oracle: "Chainlink price",
  otherPool: "Price in another pool",
  withdraw: "Withdraw",
  convert: "Swap",
  follow: "Follow the price",
  readd: "Compound",
  collect: "Send fees out",
};

function EditorInner(p: RuleEditorProps) {
  const { pool, price } = p;
  const [rules, setRules] = useState<Rules>(p.initialRules);
  const [advanced, setAdvanced] = useState<Advanced>(p.initialAdvanced);
  const [selection, setSelection] = useState<Selection>(null);
  const [adding, setAdding] = useState<{ lane: LaneId; second?: boolean } | null>(null);
  const [backtest, setBacktest] = useState(false);
  const v = useMemo(() => validate(pool, rules, p.ticks, { planLocked: !!p.existing }), [pool, rules, p.ticks, p.existing]);
  const { fitView } = useReactFlow();
  const empty = !rules.down.trigger && !rules.up.trigger;
  // An open position: plan B was set when it was created. While the money is in plan B, only its ways back change.
  const homeLocked = !!p.existing && !p.existing.liveIsHome;
  const backLocked = !!p.existing && p.existing.liveIsHome;
  const planLocked = !!p.existing;
  const errors = allErrors(v);

  // ---------------- graph from rules: a fixed layout, one column per lane
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    nodes.push({
      id: "position",
      type: "position",
      draggable: false,
      position: { x: -140, y: 0 },
      data: { title: pool.label, range: p.rangeLabel, amounts: p.amountsLabel ?? "" },
    });
    (["down", "up"] as LaneId[]).forEach((lane) => {
      const L = rules[lane];
      const x = LANE_X[lane];
      const sideId = `${lane}-side`;
      nodes.push({ id: sideId, type: "side", draggable: false, position: { x, y: Y_SIDE }, data: { up: lane === "up", title: laneTitle(pool, lane, L) } });
      edges.push({ id: `e-pos-${lane}`, source: "position", target: sideId, type: "smoothstep", style: { stroke: "var(--muted2)" } });
      let prev = sideId;
      let y = Y0;
      const push = (id: string, data: CardData, dashed = false) => {
        nodes.push({ id, type: "card", draggable: false, position: { x, y }, data });
        edges.push({
          id: `e-${prev}-${id}`,
          source: prev,
          target: id,
          type: "smoothstep",
          animated: !dashed,
          style: dashed ? { strokeDasharray: "4 4" } : undefined,
        });
        prev = id;
        y += DY;
      };
      const sel = (part: string, kind?: string) =>
        !!selection && selection.lane === lane && selection.part === part && (!kind || ("kind" in selection && selection.kind === kind));
      const pick = (s: Exclude<Selection, null>) => () => setSelection(s);
      const locked = homeLocked;

      if (!L.trigger) {
        if (!locked)
          push(
            `${lane}-start`,
            { kicker: "", title: "Choose when", sub: "Nothing happens on this side yet", tone: "ghost", action: () => setAdding({ lane }) },
            true,
          );
        return;
      }
      push(`${lane}-trigger`, {
        kicker: "When",
        title: TITLES[L.trigger.kind],
        sub: describeTrigger(pool, lane, L.trigger),
        icon: ICONS[L.trigger.kind],
        tone: "dark",
        warn: v[lane][0],
        selected: sel("trigger"),
        action: pick({ lane, part: "trigger" }),
      });
      if (L.trigger2)
        push(`${lane}-trigger2`, {
          kicker: L.combine === "or" ? "Or when" : "And when",
          title: TITLES[L.trigger2.kind],
          sub: describeTrigger(pool, lane, L.trigger2),
          icon: ICONS[L.trigger2.kind],
          tone: "dark",
          selected: sel("trigger2"),
          action: pick({ lane, part: "trigger2" }),
        });
      if (L.holdMinutes)
        push(`${lane}-hold`, {
          kicker: "If it lasts",
          title: `Average over ${L.holdMinutes} min`,
          sub: "Not a short move",
          icon: Timer,
          selected: sel("hold"),
          action: pick({ lane, part: "hold" }),
        });
      for (const a of L.actions) {
        if (a.kind === "move") continue;
        push(`${lane}-${a.kind}`, {
          kicker: "Then",
          title: TITLES[a.kind],
          sub: describeAction(pool, a, rules.plan),
          icon: ICONS[a.kind],
          selected: sel("step", a.kind),
          action: pick({ lane, part: "step", kind: a.kind }),
        });
      }
      const move = get(L, "move");
      if (move && rules.plan) {
        const plan = rules.plan;
        const back = plan.back[backLaneOf(lane)];
        push(`${lane}-move`, {
          kicker: "Then",
          title: "Move to plan B",
          sub: describePlan(pool, plan),
          icon: Umbrella,
          tone: "plan",
          selected: sel("move"),
          action: pick({ lane, part: "move" }),
        });
        push(`${lane}-back`, {
          kicker: "Come back when",
          title: back.trigger ? describeTrigger(pool, backLaneOf(lane), back.trigger) : "Choose when",
          icon: RotateCcw,
          tone: "plan",
          warn: back.trigger ? undefined : "Set when the money comes back",
          selected: sel("back"),
          action: pick({ lane, part: "back" }),
        });
        push(`${lane}-into`, {
          kicker: "Back into",
          title: plan.returnTo === "same" ? "The same range" : "A new range around the price",
          sub: plan.returnTo === "same" ? p.rangeLabel : "Same width as now",
          icon: Undo2,
          tone: "plan",
          selected: sel("into"),
          action: pick({ lane, part: "into" }),
        });
      }
      if (L.repeat && !move)
        push(`${lane}-repeat`, {
          kicker: "Finally",
          title: "Repeat",
          sub: L.maxRuns ? `At most ${L.maxRuns} times` : "Runs again the next time",
          icon: Repeat,
          selected: sel("repeat"),
          action: pick({ lane, part: "repeat" }),
        });
      if (!locked && !move)
        push(`${lane}-add`, { kicker: "", title: L.actions.length ? "Add" : "Then what?", tone: "ghost", action: () => setAdding({ lane }) }, true);
    });
    return { nodes, edges };
  }, [rules, selection, v, pool, p.rangeLabel, p.amountsLabel, homeLocked]);

  const count = nodes.length;
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 40);
    return () => clearTimeout(t);
  }, [count, fitView]);

  const setLane = useCallback((lane: LaneId, fn: (l: Lane) => Lane) => setRules((r) => ({ ...r, [lane]: fn(r[lane]) })), []);
  const setPlan = useCallback((fn: (pl: PlanB) => PlanB) => setRules((r) => (r.plan ? { ...r, plan: fn(r.plan) } : r)), []);

  const templateFor = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!.build(pool, price, p.ticks ?? [0, 0]);
    if (!t || (planLocked && (t.plan || rules.plan))) return null; // an open position keeps its plan B
    return t;
  };
  const applyTemplate = (id: string) => {
    const t = id ? templateFor(id) : null;
    if (!t) return;
    setRules(t);
    setSelection(null);
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[var(--paper)]">
      {/* top bar */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] bg-white px-4">
        <button className="btn btn-light !px-2.5" onClick={p.onClose}>
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">Rules for your {pool.label} position</div>
          <div className="text-[11px] text-[var(--muted)]">
            Now 1 {pool.base.symbol} = {fmt(price)} {pool.quote.symbol}
          </div>
        </div>
        <select
          className="input ml-auto !w-auto min-w-0 max-w-[260px] !py-1.5 text-[13px]"
          value=""
          onChange={(e) => applyTemplate(e.target.value)}
          disabled={homeLocked}
        >
          <option value="">Start from a template…</option>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id} disabled={!templateFor(t.id)}>
              {t.name}
            </option>
          ))}
        </select>
        {!empty && !planLocked && (
          <button
            className="btn btn-light"
            onClick={() => {
              setRules(emptyRules());
              setSelection(null);
            }}
          >
            Clear
          </button>
        )}
        {p.range && (
          <button className="btn btn-light" disabled={empty || !isValid(v)} onClick={() => setBacktest(true)} title="Replay real swap history with these rules">
            <LineChartIcon className="h-4 w-4" /> Backtest
          </button>
        )}
        <button className="btn btn-dark" disabled={p.busy || empty || !isValid(v)} onClick={() => p.onSave(rules, advanced)}>
          {p.saveLabel}
        </button>
      </div>

      <div className="relative flex-1">
        {/* the canvas starts right of the summary, so the left lane is never under it */}
        <div className="absolute inset-y-0 right-0" style={{ left: selection ? 0 : 356, right: selection ? 360 : 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => (n.data as { action?: () => void }).action?.()}
            onPaneClick={() => setSelection(null)}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.4}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--line)" />
            <Controls showInteractive={false} className="!rounded-[var(--r)] !border !border-[var(--line)] !bg-white !shadow-sm" />
          </ReactFlow>
          {homeLocked && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 w-max max-w-[90%] -translate-x-1/2 rounded-full border border-[var(--line)] bg-white px-4 py-2 text-[13px] text-[var(--muted)] shadow-sm">
              Your money is in plan B. You can change when it comes back; these rules run again once it is back.
            </div>
          )}
          {empty && !homeLocked && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 w-max max-w-[90%] -translate-x-1/2 rounded-full border border-[var(--line)] bg-white px-4 py-2 text-[13px] text-[var(--muted)] shadow-sm">
              Click <b className="text-[var(--ink)]">Choose when</b> on a side, or start from a template.
            </div>
          )}
        </div>

        {/* summary in plain words */}
        {!selection && (
          <div className="absolute bottom-4 left-4 top-4 z-10 flex w-[340px] max-w-[calc(100%-2rem)] flex-col overflow-y-auto rounded-[var(--r-lg)] border border-[var(--line)] bg-white shadow-sm">
            <div className="px-3 py-2 text-[13px] font-semibold">In plain words</div>
            <div className="flex flex-col gap-2 border-t border-[var(--line)] p-3 text-[12px]">
              {(["down", "up"] as LaneId[]).map((lane) => {
                const text = describeLane(pool, lane, rules[lane], rules.plan);
                const back = rules.plan && has(rules[lane], "move") ? rules.plan.back[backLaneOf(lane)] : null;
                return (
                  <div key={lane}>
                    <span className={`font-semibold ${lane === "up" ? "text-[var(--sage)]" : "text-[var(--rose)]"}`}>
                      {laneTitle(pool, lane, rules[lane])}:{" "}
                    </span>
                    {text ?? <span className="text-[var(--muted)]">nothing happens.</span>}
                    {back?.trigger && (
                      <span>
                        {" "}
                        It comes back when {describeTrigger(pool, backLaneOf(lane), back.trigger)}, into{" "}
                        {rules.plan!.returnTo === "same" ? "the same range" : "a new range around the price"}.
                      </span>
                    )}
                  </div>
                );
              })}
              {errors.map((e) => (
                <div key={e} className="text-[var(--amber)]">
                  ⚠ {e}
                </div>
              ))}
              <AdvancedBox value={advanced} onChange={setAdvanced} />
            </div>
          </div>
        )}

        {/* settings of the selected card */}
        {selection && (
          <div className="absolute bottom-0 right-0 top-0 z-10 w-[360px] overflow-y-auto border-l border-[var(--line)] bg-white p-4 shadow-[-8px_0_24px_rgba(0,0,0,0.04)]">
            <Inspector
              pool={pool}
              price={price}
              rules={rules}
              setRules={setRules}
              setLane={setLane}
              setPlan={setPlan}
              selection={selection}
              homeLocked={homeLocked}
              backLocked={backLocked}
              planLocked={planLocked}
              onClose={() => setSelection(null)}
            />
          </div>
        )}

        {backtest && p.range && <Backtest pool={pool} price={price} range={p.range} rules={rules} advanced={advanced} onClose={() => setBacktest(false)} />}

        {adding && (
          <AddList
            pool={pool}
            price={price}
            rules={rules}
            ticks={p.ticks}
            planLocked={planLocked}
            lane={adding.lane}
            second={!!adding.second}
            onPick={(o) => {
              if (o.second) {
                setAdding({ lane: adding.lane, second: true });
                return;
              }
              setRules((r) => o.apply(r));
              setSelection(o.select ?? null);
              setAdding(null);
            }}
            onClose={() => setAdding(null)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the "Add" list: only what fits here

function AddList({
  pool,
  price,
  rules,
  ticks,
  planLocked,
  lane,
  second,
  onPick,
  onClose,
}: {
  pool: Pool;
  price: number;
  rules: Rules;
  ticks?: [number, number];
  planLocked: boolean;
  lane: LaneId;
  second: boolean;
  onPick: (o: Option) => void;
  onClose: () => void;
}) {
  const L = rules[lane];
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const before = useMemo(() => new Set(laneErrors(validate(pool, rules, ticks, { planLocked }), lane)), [pool, rules, ticks, planLocked, lane]);
  // an option is offered only if it leaves this lane valid (or no worse): the list carries the lane's context
  // the first problem an option would add here, if any: it is then shown greyed out with that reason
  const problem = (o: Option) => laneErrors(validate(pool, o.apply(rules), ticks, { planLocked }), lane).find((e) => !before.has(e) && !GENERIC.has(e));
  const fits = (o: Option) => !problem(o);
  const why = (list: Option[]) => list.map((o) => ({ ...o, why: o.second ? undefined : problem(o) })).sort((a, b) => Number(!!a.why) - Number(!!b.why));
  const groups: [string, (Option & { why?: string })[]][] = [];
  if (second || !L.trigger)
    groups.push([second ? `${L.combine === "or" ? "Or" : "And"} when…` : "When…", triggerOptions(pool, lane, price, second).filter((o) => second || true)]);
  else {
    const steps = why(stepOptions(pool, rules, lane).filter((o) => o.id !== "move" || !planLocked || !!rules.plan));
    if (steps.length) groups.push([L.actions.length ? "Then also…" : "Then…", steps]);
    const more = moreOptions(rules, lane).filter((o) => o.second || fits(o));
    if (more.length) groups.push(["More", more]);
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] p-3">
          <div className="text-sm font-semibold">{laneTitle(pool, lane, L)}</div>
          <button onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-2">
          {groups.map(([title, list]) => (
            <div key={title} className="mb-1">
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</div>
              {list.map((o) => (
                <button
                  key={o.id}
                  disabled={!!o.why}
                  onClick={() => onPick(o)}
                  className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left enabled:hover:bg-[var(--line2)] disabled:opacity-45"
                >
                  <div
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r)] ${o.id === "move" ? "bg-[var(--amber-lt)] text-[var(--amber)]" : "bg-[var(--line2)]"}`}
                  >
                    <o.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold">{o.label}</div>
                    <div className="text-[11px] text-[var(--muted)]">{o.why ? `Not here: ${o.why}` : o.hint}</div>
                  </div>
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <div className="p-4 text-center text-[13px] text-[var(--muted)]">Nothing more fits here.</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings of the selected card

function Choice({ on, title, hint, onClick, disabled }: { on: boolean; title: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full rounded-[var(--r)] border p-2.5 text-left disabled:opacity-50 ${on ? "border-[var(--ink)] shadow-[0_0_0_3px_var(--line2)]" : "border-[var(--line)] hover:border-[var(--muted2)]"}`}
    >
      <div className="text-[13px] font-semibold">{title}</div>
      {hint && <div className="text-[11px] text-[var(--muted)]">{hint}</div>}
    </button>
  );
}

function Inspector({
  pool,
  price,
  rules,
  setRules,
  setLane,
  setPlan,
  selection,
  homeLocked,
  backLocked,
  planLocked,
  onClose,
}: {
  pool: Pool;
  price: number;
  rules: Rules;
  setRules: (fn: (r: Rules) => Rules) => void;
  setLane: (lane: LaneId, fn: (l: Lane) => Lane) => void;
  setPlan: (fn: (pl: PlanB) => PlanB) => void;
  selection: Exclude<Selection, null>;
  homeLocked: boolean;
  backLocked: boolean;
  planLocked: boolean;
  onClose: () => void;
}) {
  const lane = selection.lane;
  const L = rules[lane];
  const update = (fn: (l: Lane) => Lane) => setLane(lane, fn);
  const num = (s: string) => (s === "" ? NaN : Number(s));
  let title = "";
  let body: React.ReactNode = null;
  let remove: (() => void) | null = null;
  const plan = rules.plan;
  const back = backLaneOf(lane);

  if (selection.part === "trigger" && L.trigger) {
    title = TITLES[L.trigger.kind];
    remove = () => setRules((r) => removeMove({ ...r, [lane]: emptyLane() }, lane));
    body = <TriggerFields pool={pool} price={price} lane={lane} t={L.trigger} onChange={(nt) => update((l) => ({ ...l, trigger: nt }))} />;
  } else if (selection.part === "trigger2" && L.trigger2) {
    title = "Second condition";
    remove = () => update((l) => ({ ...l, trigger2: null, combine: undefined }));
    body = (
      <>
        <div className="flex flex-col gap-1.5">
          <Choice on={(L.combine ?? "and") === "and"} title="Both must be true" onClick={() => update((l) => ({ ...l, combine: "and" }))} />
          <Choice on={L.combine === "or"} title="Either one is enough" onClick={() => update((l) => ({ ...l, combine: "or" }))} />
        </div>
        <TriggerFields pool={pool} price={price} lane={lane} t={L.trigger2} onChange={(nt) => update((l) => ({ ...l, trigger2: nt }))} />
      </>
    );
  } else if (selection.part === "hold") {
    title = "Only if it lasts";
    remove = () => update((l) => ({ ...l, holdMinutes: undefined }));
    body = (
      <>
        <p className="text-[13px] text-[var(--muted)]">
          The price has to stay past the level on average for this long, not just touch it. Rules always use at least a 2-minute average.
        </p>
        <Field label="Average over" hint="1 to 60 minutes">
          <Suffix value={L.holdMinutes ?? 15} suffix="minutes" onChange={(x) => update((l) => ({ ...l, holdMinutes: num(x) }))} />
          <div className="mt-1.5 flex gap-1">
            {[5, 15, 30, 60].map((m) => (
              <button key={m} className="chip" data-on={L.holdMinutes === m} onClick={() => update((l) => ({ ...l, holdMinutes: m }))}>
                {m} min
              </button>
            ))}
          </div>
        </Field>
      </>
    );
  } else if (selection.part === "step") {
    const a = L.actions.find((x) => x.kind === selection.kind);
    if (a) {
      title = TITLES[a.kind];
      remove = () => update((l) => ({ ...l, actions: l.actions.filter((x) => x.kind !== a.kind && !(a.kind === "withdraw" && x.kind === "convert")) }));
      const set = (patch: Partial<Action>) => update((l) => withAction(l, { ...a, ...patch }));
      body = (
        <>
          {a.kind === "withdraw" && (
            <Field label="How much">
              <div className="flex gap-1">
                {[25, 50, 100].map((x) => (
                  <button key={x} className="chip" data-on={a.pct === x} onClick={() => set({ pct: x })}>
                    {x === 100 ? "All of it" : `${x}%`}
                  </button>
                ))}
              </div>
              <div className="mt-1.5">
                <Suffix value={a.pct ?? 100} suffix="%" onChange={(x) => set({ pct: num(x) })} />
              </div>
            </Field>
          )}
          {a.kind === "convert" && (
            <div className="flex flex-col gap-1.5">
              {(["quote", "base"] as const).map((to) => (
                <Choice key={to} on={a.to === to} title={`Swap to ${to === "quote" ? pool.quote.symbol : pool.base.symbol}`} onClick={() => set({ to })} />
              ))}
              <p className="text-[12px] text-[var(--muted)]">Swapped at once, never worse than your slippage limit.</p>
            </div>
          )}
          {a.kind === "follow" && (
            <Field label="New range width" hint="Placed right next to the price, in the token you hold then">
              <Suffix value={a.widthPct ?? 5} suffix="%" onChange={(x) => set({ widthPct: num(x) })} />
            </Field>
          )}
          {a.kind === "collect" && (
            <p className="text-[13px] text-[var(--muted)]">Fees earned so far go straight to your wallet instead of staying in the position.</p>
          )}
          {a.kind === "readd" && <p className="text-[13px] text-[var(--muted)]">Fees go back into the same range.</p>}
        </>
      );
    }
  } else if (selection.part === "repeat") {
    title = "Repeat";
    remove = () => update((l) => ({ ...l, repeat: false, maxRuns: undefined }));
    const level = [L.trigger, L.trigger2].some((t) => t?.kind === "price" || t?.kind === "otherPool" || t?.kind === "oracle");
    body = (
      <>
        <p className="text-[13px] text-[var(--muted)]">After it runs, this side runs again the next time its condition is met.</p>
        {level && !get(L, "follow") && (
          <Field label="Move the price level after each run by">
            <Suffix value={L.stepPct ?? 5} suffix="%" onChange={(x) => update((l) => ({ ...l, stepPct: num(x) }))} />
          </Field>
        )}
        <Field label="Stop after" hint="Empty = no limit">
          <Suffix value={L.maxRuns ?? undefined} suffix="runs" onChange={(x) => update((l) => ({ ...l, maxRuns: num(x) || undefined }))} />
        </Field>
      </>
    );
  } else if (selection.part === "move" && plan) {
    title = "Move to plan B";
    const move = get(L, "move")!;
    const both = has(rules.down, "move") && has(rules.up, "move");
    const parks = parkable(pool)
      .filter((q) => sharedToken(pool, q) !== "both")
      .slice(0, 3);
    const setMove = (to: "base" | "quote" | undefined) => update((l) => withAction(l, { kind: "move", to }));
    remove = planLocked ? null : () => setRules((r) => removeMove(r, lane));
    body = (
      <>
        <p className="text-[13px] text-[var(--muted)]">Everything is taken out of the range and kept here until it comes back by itself.</p>
        <div className="flex flex-col gap-1.5">
          {(lane === "down" ? (["quote", "base"] as const) : (["base", "quote"] as const)).map((to) => (
            <Choice
              key={to}
              disabled={planLocked}
              on={plan.where === "wait" && move.to === to}
              title={`Hold ${to === "quote" ? pool.quote.symbol : pool.base.symbol}`}
              hint={to === "quote" ? "Sold at once; it waits in the stable token" : "Bought at once; it rides the price"}
              onClick={() => {
                setPlan((pl) => ({ ...pl, where: "wait", parkPool: undefined }));
                setMove(to);
              }}
            />
          ))}
          {parks.map((q) => {
            const sh = sharedToken(pool, q);
            const via = sh === "token0" ? pool.token0.symbol : pool.token1.symbol;
            return (
              <Choice
                key={q.index}
                disabled={planLocked}
                on={plan.where === "park" && plan.parkPool === q.index}
                title={`Park in ${q.label}`}
                hint={`Sold into ${via}, it earns fees there while it waits`}
                onClick={() => {
                  setPlan((pl) => ({ ...pl, where: "park", parkPool: q.index, parkWidthPct: pl.parkWidthPct ?? 0.2 }));
                  setMove(undefined);
                }}
              />
            );
          })}
        </div>
        {plan.where === "park" && (
          <Field label="Parking range" hint="Centred on that pool's price when the money arrives">
            <Suffix value={plan.parkWidthPct ?? 0.2} suffix="% each way" onChange={(x) => !planLocked && setPlan((pl) => ({ ...pl, parkWidthPct: num(x) }))} />
          </Field>
        )}
        {both && <p className="text-[12px] text-[var(--muted)]">Both sides move to the same plan B.</p>}
        {planLocked && <p className="text-[12px] text-[var(--muted)]">Set when the position was created. To change it, withdraw and start a new position.</p>}
      </>
    );
  } else if (selection.part === "back" && plan) {
    title = "Come back when";
    const B = plan.back[back];
    const setBack = (t: Trigger | null) =>
      setPlan((pl) => ({ ...pl, back: { ...pl.back, [back]: { trigger: t, actions: [{ kind: "move" }], repeat: true } } }));
    const b = pool.base.symbol;
    const rising = back === "up";
    const kinds: { id: string; title: string; hint: string; t: () => Trigger }[] = [
      { id: "backIn", title: `${b} is back in my range`, hint: "Comes back as soon as the price is back", t: () => ({ kind: "price", backIn: true }) },
      {
        id: "trail",
        title: rising ? `${b} turns up a % from its low` : `${b} turns down a % from its high`,
        hint: "Waits for the turn",
        t: () => ({ kind: "trail", trailPct: 5 }),
      },
      { id: "timer", title: "After a time", hint: "Waits, then comes back", t: () => ({ kind: "timer", hours: 24 }) },
      {
        id: "price",
        title: `${b} ${rising ? "rises above" : "drops below"} a price`,
        hint: "A price you choose",
        t: () => defaultTrigger("price", pool, back, price, []),
      },
    ];
    const current = B.trigger?.backIn ? "backIn" : B.trigger?.kind;
    body = (
      <>
        <div className="flex flex-col gap-1.5">
          {kinds.map((k) => (
            <Choice key={k.id} disabled={backLocked} on={current === k.id} title={k.title} hint={k.hint} onClick={() => setBack(k.t())} />
          ))}
        </div>
        {B.trigger && !B.trigger.backIn && !backLocked && <TriggerFields pool={pool} price={price} lane={back} t={B.trigger} onChange={(nt) => setBack(nt)} />}
        {backLocked && <p className="text-[12px] text-[var(--muted)]">This can be changed while the money is in plan B.</p>}
      </>
    );
  } else if (selection.part === "into" && plan) {
    title = "Back into";
    body = (
      <div className="flex flex-col gap-1.5">
        <Choice
          disabled={planLocked}
          on={plan.returnTo === "same"}
          title="The same range"
          hint="Your range as it is now"
          onClick={() => setPlan((pl) => ({ ...pl, returnTo: "same" }))}
        />
        <Choice
          disabled={planLocked}
          on={plan.returnTo === "recentre"}
          title="A new range around the price"
          hint="Same width, centred on the price when it comes back"
          onClick={() => setPlan((pl) => ({ ...pl, returnTo: "recentre" }))}
        />
        {planLocked && <p className="text-[12px] text-[var(--muted)]">Set when the position was created.</p>}
      </div>
    );
  }
  const locked = homeLocked && !["back"].includes(selection.part);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <div className={`label ${lane === "up" ? "!text-[var(--sage)]" : "!text-[var(--rose)]"}`}>{laneTitle(pool, lane, L)}</div>
          <div className="text-base font-semibold">{title}</div>
        </div>
        <button className="btn btn-light !p-1.5" onClick={onClose} title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <fieldset disabled={locked} className="flex flex-col gap-4 disabled:opacity-60">
        {body}
      </fieldset>
      {remove && !locked && (
        <button
          className="btn btn-danger mt-2"
          onClick={() => {
            remove!();
            onClose();
          }}
        >
          <Trash2 className="h-4 w-4" /> Remove {selection.part === "trigger" ? "this side's rule" : "this card"}
        </button>
      )}
    </div>
  );
}

/** The settings of one condition. Reads the watched pool's price for hints and quick buttons. */
function TriggerFields({ pool, price, lane, t, onChange }: { pool: Pool; price: number; lane: LaneId; t: Trigger; onChange: (t: Trigger) => void }) {
  const num = (s: string) => (s === "" ? NaN : Number(s));
  const w = watchedBy(pool, t);
  const { data: wState } = useReadContract({ address: CORE.rules, abi: rulesAbi, functionName: "poolState", args: [w.index] });
  const wPrice = wState ? priceAtTick(w, Number(wState[1])) : price;

  // The pair's Chainlink price, for a Chainlink condition: it can differ from the pool's price (on a testnet by a lot),
  // so the default level and the quick buttons start from it.
  const isLink = t.kind === "oracle";
  const feedsAddr = useReadContract({
    address: CORE.conditionalOrders,
    abi: conditionalOrdersAbi,
    functionName: "feeds",
    query: { enabled: isLink, retry: false },
  });
  const linkTick = useReadContract({
    address: feedsAddr.data,
    abi: priceFeedsAbi,
    functionName: "pairTick",
    args: [pool.key.currency0, pool.key.currency1],
    query: { enabled: isLink && !!feedsAddr.data, retry: false },
  });
  const linkPrice = linkTick.data?.[0] ? priceAtTick(pool, Number(linkTick.data[1])) : undefined;
  const linkSettled = feedsAddr.isError || linkTick.isError || linkTick.isFetched;
  const from = isLink ? (linkPrice ?? wPrice) : wPrice;
  useEffect(() => {
    if (isLink && t.price === undefined && linkSettled) onChange({ ...t, price: from * (lane === "down" ? 0.95 : 1.05) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkSettled, isLink]);
  useEffect(() => {
    if (t.kind === "otherPool" && t.price === undefined && wState) onChange({ ...t, price: wPrice * (lane === "down" ? 0.95 : 1.05) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wState, t.poolIndex, t.kind]);

  const chips = <T extends number>(values: T[], current: T | undefined, set: (x: T) => void, label: (x: T) => string) => (
    <div className="mt-1.5 flex gap-1">
      {values.map((x) => (
        <button key={x} className="chip" data-on={current === x} onClick={() => set(x)}>
          {label(x)}
        </button>
      ))}
    </div>
  );

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
      {(t.kind === "price" || t.kind === "otherPool" || t.kind === "oracle") && !t.backIn && (
        <Field
          label={t.kind === "oracle" ? `${w.base.symbol} price on Chainlink` : `${w.base.symbol} price`}
          hint={
            t.kind === "oracle"
              ? `${linkPrice !== undefined ? `Chainlink now ${fmt(linkPrice)} ${w.quote.symbol}` : "No Chainlink price right now"}. A swap in the pool cannot move it.`
              : `Now ${fmt(wPrice)} ${w.quote.symbol}${t.kind === "otherPool" ? ` in ${w.label}` : ""}`
          }
        >
          <Suffix value={t.price === undefined ? undefined : round(t.price)} suffix={w.quote.symbol} onChange={(x) => onChange({ ...t, price: num(x) })} />
          {chips(
            [-10, -5, 5, 10],
            undefined,
            (d) => onChange({ ...t, price: from * (1 + d / 100) }),
            (d) => `${d > 0 ? "+" : ""}${d}%`,
          )}
        </Field>
      )}
      {t.kind === "trail" && (
        <Field
          label={lane === "down" ? `How far ${pool.base.symbol} falls from its high` : `How far ${pool.base.symbol} rises from its low`}
          hint="The best price is remembered on-chain; the keeper updates it."
        >
          <Suffix value={t.trailPct ?? 5} suffix="%" onChange={(x) => onChange({ ...t, trailPct: num(x) })} />
          {chips(
            [2, 5, 10, 20],
            t.trailPct,
            (x) => onChange({ ...t, trailPct: x }),
            (x) => `${x}%`,
          )}
        </Field>
      )}
      {t.kind === "fees" && (
        <Field label="When the fees earned reach" hint="Of the position's value, since the fees were last collected">
          <Suffix value={t.feesPct ?? 0.5} suffix="%" onChange={(x) => onChange({ ...t, feesPct: num(x) })} />
          {chips(
            [0.1, 0.5, 1, 2],
            t.feesPct,
            (x) => onChange({ ...t, feesPct: x }),
            (x) => `${x}%`,
          )}
        </Field>
      )}
      {t.kind === "apr" && (
        <Field label="When the fees earn less than" hint="A yearly rate, from the fees since they were last collected (at least an hour of them)">
          <Suffix value={t.aprPct ?? 5} suffix="% a year" onChange={(x) => onChange({ ...t, aprPct: num(x) })} />
          {chips(
            [2, 5, 10, 20],
            t.aprPct,
            (x) => onChange({ ...t, aprPct: x }),
            (x) => `${x}%`,
          )}
        </Field>
      )}
      {t.kind === "timer" && (
        <Field label="Every">
          <Suffix value={t.hours ?? 24} suffix="hours" onChange={(x) => onChange({ ...t, hours: num(x) })} />
          {chips(
            [1, 6, 24, 168],
            t.hours,
            (h) => onChange({ ...t, hours: h }),
            (h) => (h === 168 ? "1 week" : `${h}h`),
          )}
        </Field>
      )}
    </>
  );
}

function AdvancedBox({ value, onChange }: { value: Advanced; onChange: (a: Advanced) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 rounded-md border border-[var(--line)]">
      <button className="flex w-full items-center justify-between px-2.5 py-1.5 text-[12px] font-semibold" onClick={() => setOpen(!open)}>
        Advanced
        <span className="font-normal text-[var(--muted)]">
          keeper ≤{value.keeperFeeBps / 100}% · slippage {value.slippagePct}% · {value.expiryDays}d
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--line)] p-2.5">
          <Field label="Most a keeper can take per run" hint="Keepers get a gas refund; this is only the cap">
            <Suffix
              value={value.keeperFeeBps / 100}
              suffix="%"
              onChange={(x) => onChange({ ...value, keeperFeeBps: Math.min(100, Math.round(Number(x) * 100)) })}
            />
          </Field>
          <Field label="Swap slippage limit">
            <Suffix value={value.slippagePct} suffix="%" onChange={(x) => onChange({ ...value, slippagePct: Number(x) })} />
          </Field>
          <Field label="Rules expire after">
            <Suffix value={value.expiryDays} suffix="days" onChange={(x) => onChange({ ...value, expiryDays: Math.max(1, Number(x)) })} />
          </Field>
        </div>
      )}
    </div>
  );
}

const round = (n: number) => (n >= 100 ? Math.round(n * 100) / 100 : Number(n.toPrecision(6)));
export { poolByIndex };
export type { TriggerKind };
