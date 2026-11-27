"use client";

import { useQuery } from "@tanstack/react-query";
import { CHAIN_ID, CHAINS } from "@/lib/chain";
import { ArrowLeft, Info, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { rulesAbi } from "@/lib/generated/abis";
import { CORE, type Pool, fmt, maxUsable, minUsable, poolByIndex, tickAtPrice } from "@/lib/pools";
import { type Advanced, type LaneId, type Rules, describeBack, describeLane, encodeRules, laneTitle, sharedToken } from "@/lib/rules";

// Series colors: validated with the dataviz palette checker (contrast, chroma, color-blind separation).
const C_RULES = "#a78bfa"; // violet: the position with its rules
const C_PLAIN = "#625b8a"; // pencil: the same position without rules
const C_HOLD = "#ffb46b"; // ember: just holding the tokens

export type BacktestRange = { loPct: number; hiPct: number } | { full: true };

type Single = {
  poolLabel: string;
  base: string;
  quote: string;
  address: string | null;
  source: "recorded" | "chainlink";
  start: number;
  end: number;
  dataFrom: number;
  dataTo: number;
  swaps: number;
  entryPrice: number;
  endPrice: number;
  deposit: number;
  range: { lo: number; hi: number; full: boolean };
  rules: { final: number; fees: number; keeperPaid: number; runs: number; moves: number; timeInRange: number; closed: boolean; away: boolean };
  noRules: { final: number; fees: number; timeInRange: number };
  hold: { final: number };
  series: { t: number[]; price: number[]; rules: number[]; noRules: number[]; hold: number[]; lo: (number | null)[]; hi: (number | null)[] };
  events: { t: number; price: number; side: string; note: string[] }[];
  caveats: string[];
};
type Windows = {
  windows: { start: number; rules: number; noRules: number; hold: number; runs: number }[];
  count: number;
  beatNoRules: number;
  beatHold: number;
  medianVsNoRules: number;
  worstVsNoRules: number;
  bestVsNoRules: number;
  windowDays: number;
};

// "own": this pool, rebuilt from the chain (its tokens' Chainlink prices, arbitrage trades); the others are real mainnet
// swaps recorded by lp_study.
// Real swaps of Ethereum mainnet Uniswap v3 pools (api/_data), by pair. A testnet pool has no real traders, so the
// backtest replays the mainnet pool with the same two tokens.
const RECORDED: { key: string; pair: [string, string]; label: string; hint: string }[] = [
  { key: "eth_usdc_005", pair: ["WETH", "USDC"], label: "Mainnet 0.05%", hint: "Ethereum mainnet Uniswap v3 ETH/USDC 0.05%: every real swap" },
  { key: "eth_usdc_030", pair: ["WETH", "USDC"], label: "Mainnet 0.30%", hint: "Ethereum mainnet Uniswap v3 ETH/USDC 0.30%: every real swap" },
  { key: "wbtc_usdc_030", pair: ["WBTC", "USDC"], label: "Mainnet 0.30%", hint: "Ethereum mainnet Uniswap v3 WBTC/USDC 0.30%: every real swap" },
  { key: "wbtc_eth_005", pair: ["WBTC", "WETH"], label: "Mainnet 0.05%", hint: "Ethereum mainnet Uniswap v3 WBTC/WETH 0.05%: every real swap" },
  { key: "usdc_usdt_001", pair: ["USDC", "USDT"], label: "Mainnet 0.01%", hint: "Ethereum mainnet Uniswap v3 USDC/USDT 0.01%: every real swap" },
  { key: "dai_usdc_001", pair: ["DAI", "USDC"], label: "Mainnet 0.01%", hint: "Ethereum mainnet Uniswap v3 DAI/USDC 0.01%: every real swap" },
  { key: "link_eth_030", pair: ["LINK", "WETH"], label: "Mainnet 0.30%", hint: "Ethereum mainnet Uniswap v3 LINK/WETH 0.30%: every real swap" },
];
const sym = (s: string) => (s === "ETH" ? "WETH" : s);
const historiesFor = (p: Pool) => {
  const pair = [sym(p.base.symbol), sym(p.quote.symbol)];
  const same = RECORDED.filter((h) => h.pair.every((t) => pair.includes(t)));
  // the matching tier first
  return same.sort((a, b) => Math.abs(Number(a.label.match(/[\d.]+/)![0]) * 1e4 - p.key.fee) - Math.abs(Number(b.label.match(/[\d.]+/)![0]) * 1e4 - p.key.fee));
};
// recorded window: 2026-04-05 to 2026-10-03 (lp_study)
const DATA_START = 1775347200;
// our pools: the last 180 days, ending at the last full hour (so a repeated backtest within the hour is cached)
const ownStart = () => Math.floor(Date.now() / 3_600_000) * 3600 - 180 * 86400;

function encode(req: object) {
  const json = JSON.stringify(req);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export default function Backtest({
  pool,
  price,
  range,
  rules,
  advanced,
  onClose,
}: {
  pool: Pool;
  price: number;
  range: BacktestRange;
  rules: Rules;
  advanced: Advanced;
  onClose: () => void;
}) {
  const client = usePublicClient();
  const histories = historiesFor(pool);
  const HISTORY = [
    ...histories.map((h) => ({ key: h.key, label: h.label, hint: h.hint })),
    { key: "own", label: "Chainlink path", hint: "This pool's price from its tokens' Chainlink feeds; swaps are only the arbitrage that follows it (fees: a lower bound)" },
  ];
  const [history, setHistory] = useState(histories[0]?.key ?? "own");
  const own = history === "own";
  const dataStart = own ? ownStart() : DATA_START;
  const [days, setDays] = useState(90);
  const [startMonth, setStartMonth] = useState(0); // months after the data start
  // our pools: start on the most recent window (ending now); the recorded history: on its first one
  useEffect(() => {
    setStartMonth(own ? (days === 90 ? 3 : days === 30 ? 5 : 0) : 0);
  }, [own, days]);
  const [allWindows, setAllWindows] = useState(false);
  const [deposit, setDeposit] = useState(10_000);

  const q = useQuery({
    retry: 1,
    queryKey: ["backtest", history, pool.index, dataStart, days, startMonth, allWindows, deposit, JSON.stringify(rules), JSON.stringify(range), JSON.stringify(advanced)],
    staleTime: Infinity,
    queryFn: async () => {
      // The engine runs the exact order the contract would get (encodeRules), made at today's price. It moves the
      // order's price levels to the backtest window: a level x% from today's price stays x% from the window's start.
      const read = async (index: number) =>
        Number((await client!.readContract({ address: CORE.rules, abi: rulesAbi, functionName: "poolState", args: [index] }))[1]);
      const refTick = client ? await read(pool.index) : 0;
      const s = pool.key.tickSpacing;
      const at = (pct: number) => tickAtPrice(pool, price * (1 + pct / 100));
      const ticks: [number, number] =
        "full" in range
          ? [minUsable(s), maxUsable(s)]
          : [Math.floor(Math.min(at(range.loPct), at(range.hiPct)) / s) * s, Math.floor(Math.max(at(range.loPct), at(range.hiPct)) / s) * s + s];
      const enc = encodeRules(pool, rules, ticks);
      const lanes = [rules.down, rules.up, rules.plan?.back.down, rules.plan?.back.up];
      const otherIndex = lanes.flatMap((l) => [l?.trigger, l?.trigger2]).find((t) => (t?.kind === "otherPool" || t?.kind === "trail") && t.poolIndex && t.poolIndex !== pool.index)?.poolIndex;
      const otherRefTick = otherIndex && client ? await read(otherIndex) : undefined;
      const park = rules.plan?.where === "park" && rules.plan.parkPool ? poolByIndex(rules.plan.parkPool) : undefined;
      const order = {
        lower: enc.lower.toString(),
        upper: enc.upper.toString(),
        home: enc.home,
        away: { ...enc.away, shared: park ? sharedToken(pool, park) : null },
        awayLower: enc.awayLower.toString(),
        awayUpper: enc.awayUpper.toString(),
      };
      const req = {
        pool: own ? `sepolia:${pool.index}` : history,
        days,
        start: dataStart + startMonth * 30 * 86400,
        depositUsd: deposit,
        range,
        order,
        refTick,
        otherRefTick,
        homeIndex: pool.index,
        chainId: CHAIN_ID,
        spacing: pool.key.tickSpacing, // one-sided widths are in spacings: the replay keeps their width in price
        baseIs0: pool.baseIs0,
        keeperFeeBps: advanced.keeperFeeBps,
        slippagePct: advanced.slippagePct,
        delaySec: 12,
        ...(allWindows ? { mode: "windows", windowDays: 30, everyDays: 7 } : {}),
      };
      const res = await fetch(`/api/backtest?q=${encode(req)}`);
      const text = await res.text();
      let body: { error?: string } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON: the backtest service itself is down (locally: `npm run dev:api` is not running)
      }
      if (!res.ok || !body) throw new Error(body?.error ?? "The backtest service is not available right now. Try again in a moment.");
      return body as Single | Windows;
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--paper)]">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line)] bg-[var(--white)] px-4">
        <button className="btn btn-light !px-2.5" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" /> Back to strategy
        </button>
        <div className="truncate text-sm font-semibold">Backtest</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-4">
          {/* settings: one row */}
          <div className="card flex flex-wrap items-end gap-4 p-3">
            <Control label="History">
              <Seg value={history} onChange={setHistory} items={HISTORY.map((h) => ({ id: h.key, label: h.label, title: h.hint }))} />
            </Control>
            <Control label="Period">
              <Seg
                value={allWindows ? "all" : String(days)}
                onChange={(v) => {
                  if (v === "all") setAllWindows(true);
                  else {
                    setAllWindows(false);
                    setDays(Number(v));
                  }
                }}
                items={[
                  { id: "30", label: "30 days" },
                  { id: "90", label: "90 days" },
                  { id: "180", label: "180 days" },
                  { id: "all", label: "Every 30-day window" },
                ]}
              />
            </Control>
            {!allWindows && days < 180 && (
              <Control label="Starting">
                <select className="input !w-auto !py-1.5 text-[13px]" value={startMonth} onChange={(e) => setStartMonth(Number(e.target.value))}>
                  {Array.from({ length: days === 90 ? 4 : 6 }, (_, m) => (
                    <option key={m} value={m}>
                      {new Date((dataStart + m * 30 * 86400) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                    </option>
                  ))}
                </select>
              </Control>
            )}
            <Control label="Deposit">
              <div className="relative">
                <span className="absolute left-2.5 top-1.5 text-[13px] text-[var(--muted)]">$</span>
                <input
                  className="input !w-[110px] !py-1.5 !pl-5 text-[13px]"
                  inputMode="numeric"
                  value={deposit}
                  onChange={(e) => setDeposit(Math.max(100, Number(e.target.value.replace(/\D/g, "")) || 0))}
                />
              </div>
            </Control>
          </div>

          {own && (
            <div className="flex gap-2 rounded-[10px] bg-[var(--line2)] p-3 text-[12px] text-[var(--muted)]">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {pool.base.symbol}/{pool.quote.symbol}&apos;s price is taken from every round of its tokens&apos; Chainlink feeds on {CHAINS[CHAIN_ID].label}, read from the chain.
                A testnet pool has almost no traders, so the swaps are the arbitrage trades that keep it on that price, with this pool&apos;s fee tier: fees
                are a lower bound for a real pool.
              </span>
            </div>
          )}
          {!own && (
            <p
              className="flex items-center gap-2 text-[12px] text-[var(--muted)]"
              title="Your pool is on a testnet, where nobody trades, so the replay uses every real swap of the same pair on mainnet: real prices, volume and fees. Your range and price levels keep their distance from the price, and every swap runs your strategy the way the contract would."
            >
              <Info className="h-3.5 w-3.5 shrink-0" />
              Replayed on every real swap of mainnet {HISTORY.find((h) => h.key === history)?.hint.split(":")[0].replace("Ethereum mainnet Uniswap v3 ", "")}, 5 Apr – 3 Oct 2026
            </p>
          )}

          <RulesSummary pool={pool} rules={rules} />

          {q.isLoading && (
            <div className="card flex items-center justify-center gap-2 p-16 text-[13px] text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> {own ? "Reading Chainlink history and replaying…" : "Replaying swaps…"}
            </div>
          )}
          {q.error && <div className="card p-4 text-[13px] text-[var(--rose)]">{(q.error as Error).message}</div>}
          {q.data && "windows" in q.data && <WindowsResult r={q.data} />}
          {q.data && "series" in q.data && <SingleResult r={q.data} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      {children}
    </div>
  );
}

function Seg({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: { id: string; label: string; title?: string }[] }) {
  return (
    <div className="flex rounded-[10px] bg-[var(--line2)] p-0.5">
      {items.map((it) => (
        <button
          key={it.id}
          title={it.title}
          onClick={() => onChange(it.id)}
          className={`rounded-[8px] px-2.5 py-1 text-[12px] font-medium ${value === it.id ? "bg-[var(--white)] text-[var(--ink)] shadow-sm" : "text-[var(--muted)] hover:text-[var(--ink)]"}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function RulesSummary({ pool, rules }: { pool: Pool; rules: Rules }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-[12px] text-[var(--muted)]">
      {(["down", "up"] as LaneId[]).map((l) => {
        const t = describeLane(pool, l, rules[l], rules.plan);
        return t ? (
          <div key={l}>
            <span className="font-semibold text-[var(--ink)]">{laneTitle(pool, l, rules[l])}: </span>
            {t}
          </div>
        ) : null;
      })}
      {rules.plan &&
        describeBack(pool, rules.plan).map((t) => (
          <div key={t}>
            <span className="font-semibold text-[var(--ink)]">Coming back: </span>
            {t}
          </div>
        ))}
    </div>
  );
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="card p-3">
      <div className="text-[12px] text-[var(--muted)]">{label}</div>
      <div className="text-[22px] font-semibold tracking-tight">{value}</div>
      {sub && <div className={`text-[12px] ${tone === "good" ? "text-[var(--sage)]" : tone === "bad" ? "text-[var(--rose)]" : "text-[var(--muted)]"}`}>{sub}</div>}
    </div>
  );
}

function SingleResult({ r }: { r: Single }) {
  const diff = r.rules.final - r.noRules.final;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="With the strategy" value={usd(r.rules.final)} sub={`${signed(diff)} vs without`} tone={diff >= 0 ? "good" : "bad"} />
        <Tile label="Same position, no strategy" value={usd(r.noRules.final)} sub={`fees earned ${usd(r.noRules.fees)}`} />
        <Tile label="Just holding the tokens" value={usd(r.hold.final)} sub={`${signed(r.rules.final - r.hold.final)} for your rules`} tone={r.rules.final >= r.hold.final ? "good" : "bad"} />
        <Tile
          label="Steps run"
          value={`${r.rules.runs}×`}
          sub={`${r.rules.moves ? `${r.rules.moves} moves to another pool and back · ` : ""}fees ${usd(r.rules.fees)} · keepers ${usd(r.rules.keeperPaid)}${r.rules.closed ? " · closed" : r.rules.away ? " · ends moved" : ""}`}
        />
      </div>

      <div className="card p-4">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-[14px] font-semibold">Position value</div>
          <div className="text-[12px] text-[var(--muted)]">
            {day(r.start)} – {day(r.end)} · {r.swaps.toLocaleString()} {r.source === "recorded" ? "real swaps" : "arbitrage swaps"} ·{" "}
            {r.address ? (
              <a className="underline decoration-[var(--line)] underline-offset-4 hover:decoration-[var(--glow)]" href={`https://etherscan.io/address/${r.address}`} target="_blank" rel="noreferrer">
                {r.poolLabel}
              </a>
            ) : (
              r.poolLabel
            )}
          </div>
        </div>
        <Legend />
        <LineChart
          t={r.series.t}
          series={[
            { name: "With rules", color: C_RULES, values: r.series.rules },
            { name: "No strategy", color: C_PLAIN, values: r.series.noRules },
            { name: "Hold", color: C_HOLD, values: r.series.hold, dashed: true },
          ]}
          markers={r.events.map((e) => e.t)}
          format={usd}
          height={260}
        />
      </div>

      <div className="card p-4">
        <div className="mb-1 flex items-baseline justify-between">
          <div className="text-[14px] font-semibold">
            {r.base} price ({r.quote}) and your range
          </div>
          <div className="text-[12px] text-[var(--muted)]">
            {fmt(r.entryPrice)} → {fmt(r.endPrice)} {r.quote} · in range {Math.round(r.rules.timeInRange * 100)}% of the time with the strategy, {Math.round(r.noRules.timeInRange * 100)}% without
          </div>
        </div>
        <LineChart
          t={r.series.t}
          series={[{ name: `${r.base} price`, color: "#c3bce6", values: r.series.price }]}
          band={{ lo: r.series.lo, hi: r.series.hi }}
          markers={r.events.map((e) => e.t)}
          format={(n) => fmt(n)}
          height={170}
        />
      </div>

      {r.events.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 text-[14px] font-semibold">When it acted</div>
          <div className="max-h-[260px] overflow-y-auto text-[12px]">
            <table className="w-full">
              <thead className="text-left text-[var(--muted)]">
                <tr>
                  <th className="py-1 font-medium">Time</th>
                  <th className="py-1 font-medium">{r.base} price</th>
                  <th className="py-1 font-medium">What happened</th>
                </tr>
              </thead>
              <tbody>
                {r.events.map((e, i) => (
                  <tr key={i} className="border-t border-[var(--line2)]">
                    <td className="py-1.5">{new Date(e.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="py-1.5">{fmt(e.price)}</td>
                    <td className="py-1.5 text-[var(--muted)]">{e.note.length ? e.note.join(", ") : "ran"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Caveats items={r.caveats} />
    </>
  );
}

function WindowsResult({ r }: { r: Windows }) {
  const rows = r.windows;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={`Windows of ${r.windowDays} days`} value={String(r.count)} sub="one starting every week" />
        <Tile label="Strategy beat no strategy" value={`${r.beatNoRules} of ${r.count}`} />
        <Tile label="Strategy beat holding" value={`${r.beatHold} of ${r.count}`} />
        <Tile
          label="Median vs no strategy"
          value={signed(r.medianVsNoRules)}
          sub={`worst ${signed(r.worstVsNoRules)} · best ${signed(r.bestVsNoRules)}`}
          tone={r.medianVsNoRules >= 0 ? "good" : "bad"}
        />
      </div>
      <div className="card p-4">
        <div className="mb-1 text-[14px] font-semibold">Final value by start date</div>
        <Legend />
        <LineChart
          t={rows.map((w) => w.start)}
          series={[
            { name: "With rules", color: C_RULES, values: rows.map((w) => w.rules) },
            { name: "No strategy", color: C_PLAIN, values: rows.map((w) => w.noRules) },
            { name: "Hold", color: C_HOLD, values: rows.map((w) => w.hold), dashed: true },
          ]}
          format={usd}
          height={240}
          dots
        />
      </div>
      <Caveats items={["Each point is a separate backtest that starts on that date and runs for 30 days.", "Past results do not predict future ones."]} />
    </>
  );
}

function Legend() {
  return (
    <div className="mb-2 flex gap-4 text-[12px] text-[var(--muted)]">
      {[
        ["With strategy", C_RULES, false],
        ["No strategy", C_PLAIN, false],
        ["Just holding", C_HOLD, true],
      ].map(([n, c, d]) => (
        <span key={n as string} className="flex items-center gap-1.5">
          <svg width="18" height="6">
            <line x1="0" y1="3" x2="18" y2="3" stroke={c as string} strokeWidth="2" strokeDasharray={d ? "4 3" : undefined} />
          </svg>
          {n}
        </span>
      ))}
    </div>
  );
}

function Caveats({ items }: { items: string[] }) {
  return (
    <div className="flex flex-col gap-1 px-1 pb-6 text-[11px] text-[var(--muted)]">
      {items.map((c) => (
        <div key={c} className="flex gap-1.5">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          {c}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- chart (plain SVG, crosshair tooltip)

type S = { name: string; color: string; values: number[]; dashed?: boolean };

function LineChart({
  t,
  series,
  band,
  markers = [],
  format,
  height,
  dots,
}: {
  t: number[];
  series: S[];
  band?: { lo: (number | null)[]; hi: (number | null)[] };
  markers?: number[];
  format: (n: number) => string;
  height: number;
  dots?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 64, r: 12, t: 8, b: 22 };
  const { x, y, yTicks, xTicks } = useMemo(() => {
    const all = series.flatMap((s) => s.values).concat(band ? (band.lo.concat(band.hi).filter((v) => v !== null) as number[]) : []);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (band) {
      // keep the price readable when the range is far wider than the price move (full range)
      const p = series[0].values;
      const pl = Math.min(...p);
      const ph = Math.max(...p);
      lo = Math.max(lo, pl - (ph - pl) * 0.6);
      hi = Math.min(hi, ph + (ph - pl) * 0.6);
    }
    const span = hi - lo || Math.abs(hi) * 0.01 || 1;
    lo -= span * 0.06;
    hi += span * 0.06;
    const t0 = t[0];
    const t1 = t[t.length - 1];
    const x = (v: number) => pad.l + ((v - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
    const yTicks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 4);
    const xTicks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
    return { x, y, yTicks, xTicks };
  }, [series, band, t, w, height, pad.l, pad.r, pad.t, pad.b]);

  const path = (vals: (number | null)[]) =>
    vals.reduce((d, v, i) => (v === null ? d : d + `${d === "" || vals[i - 1] === null ? "M" : "L"}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`), "");

  const bandPath = band
    ? (() => {
        const segs: string[] = [];
        let top: string[] = [];
        let bot: string[] = [];
        const flush = () => {
          if (top.length) segs.push(`M${top.join("L")}L${bot.reverse().join("L")}Z`);
          top = [];
          bot = [];
        };
        band.lo.forEach((lo, i) => {
          const hi = band.hi[i];
          if (lo === null || hi === null) return flush();
          top.push(`${x(t[i]).toFixed(1)},${y(hi).toFixed(1)}`);
          bot.push(`${x(t[i]).toFixed(1)},${y(lo).toFixed(1)}`);
        });
        flush();
        return segs.join("");
      })()
    : "";

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    let bd = Infinity;
    t.forEach((v, i) => {
      const d = Math.abs(x(v) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <div ref={ref} className="relative w-full">
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block">
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--line2)" />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
              {format(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v, i) => (
          <text key={v} x={x(v)} y={height - 6} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} fontSize="11" fill="var(--muted)">
            {day(v)}
          </text>
        ))}
        {bandPath && <path d={bandPath} fill={C_RULES} opacity={0.12} />}
        {markers.map((m, i) => (
          <line key={i} x1={x(m)} x2={x(m)} y1={pad.t} y2={height - pad.b} stroke={C_RULES} strokeOpacity={0.25} strokeDasharray="2 3" />
        ))}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" />
        ))}
        {dots &&
          series.map((s) => s.values.map((v, i) => <circle key={`${s.name}${i}`} cx={x(t[i])} cy={y(v)} r={4} fill={s.color} stroke="white" strokeWidth={2} />))}
        {hover !== null && (
          <g>
            <line x1={x(t[hover])} x2={x(t[hover])} y1={pad.t} y2={height - pad.b} stroke="var(--muted2)" />
            {series.map((s) => (
              <circle key={s.name} cx={x(t[hover])} cy={y(s.values[hover])} r={4} fill={s.color} stroke="white" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-1 rounded-[8px] border border-[var(--line)] bg-[var(--white)] px-2.5 py-1.5 text-[12px] shadow-sm"
          style={{ left: Math.min(Math.max(x(t[hover]) + 10, 0), w - 190) }}
        >
          <div className="mb-0.5 text-[var(--muted)]">{new Date(t[hover] * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
          {series.map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              <span className="text-[var(--muted)]">{s.name}</span>
              <span className="ml-auto font-semibold">{format(s.values[hover])}</span>
            </div>
          ))}
          {band && band.lo[hover] !== null && (
            <div className="text-[var(--muted)]">
              range {fmt(band.lo[hover]!)}–{fmt(band.hi[hover]!)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
