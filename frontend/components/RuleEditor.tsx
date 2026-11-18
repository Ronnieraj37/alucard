"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
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
  Layers,
  LineChart as LineChartIcon,
  Link2,
  LogOut,
  MoveHorizontal,
  Plus,
  Repeat,
  Search,
  Shuffle,
  Target,
  Timer,
  Trash2,
  TrendingDown,
  GitMerge,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import Backtest, { type BacktestRange } from "@/components/Backtest";
import { Field, Suffix, Toggle } from "@/components/ui";
import { conditionalOrdersAbi, priceFeedsAbi } from "@/lib/generated/abis";
import { CORE, POOLS, type Pool, fmt, poolByIndex, priceAtTick, samePair } from "@/lib/pools";
import {
  type ActionKind,
  type Advanced,
  type LaneId,
  type Lane,
  type Rules,
  type Trigger,
  type TriggerKind,
  TEMPLATES,
  defaultAction,
  defaultTrigger,
  describeAction,
  describeLane,
  describeTrigger,
  emptyRules,
  watchedBy,
  get,
  isValid,
  laneTitle,
  validate,
  withAction,
} from "@/lib/rules";

// ---------------------------------------------------------------- block catalogue

type BlockDef = { id: string; group: "When" | "Then" | "Flow"; label: string; hint: string; icon: LucideIcon };

const TRIGGERS: (BlockDef & { kind: TriggerKind })[] = [
  { id: "leave", kind: "leave", group: "When", label: "Price leaves my range", hint: "Act when the price moves out of your range", icon: LogOut },
  { id: "price", kind: "price", group: "When", label: "Price reaches a level", hint: "A price you choose, in this pool", icon: Target },
  { id: "otherPool", kind: "otherPool", group: "When", label: "Price in another pool", hint: "Watch any pool in the table, e.g. a bigger one", icon: Crosshair },
  { id: "oracle", kind: "oracle", group: "When", label: "Chainlink price reaches a level", hint: "The market price from Chainlink, not this pool's price", icon: Link2 },
  { id: "timer", kind: "timer", group: "When", label: "On a timer", hint: "Every few hours or days", icon: Clock },
  { id: "trail", kind: "trail", group: "When", label: "Trailing stop", hint: "When the price turns back a set % from its best", icon: TrendingDown },
];

const STEPS: (BlockDef & { kind: ActionKind })[] = [
  { id: "withdraw", kind: "withdraw", group: "Then", label: "Withdraw", hint: "Take some or all liquidity out to your wallet", icon: ArrowDownRight },
  { id: "convert", kind: "convert", group: "Then", label: "Convert to one token", hint: "Swap at once, never worse than your slippage", icon: Shuffle },
  { id: "follow", kind: "follow", group: "Then", label: "Follow the price", hint: "Move the range next to the new price", icon: MoveHorizontal },
  { id: "readd", kind: "readd", group: "Then", label: "Compound", hint: "Put fees back into the same range", icon: Layers },
  { id: "collect", kind: "collect", group: "Then", label: "Send fees to wallet", hint: "Fees go to you instead of staying in", icon: Coins },
];

const REPEAT: BlockDef = { id: "repeat", group: "Flow", label: "Repeat", hint: "Run this side again the next time", icon: Repeat };
const SECOND: BlockDef = { id: "second", group: "Flow", label: "Second condition", hint: "Also needs another condition (and), or either one is enough (or)", icon: GitMerge };
const HOLD: BlockDef = { id: "hold", group: "Flow", label: "Confirm (hold)", hint: "Only act if it is still true some minutes later", icon: Timer };
const FLOW: BlockDef[] = [SECOND, HOLD, REPEAT];

const ICON: Record<string, LucideIcon> = Object.fromEntries([...TRIGGERS, ...STEPS, ...FLOW].map((b) => [b.id, b.icon]));

type Selection = { lane: LaneId; part: "trigger" | "trigger2" | "hold" | "repeat" } | { lane: LaneId; part: "step"; kind: ActionKind } | null;

const minutesLabel = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

// ---------------------------------------------------------------- nodes

type CardData = { kicker: string; title: string; sub?: string; icon?: LucideIcon; tone?: "dark" | "ghost"; warn?: string; selected?: boolean; action?: () => void };

const handleCls = "!h-2 !w-2 !border-2 !border-white !bg-[var(--ink)]";

