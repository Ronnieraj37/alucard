"use client";

import { ArrowLeft, Clock, Pencil, Play, RefreshCw, Sparkles, Waypoints } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type Abi } from "viem";
import { useAccount } from "wagmi";
import StrategyEditor from "@/components/StrategyEditor";
import { Empty, PoolIcons, TxLine } from "@/components/ui";
import { conditionalOrdersAbi } from "@/lib/generated/abis";
import { type RulePosition, type SideMemo, liveLanes, liveSide, useRulePosition } from "@/lib/positions";
import { CORE, type Pool, fmt, maxUsable, minUsable, priceAtTick, priceRange } from "@/lib/pools";
import { type Advanced, type Lane, type LaneId, type Rules, describeBack, describeLane, describePlan, describeWhen, laneTitle, updateParams } from "@/lib/rules";
import { useTx } from "@/lib/tx";

export default function PositionDetail({ id }: { id: bigint }) {
  const router = useRouter();
  const { address } = useAccount();
  const q = useRulePosition(id);
  const tx = useTx();
  const [editor, setEditor] = useState(false);
  const p = q.data;

  if (q.isLoading) return <Wrap><Empty text="Loading…" /></Wrap>;
  if (q.isError) return <Wrap><Empty text="Couldn't load this position. Check your connection and try again." /></Wrap>;
  if (!p) return <Wrap><Empty text="This position is closed or does not exist." /></Wrap>;

  const c = { address: CORE.conditionalOrders, abi: conditionalOrdersAbi as Abi };
  const full = p.tickLower === minUsable(p.pool.key.tickSpacing) && p.tickUpper === maxUsable(p.pool.key.tickSpacing);
  const [lo, hi] = priceRange(p.pool, p.tickLower, p.tickUpper);
  const price = priceAtTick(p.pool, p.tick);
  const inRange = p.tick >= p.tickLower && p.tick < p.tickUpper;
  const rangeLabel = full ? "Full range" : `${fmt(lo)} – ${fmt(hi)} ${p.pool.quote.symbol}`;
  const owner = !!address;
  const lanes = liveLanes(p);

  const run = (lane: LaneId) =>
    tx.run(async () => {
      await tx.send("Run this step", { ...c, functionName: "execute", args: [p.id, liveSide(p, lane)] });
      q.refetch();
    }, "Done");
  const poke = (lane: LaneId) =>
    tx.run(async () => {
      await tx.send("Update", { ...c, functionName: "poke", args: [p.id, liveSide(p, lane)] });
      q.refetch();
    }, "Updated");
  const close = () =>
    tx.run(async () => {
      await tx.send("Withdraw everything", { ...c, functionName: "cancel", args: [p.id] });
      router.push("/pool");
    }, "Withdrawn to your wallet");
  const save = (rules: Rules, adv: Advanced) =>
    tx.run(async () => {
      await tx.send("Save strategy", { ...c, functionName: "updateOrder", args: [p.id, updateParams(p.pool, rules, p.liveIsHome, adv, [p.tickLower, p.tickUpper])] });
      setEditor(false);
      q.refetch();
    }, "Strategy saved");

  return (
    <Wrap>
      <Link href="/pool" className="flex items-center gap-1 text-[13px] text-[var(--muted)] hover:text-[var(--ink)]">
        <ArrowLeft className="h-4 w-4" /> Positions
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <PoolIcons pool={p.pool} />
        <h1 className="text-xl font-semibold">
          {p.pool.base.symbol} / {p.pool.quote.symbol}
        </h1>
        <span className="rounded bg-[var(--line2)] px-1.5 py-0.5 text-[11px] font-semibold">{p.pool.key.fee / 10_000}%</span>
        <StatusBadge p={p} inRange={inRange} />
        <span className="text-[12px] text-[var(--muted)]">#{String(p.id)}</span>
      </div>

      <p className="-mt-1 text-[14px] text-[var(--ink2)]">{statusLine(p, inRange, lanes)}</p>

      {/* the position at a glance: one strip */}
      <div className="card grid gap-3 p-4 sm:grid-cols-3">
        <div>
          <div className="label mb-0.5">{p.status === "home" ? "Liquidity" : p.status === "waiting" ? "Held while moved" : `In ${p.livePool.base.symbol}/${p.livePool.quote.symbol}`}</div>
          <div className="text-[14px]">
            {fmt(p.amount0)} {p.livePool.token0.symbol} + {fmt(p.amount1)} {p.livePool.token1.symbol}
          </div>
          {p.status === "parked" && p.liveRange && <ParkedRange pool={p.livePool} range={p.liveRange} tick={p.liveTick} />}
        </div>
        <div>
          <div className="label mb-0.5">{p.status === "home" ? "Range" : "Range when it comes back"}</div>
          <div className="text-[14px]">{p.status !== "home" && p.rules.plan?.returnTo === "recentre" ? "Centred on the price, same width" : rangeLabel}</div>
        </div>
        <div>
          <div className="label mb-0.5">Now</div>
          <div className="text-[14px]">
            1 {p.pool.base.symbol} = {fmt(price)} {p.pool.quote.symbol}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          <div className="font-semibold">{p.liveIsHome ? "Strategy" : "Moved: coming back"}</div>
          <span className="text-[12px] text-[var(--muted)]">· expires {new Date(p.expiry * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
          {owner && <button className="btn btn-light ml-auto !py-1.5" onClick={() => setEditor(true)}>
            <Pencil className="h-3.5 w-3.5" /> {p.liveIsHome ? "Edit strategy" : "Edit when it comes back"}
          </button>}
        </div>
        <div className="flex flex-col divide-y divide-[var(--line2)]">
          {(["down", "up"] as LaneId[]).map((lane) => {
            const L = lanes[lane];
            const text = p.liveIsHome
              ? describeLane(p.pool, lane, L, p.rules.plan)
              : L.trigger
                ? `${describeWhen(p.pool, lane, L)}: come back into ${p.rules.plan!.returnTo === "same" ? "the same range" : "a new range around the price"}.`
                : null;
            return (
              <div key={lane} className="flex items-center gap-3 py-2.5 text-[13px] first:pt-0">
                <div className="flex-1">
                  <span className={`mb-1 inline-block rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${lane === "up" ? "bg-[var(--sage-lt)] text-[var(--sage)]" : "bg-[var(--rose-lt)] text-[var(--rose)]"}`}>{laneTitle(p.pool, lane, L)}</span>
                  <div />
                  {text ?? <span className="text-[var(--muted)]">Nothing happens.</span>}
                  {p.memo[lane] && <MemoLine m={p.memo[lane]!} pool={p.pool} lane={lane} />}
                  {L.trigger && (p.lastRun?.[lane] ?? 0) > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      <Clock className="h-3 w-3" /> {p.status === "home" ? "Last ran or set" : "Moved"} {ago(p.lastRun[lane])}
                    </div>
                  )}
                  {p.blocked?.[lane] && <div className="mt-1 text-[12px] text-[var(--amber)]">Its condition is true, but it cannot run yet: {p.blocked[lane]}</div>}
                </div>
                {p.memo[lane]?.pokeable && !p.ready[lane] && (
                  <button className="btn btn-light shrink-0" disabled={!owner || tx.state.busy} onClick={() => poke(lane)} title="Anyone can do this; it moves no tokens. Keepers do it too.">
                    <RefreshCw className="h-3.5 w-3.5" /> {lane === "down" ? "Update high" : "Update low"}
                  </button>
                )}
                {p.ready[lane] && (
                  <button className="btn btn-dark shrink-0" disabled={!owner || tx.state.busy} onClick={() => run(lane)} title="Keepers run it on their own; anyone can, once its condition is true">
                    <Play className="h-3.5 w-3.5" /> Run now
                  </button>
                )}
              </div>
            );
          })}
          {p.rules.plan && <PlanLines p={p} />}
        </div>
      </div>

      {owner ? (
        <div className="flex items-center gap-3">
          <button className="btn btn-danger" disabled={tx.state.busy} onClick={close}>
            Withdraw everything
          </button>
          <TxLine state={tx.state} />
        </div>
      ) : (
        <p className="text-[12px] text-[var(--muted)]">Read-only: only the owner can edit or withdraw. Anyone can run a step that is ready.</p>
      )}

      {editor && (
        <StrategyEditor
          pool={p.pool}
          price={price}
          rangeLabel={rangeLabel}
          amountsLabel={`${fmt(p.amount0)} ${p.livePool.token0.symbol} + ${fmt(p.amount1)} ${p.livePool.token1.symbol}`}
          initialRules={p.rules}
          initialAdvanced={p.advanced}
          ticks={[p.tickLower, p.tickUpper]}
          existing={{ liveIsHome: p.liveIsHome }}
          saveLabel={tx.state.busy ? "Saving…" : "Save strategy"}
          range={full ? { full: true } : { loPct: (lo / price - 1) * 100, hiPct: (hi / price - 1) * 100 }}
          busy={tx.state.busy}
          onClose={() => setEditor(false)}
          onSave={save}
        />
      )}
    </Wrap>
  );
}

function StatusBadge({ p, inRange }: { p: RulePosition; inRange: boolean }) {
  if (p.status === "waiting") return <span className="text-[12px] font-semibold text-[var(--blue)]">● Moved: holding tokens</span>;
  if (p.status === "parked") return <span className="text-[12px] font-semibold text-[var(--blue)]">● Moved to {p.livePool.label}</span>;
  return <span className={`text-[12px] font-semibold ${inRange ? "text-[var(--sage)]" : "text-[var(--amber)]"}`}>{inRange ? "● In range" : "● Out of range"}</span>;
}

function ParkedRange({ pool, range, tick }: { pool: Pool; range: [number, number]; tick: number }) {
  const [a, b] = priceRange(pool, range[0], range[1]);
  const inside = tick >= range[0] && tick < range[1];
  return (
    <div className="mt-1 text-[12px] text-[var(--muted)]">
      {fmt(a)} – {fmt(b)} {pool.quote.symbol} · {inside ? "earning fees" : "out of its range"}
    </div>
  );
}

/** The move in words, under the live sides. */
function PlanLines({ p }: { p: RulePosition }) {
  const plan = p.rules.plan!;
  const lines = p.liveIsHome
    ? [`${plan.where === "wait" ? "While moved, it holds" : "A move puts the money"} ${describePlan(p.pool, plan).replace(/^hold /, "")}.`, ...describeBack(p.pool, plan)]
    : (["down", "up"] as LaneId[]).filter((l) => p.rules[l].trigger).map((l) => `Back in the position: ${describeLane(p.pool, l, p.rules[l], plan)}`);
  return (
    <div className="flex gap-2 pt-2.5 text-[12px] text-[var(--muted)]">
      <Waypoints className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="flex flex-col gap-1">
        {lines.map((t) => (
          <div key={t}>{t}</div>
        ))}
      </div>
    </div>
  );
}

function MemoLine({ m, pool, lane }: { m: SideMemo; pool: Pool; lane: LaneId }) {
  if (!m.trails) return null;
  return (
    <div className="mt-1 text-[12px] text-[var(--muted)]">
      {lane === "down" ? "Highest" : "Lowest"} {pool.base.symbol} price remembered: {fmt(m.bestPrice)} {pool.quote.symbol}.
    </div>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-8">{children}</div>;
}

function ago(t: number) {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** One sentence: where the money is and what it is watching for. */
function statusLine(p: RulePosition, inRange: boolean, lanes: { down: Lane; up: Lane }): string {
  const watch = (["down", "up"] as LaneId[])
    .filter((l) => lanes[l].trigger)
    .map((l) => describeWhen(p.pool, l, lanes[l]).replace(/^When /, "").replace(/^Every /, "every "));
  const watching = watch.length ? ` Watching: ${watch.join(", or ")}.` : "";
  if (p.ready.down || p.ready.up) return "A step is ready: any keeper can run it now (it pays the keeper fee).";
  if (p.status === "waiting") return `Moved: holding tokens until it comes back.${watching}`;
  if (p.status === "parked") return `Moved to ${p.livePool.base.symbol}/${p.livePool.quote.symbol}, earning fees there.${watching}`;
  return `${inRange ? "In range, earning fees." : "Out of range: not earning fees."}${watching}`;
}