const CardNode = memo(function CardNode({ data }: NodeProps) {
  const d = data as CardData;
  const Icon = d.icon ?? Plus;
  const ghost = d.tone === "ghost";
  return (
    <div
      className={`relative flex h-[76px] w-[250px] items-center gap-3 rounded-[var(--r-lg)] border px-3 transition-all ${
        ghost
          ? "cursor-pointer border-dashed border-[var(--line)] bg-white/60 text-[var(--muted)] hover:border-[var(--ink)] hover:text-[var(--ink)]"
          : d.selected
            ? "border-[var(--ink)] bg-white shadow-[0_0_0_3px_var(--line2)]"
            : "border-[var(--line)] bg-white hover:border-[var(--muted2)]"
      }`}
    >
      <Handle type="target" position={Position.Top} className={handleCls} />
      <div
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r)] ${
          d.tone === "dark" ? "bg-[var(--ink)] text-white" : ghost ? "bg-transparent" : "bg-[var(--line2)]"
        }`}
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
  const d = data as { up: boolean; title: string; sub: string };
  const Icon = d.up ? ArrowUpRight : ArrowDownRight;
  return (
    <div className={`flex w-[250px] items-center gap-2 rounded-full border px-3 py-1.5 ${d.up ? "border-[var(--sage)]/30 bg-[var(--sage-lt)]" : "border-[var(--rose)]/30 bg-[var(--rose-lt)]"}`}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Icon className={`h-4 w-4 ${d.up ? "text-[var(--sage)]" : "text-[var(--rose)]"}`} />
      <div className="min-w-0">
        <div className={`text-[12px] font-semibold ${d.up ? "text-[var(--sage)]" : "text-[var(--rose)]"}`}>{d.title}</div>
        <div className="text-[10px] text-[var(--muted)]">{d.sub}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
});

const JoinNode = memo(function JoinNode({ data }: NodeProps) {
  const d = data as { or: boolean; action: () => void };
  return (
    <div
      className="flex h-[44px] w-[250px] cursor-pointer items-center justify-center gap-2 rounded-full border border-[var(--ink)] bg-white text-[12px] hover:bg-[var(--line2)]"
      title="Click to switch between AND and OR"
    >
      <Handle type="target" position={Position.Top} className={handleCls} />
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${d.or ? "bg-[var(--amber-lt)] text-[var(--amber)]" : "bg-[var(--ink)] text-white"}`}>{d.or ? "OR" : "AND"}</span>
      <span className="text-[var(--muted)]">{d.or ? "either one is enough" : "both must be true"}</span>
      <Handle type="source" position={Position.Bottom} className={handleCls} />
    </div>
  );
});

const nodeTypes = { card: CardNode, position: PositionNode, side: SideNode, join: JoinNode };

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

const LANE_X: Record<LaneId, number> = { down: -360, up: 360 };
const PAR = 135; // two conditions sit this far left and right of the lane
const Y_SIDE = 150;
const Y0 = 220;
const DY = 112;

function EditorInner(p: RuleEditorProps) {
  const { pool, price } = p;
  const [rules, setRules] = useState<Rules>(p.initialRules);
  const [advanced, setAdvanced] = useState<Advanced>(p.initialAdvanced);
  const [selection, setSelection] = useState<Selection>(null);
  const [picker, setPicker] = useState<LaneId | null>(null);
  const [second, setSecond] = useState<LaneId | null>(null); // choosing a second condition for this lane
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const [showSummary, setShowSummary] = useState(true);
  const [backtest, setBacktest] = useState(false);
  const v = useMemo(() => validate(pool, rules), [pool, rules]);
  const { fitView } = useReactFlow();
  const empty = !rules.down.trigger && !rules.up.trigger;

  const setLane = useCallback((lane: LaneId, fn: (l: Lane) => Lane) => setRules((r) => ({ ...r, [lane]: fn(r[lane]) })), []);

  // ---------------- graph from rules
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const at = (id: string, x: number, y: number) => moved[id] ?? { x, y };
    nodes.push({ id: "position", type: "position", width: 280, height: 86, position: at("position", -140, 0), data: { title: pool.label, range: p.rangeLabel, amounts: p.amountsLabel ?? "" } });

    (["down", "up"] as LaneId[]).forEach((lane) => {
      const L = rules[lane];
      const x = LANE_X[lane];
      const sideId = `${lane}-side`;
      nodes.push({
        id: sideId,
        type: "side",
        width: 250,
        height: 46,
        position: at(sideId, x, Y_SIDE),
        data: { up: lane === "up", title: laneTitle(pool, lane, L), sub: lane === "up" ? "Upper side" : "Lower side" },
      });
      edges.push({ id: `e-pos-${lane}`, source: "position", target: sideId, type: "smoothstep", style: { stroke: "var(--muted2)" } });

      let prev = sideId;
      let y = Y0;
      const push = (id: string, data: CardData, dashed = false) => {
        nodes.push({ id, type: "card", width: 250, height: 76, position: at(id, x, y), data });
        edges.push({ id: `e-${prev}-${id}`, source: prev, target: id, type: "smoothstep", animated: !dashed, style: dashed ? { strokeDasharray: "4 4" } : undefined });
        prev = id;
        y += DY;
      };

      if (!L.trigger) {
        push(`${lane}-start`, { kicker: "", title: "Choose when", sub: "Nothing happens on this side yet", tone: "ghost", action: () => setPicker(lane) }, true);
        return;
      }
      const sel = selection;
      const cardA: CardData = {
        kicker: "When",
        title: TRIGGERS.find((t) => t.kind === L.trigger!.kind)!.label,
        sub: describeTrigger(pool, lane, L.trigger),
        icon: ICON[L.trigger.kind],
        tone: "dark",
        warn: v[lane][0],
        selected: sel?.part === "trigger" && sel.lane === lane,
        action: () => setSelection({ lane, part: "trigger" }),
      };
      if (L.trigger2) {
        // two conditions side by side, joined by AND / OR, then the steps below the join
        const idA = `${lane}-trigger`;
        const idB = `${lane}-trigger2`;
        const idJ = `${lane}-join`;
        nodes.push({ id: idA, type: "card", width: 250, height: 76, position: at(idA, x - PAR, y), data: cardA });
        nodes.push({
          id: idB,
          type: "card",
          width: 250,
          height: 76,
          position: at(idB, x + PAR, y),
          data: {
            kicker: L.combine === "or" ? "Or when" : "And when",
            title: TRIGGERS.find((t) => t.kind === L.trigger2!.kind)!.label,
            sub: describeTrigger(pool, lane, L.trigger2),
            icon: ICON[L.trigger2.kind],
            tone: "dark",
            selected: sel?.part === "trigger2" && sel.lane === lane,
            action: () => setSelection({ lane, part: "trigger2" }),
          } satisfies CardData,
        });
        for (const id of [idA, idB]) edges.push({ id: `e-${sideId}-${id}`, source: sideId, target: id, type: "smoothstep", animated: true });
        y += DY;
        const or = L.combine === "or";
        nodes.push({
          id: idJ,
          type: "join",
          width: 250,
          height: 44,
          position: at(idJ, x, y - 14),
          data: { or, action: () => setLane(lane, (l) => ({ ...l, combine: or ? "and" : "or" })) },
        });
        for (const id of [idA, idB]) edges.push({ id: `e-${id}-${idJ}`, source: id, target: idJ, type: "smoothstep", animated: true });
        prev = idJ;
        y += 64;
      } else {
        push(`${lane}-trigger`, cardA);
        // a second condition is a branch beside the first, not a step after it
        const idG = `${lane}-second`;
        nodes.push({
          id: idG,
          type: "card",
          width: 150,
          height: 76,
          position: at(idG, x + 262, y - DY),
          data: { kicker: "", title: "And / Or", sub: "add a 2nd condition", tone: "ghost", action: () => setSecond(lane) } satisfies CardData,
        });
        edges.push({ id: `e-${sideId}-${idG}`, source: sideId, target: idG, type: "smoothstep", style: { strokeDasharray: "4 4" } });
      }
      if (L.holdMinutes)
        push(`${lane}-hold`, {
          kicker: "Confirm",
          title: `Still true after ${minutesLabel(L.holdMinutes)}`,
          sub: "Anyone can arm it; it runs after the wait",
          icon: Timer,
          selected: sel?.part === "hold" && sel.lane === lane,
          action: () => setSelection({ lane, part: "hold" }),
        });
      L.actions.forEach((a) =>
        push(`${lane}-${a.kind}`, {
          kicker: "Then",
          title: STEPS.find((s) => s.kind === a.kind)!.label,
          sub: describeAction(pool, a),
          icon: ICON[a.kind],
          selected: sel?.part === "step" && sel.lane === lane && sel.kind === a.kind,
          action: () => setSelection({ lane, part: "step", kind: a.kind }),
        }),
      );
      if (L.repeat)
        push(`${lane}-repeat`, {
          kicker: "Finally",
          title: "Repeat",
          sub: L.maxRuns ? `At most ${L.maxRuns} runs` : "Runs again the next time",
          icon: Repeat,
          selected: sel?.part === "repeat" && sel.lane === lane,
          action: () => setSelection({ lane, part: "repeat" }),
        });
      push(`${lane}-add`, { kicker: "", title: L.actions.length ? "Add a step" : "Add what to do", tone: "ghost", action: () => setPicker(lane) }, true);
    });
    return { nodes, edges };
  }, [rules, selection, v, moved, pool, p.rangeLabel, p.amountsLabel]);

  const count = nodes.length;
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.25, maxZoom: 1, duration: 250 }), 60);
    return () => clearTimeout(t);
  }, [count, fitView]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const pos = changes.filter((c) => c.type === "position" && c.position);
      if (!pos.length) return;
      const next = applyNodeChanges(pos, nodes);
      setMoved((m) => {
        const out = { ...m };
        for (const c of pos) if (c.type === "position") out[c.id] = next.find((n) => n.id === c.id)!.position;
        return out;
      });
    },
    [nodes],
  );

  // ---------------- picking blocks
  const pick = (lane: LaneId, id: string) => {
    const others = watchable(pool);
    const t = TRIGGERS.find((x) => x.id === id);
    const s = STEPS.find((x) => x.id === id);
    if (t) {
      const trig = defaultTrigger(t.kind, pool, lane, price, others);
      if (trig.kind === "otherPool" && !samePair(pool).some((q) => q.index === trig.poolIndex)) trig.price = undefined;
      setLane(lane, (l) => ({ ...l, trigger: trig }));
      setSelection({ lane, part: "trigger" });
    } else if (s) {
      setLane(lane, (l) => withAction(l, defaultAction(s.kind)));
      setSelection({ lane, part: "step", kind: s.kind });
    } else if (id === "second") {
      setSecond(lane);
    } else if (id === "hold") {
      setLane(lane, (l) => ({ ...l, holdMinutes: 30 }));
      setSelection({ lane, part: "hold" });
    } else {
      setLane(lane, (l) => ({ ...l, repeat: true, stepPct: l.stepPct ?? 5 }));
      setSelection({ lane, part: "repeat" });
    }
    setPicker(null);
  };

  const applyTemplate = (id: string) => {
    if (!id) return;
    setRules(TEMPLATES.find((t) => t.id === id)!.build(pool, price));
    setSelection(null);
    setMoved({});
  };

  const errors = [...v.down, ...v.up, ...v.general];

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
        <select className="input ml-auto !w-auto !py-1.5 text-[13px]" value="" onChange={(e) => applyTemplate(e.target.value)}>
          <option value="">Start from a template…</option>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}: {t.hint}
            </option>
          ))}
        </select>
        {!empty && (
          <button
            className="btn btn-light"
            onClick={() => {
              setRules(emptyRules());
              setSelection(null);
              setMoved({});
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

      {/* canvas */}
      <div className="relative flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, n) => (n.data as { action?: () => void }).action?.()}
          onPaneClick={() => setSelection(null)}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--line)" />
          <Controls showInteractive={false} className="!rounded-[var(--r)] !border !border-[var(--line)] !bg-white !shadow-sm" />
          <MiniMap pannable zoomable className="!rounded-[var(--r)] !border !border-[var(--line)] !bg-white" nodeColor={(n) => (n.type === "position" ? "#0e0f11" : n.type === "side" ? "#c9cdd3" : "#6b717d")} maskColor="rgba(247,248,249,0.7)" />
        </ReactFlow>

        {empty && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-[var(--line)] bg-white px-4 py-2 text-[13px] text-[var(--muted)] shadow-sm">
            Click <b className="text-[var(--ink)]">Choose when</b> on a side, or start from a template.
          </div>
        )}

        {/* summary (top-left, collapsible) */}
        {!selection && !empty && (
          <div className="absolute left-4 top-4 w-[320px] rounded-[var(--r-lg)] border border-[var(--line)] bg-white shadow-sm">
            <button className="flex w-full items-center justify-between px-3 py-2 text-[13px] font-semibold" onClick={() => setShowSummary(!showSummary)}>
              In plain words
              {errors.length > 0 ? (
                <span className="text-[11px] font-medium text-[var(--amber)]">
                  {errors.length} to fix
                </span>
              ) : (
                <span className="text-[11px] font-normal text-[var(--muted)]">{showSummary ? "Hide" : "Show"}</span>
              )}
            </button>
            {showSummary && (
              <div className="flex flex-col gap-2 border-t border-[var(--line)] p-3 text-[12px]">
                {(["down", "up"] as LaneId[]).map((lane) => {
                  const text = describeLane(pool, lane, rules[lane]);
                  return (
                    <div key={lane}>
                      <span className={`font-semibold ${lane === "up" ? "text-[var(--sage)]" : "text-[var(--rose)]"}`}>{laneTitle(pool, lane, rules[lane])}: </span>
                      {text ?? <span className="text-[var(--muted)]">nothing happens.</span>}
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
            )}
          </div>
        )}

        {/* settings drawer */}
        {selection && (
          <div className="absolute bottom-0 right-0 top-0 w-[360px] overflow-y-auto border-l border-[var(--line)] bg-white p-4 shadow-[-8px_0_24px_rgba(0,0,0,0.04)]">
            <Inspector pool={pool} price={price} rules={rules} setLane={setLane} selection={selection} onClose={() => setSelection(null)} />
          </div>
        )}

        {backtest && p.range && (
          <Backtest pool={pool} price={price} range={p.range} rules={rules} advanced={advanced} onClose={() => setBacktest(false)} />
        )}

        {picker && <Picker lane={picker} pool={pool} lane_={rules[picker]} onPick={(id) => pick(picker, id)} onClose={() => setPicker(null)} />}
        {second && (
          <SecondPicker
            pool={pool}
            lane={second}
            lane_={rules[second]}
            onPick={(kind, combine) => {
              setLane(second, (l) => ({ ...l, trigger2: defaultTrigger(kind, pool, second, price, watchable(pool)), combine }));
              setSelection({ lane: second, part: "trigger2" });
              setSecond(null);
            }}
            onClose={() => setSecond(null)}
          />
        )}
      </div>
    </div>
  );
}

/** Pools a trigger can watch: same pair first, then every other pool in the table. */
export const watchable = (p: Pool) => [...samePair(p), ...POOLS.filter((q) => q.index !== p.index && !samePair(p).includes(q))];

// ---------------------------------------------------------------- picker (like arbitrax's action picker)

function Picker({ lane, pool, lane_, onPick, onClose }: { lane: LaneId; pool: Pool; lane_: Lane; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<"All" | "When" | "Then" | "Flow">(lane_.trigger ? "Then" : "When");
  const all: BlockDef[] = [...TRIGGERS, ...STEPS, ...FLOW];
  const list = all.filter((b) => (group === "All" || b.group === group) && (b.label + b.hint).toLowerCase().includes(q.toLowerCase()));
  const disabled = (b: BlockDef) => {
    if (b.group !== "When" && !lane_.trigger) return "Choose when first";
    if (b.group === "Then" && lane_.actions.some((a) => a.kind === b.id)) return "Already added";
    if (b.id === "repeat" && lane_.repeat) return "Already added";
    if (b.id === "second" && lane_.trigger2) return "Already added";
    if (b.id === "hold" && lane_.holdMinutes) return "Already added";
    const trails = lane_.trigger?.kind === "trail" || lane_.trigger2?.kind === "trail";
    if (b.id === "hold" && trails) return "Not with a trailing stop";
    if (b.id === "trail" && lane_.holdMinutes) return "Not with a hold";
    if (b.id === "follow" && lane_.trigger && lane_.trigger.kind !== "leave") return "Needs “Price leaves my range”";
    return null;
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-[var(--line)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold">{laneTitle(pool, lane, lane_)}</div>
            <button onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search blocks" className="input !pl-8" />
          </div>
          <div className="mt-2 flex gap-1.5">
            {(["All", "When", "Then", "Flow"] as const).map((g) => (
              <button key={g} className="chip" data-on={group === g} onClick={() => setGroup(g)}>
                {g}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {list.map((b) => {
            const why = disabled(b);
            const replace = b.group === "When" && lane_.trigger;
            return (
              <button
                key={b.id}
                disabled={!!why}
                onClick={() => onPick(b.id)}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-[var(--line2)] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r)] ${b.group === "When" ? "bg-[var(--ink)] text-white" : "bg-[var(--line2)]"}`}>
                  <b.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold">
                    {b.label}
                    {replace && !why && <span className="ml-1.5 text-[11px] font-normal text-[var(--muted)]">(replaces the current one)</span>}
                  </div>
                  <div className="text-[11px] text-[var(--muted)]">{why ?? b.hint}</div>
                </div>
              </button>
            );
          })}
          {!list.length && <div className="p-4 text-center text-[13px] text-[var(--muted)]">No blocks match.</div>}
        </div>
      </div>
    </div>
  );
}

/** Choosing a second condition: AND / OR first, then which condition. */
function SecondPicker({ pool, lane, lane_, onPick, onClose }: { pool: Pool; lane: LaneId; lane_: Lane; onPick: (k: TriggerKind, c: "and" | "or") => void; onClose: () => void }) {
  const [combine, setCombine] = useState<"and" | "or">("and");
  const follows = lane_.actions.some((a) => a.kind === "follow");
  const disabled = (k: TriggerKind) => {
    if (k === "trail" && lane_.trigger?.kind === "trail") return "Already the first condition";
    if (k === "trail" && lane_.holdMinutes) return "Not with a hold";
    if (combine === "or" && follows) return "“Follow the price” needs “and”";
    return null;
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md overflow-hidden rounded-[var(--r-lg)] border border-[var(--line)] bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-[var(--line)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold">{laneTitle(pool, lane, lane_)}: a second condition</div>
            <button onClick={onClose}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(["and", "or"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setCombine(c)}
                className={`rounded-[var(--r)] border p-2.5 text-left ${combine === c ? "border-[var(--ink)] shadow-[0_0_0_3px_var(--line2)]" : "border-[var(--line)]"}`}
              >
                <div className="text-[13px] font-semibold">{c === "and" ? "AND" : "OR"}</div>
                <div className="text-[11px] text-[var(--muted)]">{c === "and" ? "Both must be true at the same time" : "Either one is enough"}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {TRIGGERS.map((b) => {
            const why = disabled(b.kind);
            return (
              <button
                key={b.id}
                disabled={!!why}
                onClick={() => onPick(b.kind, combine)}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-[var(--line2)] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r)] bg-[var(--ink)] text-white">
                  <b.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold">
                    {combine === "and" ? "And" : "Or"}: {b.label.toLowerCase()}
                  </div>
                  <div className="text-[11px] text-[var(--muted)]">{why ?? b.hint}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings for the selected block

function Inspector({
  pool,
  price,
  rules,
  setLane,
  selection,
  onClose,
}: {
  pool: Pool;
  price: number;
  rules: Rules;
  setLane: (lane: LaneId, fn: (l: Lane) => Lane) => void;
  selection: Exclude<Selection, null>;
  onClose: () => void;
}) {
  const lane = selection.lane;
  const L = rules[lane];
  const update = (fn: (l: Lane) => Lane) => setLane(lane, fn);
  const num = (s: string) => (s === "" ? NaN : Number(s));
  let title = "";
  let body: React.ReactNode = null;
  let remove: (() => void) | null = null;

  if (selection.part === "trigger" && L.trigger) {
    const t = L.trigger;
    title = TRIGGERS.find((b) => b.kind === t.kind)!.label;
    remove = () => update(() => ({ trigger: null, actions: [], repeat: false }));
    body = (
      <>
        <TriggerFields pool={pool} price={price} lane={lane} t={t} onChange={(nt) => update((l) => ({ ...l, trigger: nt }))} />
        <label className="flex items-center justify-between text-[13px] font-medium">
          Repeat after it runs
          <Toggle value={L.repeat} onChange={(on) => update((l) => ({ ...l, repeat: on, stepPct: l.stepPct ?? 5 }))} />
        </label>
      </>
    );
  } else if (selection.part === "trigger2" && L.trigger2) {
    const t = L.trigger2;
    title = "Second condition";
    remove = () => update((l) => ({ ...l, trigger2: null, combine: undefined }));
    body = (
      <>
        <Field label="Run when" hint={L.combine === "or" ? "Either condition alone is enough" : "Both conditions must be true at the same time"}>
          <div className="flex gap-1.5">
            {(["and", "or"] as const).map((c) => (
              <button key={c} className="chip" data-on={(L.combine ?? "and") === c} onClick={() => update((l) => ({ ...l, combine: c }))}>
                {c === "and" ? "Both (and)" : "Either one (or)"}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Condition">
          <select
            className="input"
            value={t.kind}
            onChange={(e) => update((l) => ({ ...l, trigger2: defaultTrigger(e.target.value as TriggerKind, pool, lane, price, watchable(pool)) }))}
          >
            {TRIGGERS.map((b) => (
              <option key={b.kind} value={b.kind} disabled={b.kind === "trail" && (L.trigger?.kind === "trail" || !!L.holdMinutes)}>
                {b.label}
              </option>
            ))}
          </select>
        </Field>
        <TriggerFields pool={pool} price={price} lane={lane} t={t} onChange={(nt) => update((l) => ({ ...l, trigger2: nt }))} />
      </>
    );
  } else if (selection.part === "hold") {
    title = "Confirm (hold)";
    remove = () => update((l) => ({ ...l, holdMinutes: undefined }));
    body = (
      <>
        <p className="text-[13px] text-[var(--muted)]">
          When the condition becomes true, anyone can arm this side. It runs only if the condition is still true after the wait, within the same length of time
          again. A short wick or a price pushed for one block does not trigger it.
        </p>
        <Field label="Wait">
          <Suffix value={L.holdMinutes ?? 30} suffix="minutes" onChange={(x) => update((l) => ({ ...l, holdMinutes: num(x) }))} />
          <div className="mt-1.5 flex gap-1">
            {[5, 15, 30, 60, 240].map((m) => (
              <button key={m} className="chip" data-on={L.holdMinutes === m} onClick={() => update((l) => ({ ...l, holdMinutes: m }))}>
                {minutesLabel(m)}
              </button>
            ))}
          </div>
        </Field>
      </>
    );
  } else if (selection.part === "step") {
    const a = L.actions.find((x) => x.kind === selection.kind);
    if (a) {
      title = STEPS.find((b) => b.kind === a.kind)!.label;
      remove = () => update((l) => ({ ...l, actions: l.actions.filter((x) => x.kind !== a.kind) }));
      const set = (patch: object) => update((l) => withAction(l, { ...a, ...patch }));
      body = (
        <>
          {a.kind === "withdraw" && (
            <Field label="How much">
              <Suffix value={a.pct ?? 100} suffix="%" onChange={(x) => set({ pct: num(x) })} />
              <div className="mt-1.5 flex gap-1">
                {[25, 50, 100].map((x) => (
                  <button key={x} className="chip" data-on={a.pct === x} onClick={() => set({ pct: x })}>
                    {x}%
                  </button>
                ))}
              </div>
            </Field>
          )}
          {a.kind === "convert" && (
            <Field label="Convert everything to" hint="Swapped at once, never worse than your slippage limit">
              <div className="flex gap-1.5">
                {(["quote", "base"] as const).map((to) => (
                  <button key={to} className="chip" data-on={a.to === to} onClick={() => set({ to })}>
                    {to === "quote" ? pool.quote.symbol : pool.base.symbol}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {a.kind === "follow" && (
            <Field label="New range width" hint="Placed right next to the price, in the token you hold at that moment">
              <Suffix value={a.widthPct ?? 5} suffix="%" onChange={(x) => set({ widthPct: num(x) })} />
            </Field>
          )}
          {a.kind === "collect" && <p className="text-[13px] text-[var(--muted)]">Fees earned so far go straight to your wallet instead of staying in the position.</p>}
          {a.kind === "readd" && <p className="text-[13px] text-[var(--muted)]">Fees (and anything withdrawn) go back into the same range. Works best with a timer.</p>}
        </>
      );
    }
  } else if (selection.part === "repeat") {
    title = "Repeat";
    remove = () => update((l) => ({ ...l, repeat: false }));
    const isPriceT = (t?: Trigger | null) => t?.kind === "price" || t?.kind === "otherPool" || t?.kind === "oracle";
    const priceTrigger = isPriceT(L.trigger) || isPriceT(L.trigger2);
    body = (
      <>
        <p className="text-[13px] text-[var(--muted)]">After it runs, this side stays on and runs again the next time its trigger is met.</p>
        {priceTrigger && !get(L, "follow") && (
          <Field label="Move the trigger price after each run by">
            <Suffix value={L.stepPct ?? 5} suffix="%" onChange={(x) => update((l) => ({ ...l, stepPct: num(x) }))} />
          </Field>
        )}
        <Field label="Stop after" hint="0 = no limit">
          <Suffix value={L.maxRuns ?? 0} suffix="runs" onChange={(x) => update((l) => ({ ...l, maxRuns: num(x) || undefined }))} />
        </Field>
      </>
    );
  }

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
      {body}
      {remove && (
        <button
          className="btn btn-danger mt-2"
          onClick={() => {
            remove!();
            onClose();
          }}
        >
          <Trash2 className="h-4 w-4" /> Remove {selection.part === "trigger" ? "this side's rule" : "this block"}
        </button>
      )}
    </div>
  );
}

/** The settings of one condition (A or B). Reads the watched pool's price for hints and quick buttons. */
function TriggerFields({ pool, price, lane, t, onChange }: { pool: Pool; price: number; lane: LaneId; t: Trigger; onChange: (t: Trigger) => void }) {
  const num = (s: string) => (s === "" ? NaN : Number(s));
  const w = watchedBy(pool, t);
  const { data: wState } = useReadContract({ address: CORE.conditionalOrders, abi: conditionalOrdersAbi, functionName: "poolState", args: [w.index] });
  const wPrice = wState ? priceAtTick(w, Number(wState[1])) : price;

  // The Chainlink price of this pair, for a Chainlink condition. It can differ from the pool's price (on a testnet by
  // a lot), so the default level and the quick buttons start from it. Without it (no feed answer) the pool's price is used.
  const isLink = t.kind === "oracle";
  const feedsAddr = useReadContract({ address: CORE.conditionalOrders, abi: conditionalOrdersAbi, functionName: "feeds", query: { enabled: isLink, retry: false } });
  const linkTick = useReadContract({
    address: feedsAddr.data,
    abi: priceFeedsAbi,
    functionName: "pairTick",
    args: [pool.key.currency0, pool.key.currency1],
    query: { enabled: isLink && !!feedsAddr.data, retry: false },
  });
  const linkPrice = linkTick.data?.[0] ? priceAtTick(pool, Number(linkTick.data[1])) : undefined;
  const linkSettled = feedsAddr.isError || linkTick.isError || linkTick.isFetched;
  const from = isLink ? linkPrice ?? wPrice : wPrice; // the price the quick buttons and defaults start from
  useEffect(() => {
    if (isLink && t.price === undefined && linkSettled) onChange({ ...t, price: from * (lane === "down" ? 0.95 : 1.05) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkSettled, isLink]);

  // a new "price in another pool" condition gets that pool's price once it has loaded
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
      {(t.kind === "price" || t.kind === "otherPool" || t.kind === "oracle") && (
        <Field
          label={t.kind === "oracle" ? `${w.base.symbol} price on Chainlink` : `${w.base.symbol} price`}
          hint={
            t.kind === "oracle"
              ? `${linkPrice !== undefined ? `Chainlink now ${fmt(linkPrice)} ${w.quote.symbol}` : "No Chainlink price right now"} (this pool: ${fmt(wPrice)} ${w.quote.symbol}). The rule reads Chainlink's price, which a swap in the pool cannot move. An old Chainlink price never fires it.`
              : `Now ${fmt(wPrice)} ${w.quote.symbol}${t.kind === "otherPool" ? ` in ${w.label}` : ""}`
          }
        >
          <Suffix value={t.price === undefined ? undefined : round(t.price)} suffix={w.quote.symbol} onChange={(x) => onChange({ ...t, price: num(x) })} />
          <div className="mt-1.5 flex gap-1">
            {[-10, -5, 5, 10].map((d) => (
              <button key={d} className="chip" onClick={() => onChange({ ...t, price: from * (1 + d / 100) })}>
                {d > 0 ? "+" : ""}
                {d}%
              </button>
            ))}
          </div>
        </Field>
      )}
      {t.kind === "trail" && (
        <Field
          label={lane === "down" ? `Act when ${pool.base.symbol} falls this far from its highest price` : `Act when ${pool.base.symbol} rises this far from its lowest price`}
          hint="The best price is remembered on-chain. Anyone can update it as the price moves (the keeper does)."
        >
          <Suffix value={t.trailPct ?? 5} suffix="%" onChange={(x) => onChange({ ...t, trailPct: num(x) })} />
          <div className="mt-1.5 flex gap-1">
            {[2, 5, 10, 20].map((x) => (
              <button key={x} className="chip" data-on={t.trailPct === x} onClick={() => onChange({ ...t, trailPct: x })}>
                {x}%
              </button>
            ))}
          </div>
        </Field>
      )}
      {t.kind === "timer" && (
        <Field label="Every">
          <Suffix value={t.hours ?? 24} suffix="hours" onChange={(x) => onChange({ ...t, hours: num(x) })} />
          <div className="mt-1.5 flex gap-1">
            {[1, 6, 24, 168].map((h) => (
              <button key={h} className="chip" data-on={t.hours === h} onClick={() => onChange({ ...t, hours: h })}>
                {h === 168 ? "1 week" : `${h}h`}
              </button>
            ))}
          </div>
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
            <Suffix value={value.keeperFeeBps / 100} suffix="%" onChange={(x) => onChange({ ...value, keeperFeeBps: Math.min(100, Math.round(Number(x) * 100)) })} />
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
