"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import Movement from "@/components/watch/Movement";
import deployment from "@/lib/generated/deployment.json";
import { CASE, DEPOSIT, SEGMENTS, STATES, caseAt } from "./rules";
import { SIM, tokensAt } from "./sim";
import { useCount, useTimeline } from "./useTimeline";

/* ------------------------------------------------------------------ helpers */

const d = (ms: number): CSSProperties => ({ ["--d" as string]: `${ms}ms` });
const usd = (v: number, dp = 0) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const DAY0 = Date.UTC(2026, 4, 21);
const dateAt = (t: number, year = false) =>
  new Date(DAY0 + t * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
const inRange = (px: number) => px >= SIM.range[0] && px <= SIM.range[1];

function Head({ eyebrow, title, width = 1600 }: { eyebrow: string; title: ReactNode; width?: number }) {
  return (
    <>
      <p className="s-eyebrow in">{eyebrow}</p>
      <h2 className="s-title in" style={{ ...d(90), maxWidth: width }}>
        {title}
      </h2>
    </>
  );
}

function Count({ to, dp = 0, prefix = "", suffix = "", delay = 0, duration = 1400 }: { to: number; dp?: number; prefix?: string; suffix?: string; delay?: number; duration?: number }) {
  const v = useCount(to, delay, duration);
  return (
    <>
      {prefix}
      {v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}
      {suffix}
    </>
  );
}

/* ------------------------------------------------------------------ 1 · cover */

function Cover() {
  return (
    <div className="cv">
      <div className="cv-text">
        <p className="s-eyebrow in">Uniswap Hook Incubator · Active management</p>
        <h1 className="cv-title in" style={d(120)}>
          Alucard
        </h1>
        <p className="s-lead in" style={{ ...d(260), maxWidth: 820 }}>
          Rules for your Uniswap v4 position. Set them once; they run on-chain while you’re away.
        </p>
        <div className="cv-tags in" style={d(420)}>
          {["Uniswap v4 hook", "Chainlink prices", "Live on Sepolia"].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      <div className="cv-watch in-scale" style={d(150)}>
        <Movement />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 2 · idle liquidity */

function Idle() {
  const parts = [
    { v: 13.7, label: "used by trades", cls: "used", color: "var(--ruby)" },
    { v: 56.9, label: "in range, never touched", cls: "unused", color: "#6b6f78" },
    { v: 29.4, label: "out of range, earning nothing", cls: "out", color: "#8e929b" },
  ];
  return (
    <>
      <Head eyebrow="The problem" title="Most concentrated liquidity isn’t working." />
      <div style={{ flex: 1 }} />
      <div className="idle-bar">
        {parts.map((p) => (
          <div key={p.cls} className={`idle-seg ${p.cls}`} style={{ width: `${p.v}%` }} />
        ))}
      </div>
      <div className="idle-legend">
        {parts.map((p, k) => (
          <div key={p.cls} className="in" style={d(900 + k * 160)}>
            <p className="num idle-num" style={{ color: p.color }}>
              <Count to={p.v} dp={1} suffix="%" delay={900 + k * 160} />
            </p>
            <p className="s-lead">{p.label}</p>
          </div>
        ))}
      </div>
      <div className="idle-more in" style={d(1500)}>
        <div>
          <p className="num">
            <Count to={44.5} dp={1} suffix="%" delay={1500} />
          </p>
          <p>of out-of-range capital sat untouched for 90 days</p>
        </div>
        <div>
          <p className="num">82–94%</p>
          <p>of idle liquidity belongs to individual wallets, not managers</p>
        </div>
      </div>
      <p className="s-small in" style={{ ...d(1700), marginTop: 36 }}>
        Uniswap v3-style pools, weekly snapshots Jan–Jun 2026, 7 chains. Dune research, via The Block and CoinDesk.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ 3 · one position, replayed */

const X0 = 64;
const X1 = 1056;
const xs = (t: number) => X0 + (t / 60) * (X1 - X0);
const PY0 = 14;
const PY1 = 196;
const py = (v: number) => PY1 - ((v - 1500) / 800) * (PY1 - PY0);
const VY0 = 262;
const VY1 = 596;
const vy = (v: number) => VY1 - ((v - 440) / 200) * (VY1 - VY0);

// the first 20% of the replay covers the first four days, so the first exit can be seen
const tOf = (p: number) => (p < 0.2 ? (p / 0.2) * 4 : 4 + ((p - 0.2) / 0.8) * 56);
const pOf = (t: number) => (t < 4 ? (t / 4) * 0.2 : 0.2 + ((t - 4) / 56) * 0.8);

type Key = "plain" | "hold" | "rerange" | "alucard";
const LINES: { k: Key; label: string; cls: string; color: string }[] = [
  { k: "alucard", label: "With Alucard rules", cls: "st-rule", color: "var(--ruby)" },
  { k: "hold", label: "Just holding", cls: "st-hold", color: "#9a9ea7" },
  { k: "plain", label: "The plain position", cls: "st-lp", color: "var(--ink)" },
  { k: "rerange", label: "Auto re-range", cls: "st-rr", color: "#7d8fb0" },
];

function pathTo(t: number, key: Key | "px", y: (v: number) => number) {
  const pts: string[] = [];
  for (const r of CASE.path) {
    if (r.t >= t) break;
    pts.push(`${xs(r.t).toFixed(1)},${y(r[key]).toFixed(1)}`);
  }
  const a = caseAt(t);
  pts.push(`${xs(t).toFixed(1)},${y(a[key]).toFixed(1)}`);
  return pts.join(" ");
}

const STATE_TEXT: Record<string, { text: string; cls: string }> = {
  lp: { text: "In a ±5% range · earning fees", cls: "ok" },
  cash: { text: "In USDC · waiting for +12% off the low", cls: "usd" },
  eth: { text: "Riding ETH · waiting for −12% off the high", cls: "eth" },
};

const EVENT_TEXT: Record<string, (px: number) => string> = {
  deposit: () => "Deposit $600, ±5% range",
  exit: (px) => `Falls out · rule 1 → USDC at ${usd(px)}`,
  reenter: (px) => `+12% off the low · rule 3 → range at ${usd(px)}`,
  ride: (px) => `Breaks out · rule 2 → ETH at ${usd(px)}`,
  reenter_high: (px) => `−12% off the high · rule 4 → range at ${usd(px)}`,
  end: () => `20 Jul: ${usd(CASE.finals.alucard.final, 2)}, against ${usd(CASE.finals.hold.final, 2)} holding`,
};

function Story() {
  const tl = useTimeline(18000, { delay: 700 });
  const t = tOf(tl.p);
  const a = caseAt(t);
  const done = tl.p >= 1;
  const st = STATE_TEXT[a.state] ?? STATE_TEXT.lp;
  const firstRange = CASE.path[1].range as number[];

  return (
    <>
      <Head eyebrow="One position, replayed on real swaps" title="$600 into ETH/USDC. Four ways to manage it." />
      <div className="st">
        <div className="st-panel in" style={d(200)}>
          <div>
            <p className="st-date num">{dateAt(t, true)}</p>
            <p className="s-small">Day {Math.floor(t)} of 60</p>
          </div>
          <div className="st-row">
            <p className="st-px num">ETH {usd(a.px)}</p>
          </div>
          <span className={`st-pill ${st.cls}`}>Alucard: {st.text}</span>
          <div className="st-vals">
            {LINES.map((l) => (
              <p key={l.k} className={l.k === "alucard" ? "ruby" : l.k === "hold" ? "muted" : ""}>
                <i style={{ background: l.color }} />
                {l.label}
                <b className="num">{usd(a[l.k], 2)}</b>
              </p>
            ))}
          </div>
          <ol className="st-log">
            {CASE.events.filter((e) => e.kind !== "end").map((e, n) => (
              <li key={n} className={`${t >= e.t ? "on" : ""} ${e.kind === "deposit" ? "" : "ruby"}`}>
                <span className="st-n">{n + 1}</span>
                <span className="st-when">{dateAt(e.t)}</span>
                {EVENT_TEXT[e.kind]?.(e.px)}
              </li>
            ))}
          </ol>
        </div>

        <div className="st-chart in" style={d(300)}>
          <svg width="1180" height="612" viewBox="0 0 1180 612" role="img" aria-label="ETH price with the ranges the rules held, and the value of $600 managed four ways over 60 days">
            {/* price panel: the plain position's fixed range, and the ranges the rules moved to */}
            <rect x={X0} y={py(firstRange[1])} width={X1 - X0} height={py(firstRange[0]) - py(firstRange[1])} className="st-band-plain" />
            <text x={X1 - 10} y={py(firstRange[1]) - 8} textAnchor="end" className="st-band-t">
              The plain position’s range
            </text>
            {SEGMENTS.filter((s) => s[0] < t).map((s) => (
              <rect key={s[0]} x={xs(s[0])} y={py(s[3])} width={Math.max(0, xs(Math.min(s[1], t)) - xs(s[0]))} height={py(s[2]) - py(s[3])} className="st-band" />
            ))}
            {STATES.filter((s) => s[0] < t && s[2] !== "lp").map((s) => (
              <rect key={s[0]} x={xs(s[0])} y={PY1 + 8} width={Math.max(0, xs(Math.min(s[1], t)) - xs(s[0]))} height="10" rx="2" className={`st-strip ${s[2]}`} />
            ))}
            {[1600, 1800, 2000, 2200].map((v) => (
              <g key={v}>
                <line x1={X0} x2={X1} y1={py(v)} y2={py(v)} className="st-grid" />
                <text x={X0 - 10} y={py(v) + 6} className="st-axis" textAnchor="end">
                  {v.toLocaleString("en-US")}
                </text>
              </g>
            ))}
            <text x={X0} y={PY0 - 2} className="st-axis-h">
              ETH price · ranges the rules held
            </text>
            <polyline points={pathTo(t, "px", py)} className="st-price" />
            <circle cx={xs(t)} cy={py(a.px)} r="7" className={a.state === "lp" ? "st-head-in" : "st-head-out"} />

            {/* value panel */}
            {[450, 500, 550, 600].map((v) => (
              <g key={v}>
                <line x1={X0} x2={X1} y1={vy(v)} y2={vy(v)} className="st-grid" />
                <text x={X0 - 10} y={vy(v) + 6} className="st-axis" textAnchor="end">
                  ${v}
                </text>
              </g>
            ))}
            <text x={X0} y={VY0 - 18} className="st-axis-h">
              Value of the $600
            </text>
            {[...LINES].reverse().map((l) => (
              <polyline key={l.k} points={pathTo(t, l.k, vy)} className={l.cls} />
            ))}
            {LINES.map((l) => (
              <circle key={l.k} cx={xs(t)} cy={vy(a[l.k])} r={l.k === "alucard" ? 7 : 5.5} fill={l.color} />
            ))}

            {CASE.events
              .filter((e) => t >= e.t && e.kind !== "deposit" && e.kind !== "end")
              .map((e, n) => (
                <g key={n} className="st-pin" transform={`translate(${xs(e.t)} ${vy(e.value)})`}>
                  <line y1={-10} y2={n % 2 ? -60 : -30} className="st-pin-l ruby" />
                  <circle cy={n % 2 ? -74 : -44} r="14" className="st-pin-c ruby" />
                  <text y={n % 2 ? -68 : -38} textAnchor="middle" className="st-pin-t">
                    {n + 2}
                  </text>
                </g>
              ))}

            {done && (
              <g className="st-end">
                <text x={X1 + 18} y={vy(CASE.finals.alucard.final) + 8} className="st-end-t ruby">
                  {usd(CASE.finals.alucard.final)}
                </text>
                <text x={X1 + 18} y={vy(CASE.finals.hold.final) + 2} className="st-end-t muted">
                  {usd(CASE.finals.hold.final)}
                </text>
                <text x={X1 + 18} y={vy(CASE.finals.plain.final) + 14} className="st-end-t">
                  {usd(CASE.finals.plain.final)}
                </text>
                <text x={X1 + 18} y={vy(CASE.finals.rerange.final) + 8} className="st-end-t rr">
                  {usd(CASE.finals.rerange.final)}
                </text>
              </g>
            )}
          </svg>
          <div className="st-ctl">
            <button onClick={() => (tl.playing ? tl.stop() : tl.play(done ? 0 : undefined))} aria-label={tl.playing ? "Pause" : done ? "Replay" : "Play"}>
              {tl.playing ? <Pause size={20} /> : done ? <RotateCcw size={20} /> : <Play size={20} />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={tl.p}
              onChange={(e) => tl.seek(pOf(tOf(parseFloat(e.target.value))))}
              onPointerUp={(e) => (e.target as HTMLInputElement).blur()}
              aria-label="Scrub through the 60 days"
            />
            <p className="s-small">Every real swap of Uniswap mainnet ETH/USDC 0.05%, 21 May – 20 Jul 2026. Fees per swap; $1.50 gas and keeper per action.</p>
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 4 · the trap */

const TRAP_LO = 1750;
const TRAP_HI = 2400;
function trapPrice(p: number) {
  const inside = (q: number) => 2128 + 72 * Math.sin((q / 0.42) * Math.PI * 3);
  if (p < 0.42) return inside(p);
  if (p < 0.6) {
    const f = ease((p - 0.42) / 0.18);
    return inside(0.42) + (1880 - inside(0.42)) * f;
  }
  return 1880 - 70 * ((p - 0.6) / 0.4) + 10 * Math.sin(p * 40);
}

function Trap() {
  const { p } = useTimeline(8000, { loop: true, delay: 500, rest: 0.8 });
  const px = trapPrice(p);
  const live = inRange(px);
  const tok = tokensAt(px);
  const share = (tok.eth * px) / (tok.eth * px + tok.usdc);
  const W = 1664;
  const x = (v: number) => ((v - TRAP_LO) / (TRAP_HI - TRAP_LO)) * W;
  const bars = 28;

  return (
    <>
      <Head eyebrow="Why out of range hurts" title="Out of range, you stop earning, but you keep losing." />
      <div className="tp-axis in" style={d(250)}>
        <svg width={W} height="150" viewBox={`0 0 ${W} 150`} aria-hidden="true">
          <rect x={x(SIM.range[0])} y="34" width={x(SIM.range[1]) - x(SIM.range[0])} height="76" className="tp-band" />
          <text x={x(SIM.range[0]) + 16} y="60" className="tp-band-t">
            Your range
          </text>
          <line x1="0" x2={W} y1="110" y2="110" className="tp-line" />
          {[1800, 2000, 2200, 2400].map((v) => (
            <text key={v} x={x(v)} y="142" textAnchor={v === 2400 ? "end" : "middle"} className="tp-tick">
              ${v.toLocaleString("en-US")}
            </text>
          ))}
          <g transform={`translate(${x(px)} 110)`}>
            <line y1="-90" y2="0" className={live ? "tp-needle" : "tp-needle out"} />
            <circle r="11" className={live ? "tp-dot" : "tp-dot out"} />
            <text y="-98" textAnchor="middle" className="tp-dot-t">
              ETH {usd(px)}
            </text>
          </g>
        </svg>
      </div>
      <div className="tp-cols">
        <div className="in" style={d(400)}>
          <div className="tp-viz">
            <div className="tp-fees">
              {Array.from({ length: bars }, (_, k) => {
                const q = (k + 0.5) / bars;
                const shown = p >= q;
                const h = inRange(trapPrice(q)) ? 34 + 40 * Math.abs(Math.sin(k * 1.7)) : 3;
                return <i key={k} style={{ height: shown ? h : 0 }} className={inRange(trapPrice(q)) ? "" : "dead"} />;
              })}
            </div>
            <p className="tp-cap">{live ? "fees per hour" : "fees per hour: none"}</p>
          </div>
          <p className="num tp-num">$0</p>
          <p className="s-lead">in fees while the price sits outside your range</p>
        </div>
        <div className="in" style={d(520)}>
          <div className="tp-viz">
            <div className="tp-mix">
              <div style={{ width: `${share * 100}%` }} />
            </div>
            <p className="tp-cap">
              {Math.round(share * 100)}% ETH · {Math.round((1 - share) * 100)}% USDC
            </p>
          </div>
          <p className="num tp-num" style={{ color: "#e05a6e" }}>
            100%
          </p>
          <p className="s-lead">of the position ends up in the token that fell</p>
        </div>
        <div className="in" style={d(640)}>
          <div className="tp-viz tp-clock-wrap">
            <svg width="108" height="108" viewBox="-54 -54 108 108" aria-hidden="true">
              <circle r="50" className="tp-clock" />
              {Array.from({ length: 12 }, (_, k) => (
                <line key={k} y1="-44" y2="-38" transform={`rotate(${k * 30})`} className="tp-clock-tk" />
              ))}
              <line y1="6" y2="-26" transform={`rotate(${p * 360 * 2})`} className="tp-clock-h" />
              <line y1="8" y2="-40" transform={`rotate(${p * 360 * 24})`} className="tp-clock-m" />
              <circle r="5" fill="var(--ruby)" />
            </svg>
            <p className="tp-cap">{live ? "you are watching" : "3 a.m. · nobody is"}</p>
          </div>
          <p className="num tp-num">24/7</p>
          <p className="s-lead">someone has to watch, or nothing happens</p>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 5 · the rule set */

const RULES = [
  { n: 1, when: "Price falls below my range", then: "Withdraw · swap all to USDC", path: "M300,176 Q150,250 146,372", label: [196, 262], today: true },
  { n: 2, when: "Price rises above my range", then: "Withdraw · swap all to ETH", path: "M420,176 Q570,250 574,372", label: [524, 262], today: true },
  { n: 3, when: "In USDC, and the price is 12% above its low since", then: "Add liquidity ±5% around the price", path: "M222,428 Q300,320 326,204", label: [284, 330], today: false },
  { n: 4, when: "In ETH, and the price is 12% below its high since", then: "Add liquidity ±5% around the price", path: "M498,428 Q420,320 394,204", label: [436, 330], today: false },
];
// what the rules did on 21 May – 20 Jul: 1, 3, 2, 4, 2
const SEQ = [1, 3, 2, 4, 2];
const NODE_AFTER: Record<number, string> = { 1: "usdc", 2: "eth", 3: "range", 4: "range" };

function Rules() {
  const { p } = useTimeline(13000, { loop: true, delay: 600, rest: 0.99 });
  const step = Math.min(SEQ.length, Math.floor(p * (SEQ.length + 1.5)));
  const active = step < SEQ.length ? SEQ[step] : 0;
  const node = step === 0 ? "range" : NODE_AFTER[SEQ[Math.min(step, SEQ.length) - 1]];
  const nodes = [
    { id: "range", x: 360, y: 112, t: "In a ±5% range", s: "earning fees" },
    { id: "usdc", x: 140, y: 470, t: "In USDC", s: "safe from the fall" },
    { id: "eth", x: 580, y: 470, t: "Riding ETH", s: "keeps the rally" },
  ];
  return (
    <>
      <Head eyebrow="The rules behind the red line" title="Earn while it ranges. Step aside when it runs." />
      <div className="ru">
        <div className="ru-map in" style={d(250)}>
          <svg width="720" height="600" viewBox="0 0 720 600" aria-label="Three states, In a range, In USDC and Riding ETH, joined by rules 1 to 4">
            <defs>
              <marker id="ru-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
              </marker>
            </defs>
            {RULES.map((r) => (
              <g key={r.n}>
                <path d={r.path} className={`ru-edge ${active === r.n ? "on" : ""}`} markerEnd="url(#ru-arrow)" />
                <circle cx={r.label[0]} cy={r.label[1]} r="19" className={`ru-tag ${active === r.n ? "on" : ""}`} />
                <text x={r.label[0]} y={r.label[1] + 7} textAnchor="middle" className="ru-tag-t">
                  {r.n}
                </text>
              </g>
            ))}
            {active > 0 && (
              <circle key={`${step}`} r="10" className="ru-token">
                <animateMotion dur="1.1s" fill="freeze" path={RULES[active - 1].path} />
              </circle>
            )}
            {nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x} ${n.y})`} className={`ru-node ${node === n.id ? "on" : ""}`}>
                <circle r="96" />
                <text y="-4" textAnchor="middle" className="ru-node-t">
                  {n.t}
                </text>
                <text y="28" textAnchor="middle" className="ru-node-s">
                  {n.s}
                </text>
              </g>
            ))}
          </svg>
        </div>
        <div className="ru-list">
          {RULES.map((r, k) => (
            <div key={r.n} className={`ru-card in ${active === r.n ? "on" : ""}`} style={d(350 + k * 120)}>
              <p className="ru-n num">{r.n}</p>
              <div>
                <p className="ru-line">
                  <span>When</span>
                  {r.when}
                </p>
                <p className="ru-line">
                  <span>Then</span>
                  {r.then}
                </p>
              </div>
              <em className={r.today ? "today" : "soon"}>{r.today ? "Runs today" : "3 Dec build"}</em>
            </div>
          ))}
          <p className="s-small in" style={{ ...d(900), marginTop: 8 }}>
            Triggers can read the Chainlink price, so one thin pool can’t be pushed to fire them. Every run is capped by slippage and keeper-pay limits.
          </p>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 6 · results for the case */

function Results() {
  const F = CASE.finals;
  const rows = [
    { label: "With Alucard rules", v: F.alucard.final, note: `${F.alucard.actions} actions · fees ${usd(F.alucard.fees ?? 0, 2)}`, c: "var(--ruby)", us: true },
    { label: "Stop-loss only", v: F.stop.final, note: "exits once, then sits in USDC", c: "#6b6f78" },
    { label: "Just holding", v: F.hold.final, note: "50 / 50, untouched", c: "#9a9ea7" },
    { label: "The plain position", v: F.plain.final, note: `no actions · fees ${usd(F.plain.fees ?? 0, 2)}`, c: "var(--ink)" },
    { label: "Auto re-range", v: F.rerange.final, note: `what today’s tools do · ${F.rerange.actions} re-ranges`, c: "#7d8fb0" },
  ];
  const max = 20;
  return (
    <>
      <Head eyebrow="Same $600, same 60 days, same swaps" title="Rules turned a loss into a gain." />
      <div className="rs">
        <div className="rs-axis in" style={d(200)}>
          <span />
          <div>
            <span>← lost</span>
            <span>$600</span>
            <span>gained →</span>
          </div>
        </div>
        {rows.map((r, k) => {
          const pct = (r.v / DEPOSIT - 1) * 100;
          const delay = r.us ? 1500 : 300 + k * 260;
          const w = (Math.abs(pct) / max) * 50;
          return (
            <div key={r.label} className={`rs-row in ${r.us ? "us" : ""}`} style={d(delay)}>
              <div className="rs-label">
                <p>{r.label}</p>
                <span>{r.note}</span>
              </div>
              <div className="rs-track2">
                <div className="rs-zero" />
                <div className={`rs-bar2 ${pct >= 0 ? "pos" : "neg"}`} style={{ width: `${w}%`, background: r.c, ...d(delay + 100) }} />
              </div>
              <p className="rs-pct num" style={{ color: r.us ? "var(--ruby)" : undefined }}>
                <Count to={pct} dp={1} prefix={pct >= 0 ? "+" : ""} suffix="%" delay={delay + 100} />
              </p>
              <p className="rs-val num" style={{ color: r.us ? "var(--ruby)" : undefined }}>
                <Count to={r.v} dp={2} prefix="$" delay={delay + 100} />
              </p>
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <p className="s-small in" style={d(2000)}>
        ETH fell 12% over the window (low −26%). Fees replayed per swap; $1.50 gas and keeper per action; the pool’s fee on every swap.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ 7 · every window */

function Evidence() {
  const W = CASE.windows;
  const rows: { k: string; label: string; us?: boolean }[] = [
    { k: "alucard", label: "Alucard rules", us: true },
    { k: "stop", label: "Stop-loss only" },
    { k: "rerange", label: "Auto re-range" },
    { k: "plain", label: "The plain position" },
  ];
  const G = W.grid;
  const col = (reg: "down" | "up", title: string, base: number) => (
    <div className="ev-col">
      <div className="ev-h in" style={d(base)}>
        <p className="s-eyebrow">{title}</p>
        <p className="ev-hold">
          Holding averaged <b className="num">{usd(W.hold[reg].mean)}</b>
        </p>
      </div>
      {rows.map((r, k) => {
        const x = W[r.k][reg];
        const n = x.n ?? 9;
        const beat = x.beat_hold ?? 0;
        return (
          <div key={r.k} className={`ev-row in ${r.us ? "us" : ""}`} style={d(base + 150 + k * 140)}>
            <p className="ev-label">{r.label}</p>
            <div className="ev-dots">
              {Array.from({ length: n }, (_, i) => (
                <i key={i} className={i < beat ? "won" : ""} style={d(base + 400 + k * 140 + i * 60)} />
              ))}
            </div>
            <p className="ev-n num">
              {beat}/{n}
            </p>
            <p className="ev-avg num">{usd(x.mean)}</p>
          </div>
        );
      })}
    </div>
  );
  return (
    <>
      <Head eyebrow="Not one lucky window" title="Every 60-day window in six months, $1,000 each." />
      <div className="ev">
        {col("down", "Falling markets · 9 windows", 200)}
        {col("up", "Rising markets · 9 windows", 500)}
      </div>
      <div className="ev-key in" style={d(1600)}>
        <span>
          <i className="won" /> beat holding
        </span>
        <span>
          <i /> did not
        </span>
        <span>right column: average value after 60 days</span>
      </div>
      <div style={{ flex: 1 }} />
      <p className="s-small in" style={d(1800)}>
        Uniswap mainnet ETH/USDC 0.05%, 5 Apr – 4 Oct 2026, a window every 7 days. These settings were one of {G.trend_configs} tested: {G.trend_configs_beating_hold_on_average} beat holding on
        average and {G.trend_configs_beating_plain_on_average} beat the plain position. A choppy market with no trend would be harder. That’s why you backtest a rule before you set it.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ 6 · landscape */

function Landscape() {
  const rows = [
    ["What you can set", "A few fixed presets: exit at a price, re-range, compound", "Any rule: conditions joined with and / or, actions, repeats, limits"],
    ["What it watches", "The pool price", "Pool price, Chainlink, time, fees, the trailing high"],
    ["Who runs it", "The platform’s own bot", "Any keeper, paid from the position, capped by you"],
    ["Before you commit", "No replay of your rule", "Backtest on your pool’s real history"],
    ["Proof it runs as shown", "Trust the operator", "79,682 rule shapes checked against the contract"],
  ];
  return (
    <>
      <Head eyebrow="What exists today" title="A menu of automations, run by someone else." />
      <div className="ls">
        <div className="ls-h in" style={d(200)}>
          <span />
          <span>Today’s LP automation tools</span>
          <span className="ruby">Alucard</span>
        </div>
        {rows.map((r, k) => (
          <div key={r[0]} className="ls-row in" style={d(320 + k * 140)}>
            <span className="ls-k">{r[0]}</span>
            <span className="ls-them">{r[1]}</span>
            <span className="ls-us" style={d(520 + k * 140)}>
              {r[2]}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 7 · how it works */

const PARTS = [
  { k: "When", h: "Price, Chainlink, time, fees, trailing high", s: "Two conditions, and / or, hold for N minutes" },
  { k: "Then", h: "Withdraw, convert, re-add, follow, compound", s: "In any order, once or repeating" },
  { k: "Limits", h: "Slippage, keeper fee cap, run count, expiry", s: "Enforced by the contract on every run" },
  { k: "Keeper", h: "Anyone can run it; nobody can take it", s: "Money never leaves Uniswap" },
];

function How() {
  const { p } = useTimeline(10000, { loop: true, delay: 600, rest: 0.9 });
  const price = p < 0.32 ? 2064 - (2064 - 2012) * ease(p / 0.32) : 2012 + 3 * Math.sin(p * 30);
  const met = price < 2020;
  const hold = clamp((p - 0.3) / 0.25);
  const keeper = p >= 0.56;
  const then1 = p >= 0.62;
  const then2 = p >= 0.68;
  const lim = p >= 0.76;
  const active = p < 0.56 ? 0 : p < 0.62 ? 3 : p < 0.76 ? 1 : 2;
  const status = !met ? "Watching the price…" : hold < 1 ? `Condition met · holding ${Math.floor(hold * 10)}:${String(Math.floor((hold * 600) % 60)).padStart(2, "0")} of 10:00` : !then2 ? "A keeper calls execute()" : !lim ? "Withdrawn and swapped" : "Done · position in USDC, inside the rules";

  return (
    <>
      <Head eyebrow="How it works" title="Wind it once. It keeps working." />
      <div className="hw-demo in" style={d(200)}>
        <p className="hw-ex">Example rule, running</p>
        <div className="hw-sentence">
          <span className={`hw-k ${active === 0 ? "on" : ""}`}>When</span>
          <span className={`hw-chip ${met ? "lit" : ""}`}>ETH price &lt; $2,020</span>
          <span className="hw-and">and</span>
          <span className={`hw-chip hw-hold ${hold >= 1 ? "lit" : ""}`}>
            <i style={{ width: `${hold * 100}%` }} />
            <em>held 10 min</em>
          </span>
          <span className={`hw-k ${active === 1 ? "on" : ""}`}>Then</span>
          <span className={`hw-chip ${then1 ? "lit" : ""}`}>Withdraw</span>
          <span className="hw-and">→</span>
          <span className={`hw-chip ${then2 ? "lit" : ""}`}>Swap to USDC</span>
        </div>
        <div className="hw-sentence">
          <span className={`hw-k ${active === 2 ? "on" : ""}`}>Limits</span>
          <span className={`hw-chip ${lim ? "lit" : ""}`}>slippage ≤ 0.5%</span>
          <span className={`hw-chip ${lim ? "lit" : ""}`}>keeper pay ≤ $2</span>
          <span className={`hw-chip ${lim ? "lit" : ""}`}>runs once</span>
          <span className={`hw-k ${active === 3 ? "on" : ""}`}>Keeper</span>
          <span className={`hw-chip ${keeper ? "lit" : ""}`}>anyone</span>
        </div>
        <div className="hw-status">
          <p className="num hw-price">ETH {usd(price, 2)}</p>
          <p className={`hw-state ${met ? "on" : ""}`}>{status}</p>
        </div>
      </div>
      <div className="parts">
        {PARTS.map((x, k) => (
          <div key={x.k} className={`part in ${active === k ? "on" : ""}`} style={d(400 + k * 120)}>
            <div className="jewel" />
            <p className="s-eyebrow part-k">{x.k}</p>
            <h3>{x.h}</h3>
            <p className="s-small">{x.s}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 8 · built */

function Built() {
  const facts = [
    ["Composable rules", "Two conditions, and / or, holds, repeats, run limits"],
    ["Chainlink inside", "Token list from Chainlink feeds; Chainlink price as a condition"],
    ["Fair keeper pay", "Measured gas per run, paid in the position’s own tokens, capped"],
    ["Limit orders in the swap", "The hook fills orders while trades happen, no bot needed"],
    ["Backtest your own pool", "Six months of Chainlink prices, read from the chain"],
    ["Batched runs", "About 440 orders fit in one 30M-gas block"],
  ];
  const c = deployment.core as Record<string, string | number>;
  const addrs = [
    ["Rule engine", String(c.conditionalOrders)],
    ["v4 hook", String(c.ruleHook)],
    ["Price feeds", String(c.priceFeeds)],
  ];
  return (
    <>
      <Head eyebrow="Built and live on Sepolia" title="A rule engine, a hook and a backtest that agree." />
      <div className="facts">
        {facts.map(([h, s], k) => (
          <div key={h} className="fact in" style={d(220 + k * 90)}>
            <span className="fact-n">{String(k + 1).padStart(2, "0")}</span>
            <h3>{h}</h3>
            <p>{s}</p>
          </div>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <div className="bt-foot">
        <div className="proof">
          <div className="in" style={d(900)}>
            <p className="num ruby">
              <Count to={79682} delay={900} duration={1800} />
            </p>
            <p className="s-small">rule shapes, editor = contract</p>
          </div>
          <div className="in" style={d(1000)}>
            <p className="num">
              <Count to={4000} delay={1000} duration={1800} />
            </p>
            <p className="s-small">orders, backtest = contract</p>
          </div>
          <div className="in" style={d(1100)}>
            <p className="num">
              <Count to={130} delay={1100} duration={1800} />
            </p>
            <p className="s-small">contract tests, stress and fuzz</p>
          </div>
        </div>
        <div className="bt-addrs in" style={d(1200)}>
          {addrs.map(([k, a]) => (
            <a key={k} href={`https://sepolia.etherscan.io/address/${a}`} target="_blank" rel="noreferrer">
              <span>{k}</span>
              <code>
                {a.slice(0, 8)}…{a.slice(-6)}
              </code>
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 9 · now */

function Now() {
  const steps = [
    ["Rules that repeat correctly", "“Price moves X% from where it last acted”, for any pair"],
    ["Pool APR condition", "Act when a pool’s fee APR, or my result vs holding, crosses a level"],
    ["Move to another pool", "Exit and re-add in one transaction, inside Alucard’s pools"],
    ["Bring your v3 and v4 positions", "Rules on positions people already hold, in any Uniswap pool"],
  ];
  return (
    <>
      <Head eyebrow="For the 3 December submission" title="Wake the idle liquidity, wherever it sits." />
      <div className="steps">
        <div className="steps-line" />
        {steps.map(([h, s], k) => (
          <div key={h} className="step in" style={d(300 + k * 200)}>
            <p className="step-n num">{k + 1}</p>
            <h3>{h}</h3>
            <p>{s}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 10 · next */

function Flow({ path, dur, n, back = false }: { path: string; dur: number; n: number; back?: boolean }) {
  return (
    <>
      {Array.from({ length: n }, (_, k) => (
        <circle key={k} r={back ? 4 : 6} className={back ? "nx-dot back" : "nx-dot"}>
          <animateMotion dur={`${dur}s`} begin={`${(k * dur) / n}s`} repeatCount="indefinite" path={path} {...(back ? { keyPoints: "1;0", keyTimes: "0;1", calcMode: "linear" } : {})} />
        </circle>
      ))}
    </>
  );
}

function Next() {
  const A = "M400,280 L632,280";
  const B = "M1032,262 C1150,262 1150,130 1264,130";
  const C = "M1032,298 C1150,298 1150,430 1264,430";
  return (
    <>
      <Head eyebrow="Next: liquidity that lends to liquidity" title="A lending vault for LPs, inside Alucard and out." />
      <div className="nx in" style={d(250)}>
        <svg width="1664" height="560" viewBox="0 0 1664 560" aria-hidden="true">
          {[A, B, C].map((p) => (
            <path key={p} d={p} className="nx-path" />
          ))}
          <Flow path={A} dur={2.4} n={4} />
          <Flow path={B} dur={2.6} n={4} />
          <Flow path={C} dur={2.6} n={4} />
          <Flow path={A} dur={3.2} n={3} back />
          <Flow path={B} dur={3.4} n={2} back />
          <Flow path={C} dur={3.4} n={2} back />
          <text x="516" y="262" textAnchor="middle" className="nx-t">
            capital
          </text>
          <text x="516" y="314" textAnchor="middle" className="nx-t back">
            interest
          </text>
        </svg>
        <div className="vbox" style={{ left: 0, top: 180 }}>
          <p className="s-eyebrow">Lenders</p>
          <h3>Deposit any token</h3>
          <p>Receive a share token that grows with interest</p>
        </div>
        <div className="vbox vault" style={{ left: 632, top: 170, height: 220 }}>
          <p className="s-eyebrow">Vault</p>
          <h3>Lends only into LP positions</h3>
          <p>Repaid in either token at the Chainlink price</p>
        </div>
        <div className="vbox" style={{ left: 1264, top: 30 }}>
          <p className="s-eyebrow">Alucard LPs</p>
          <h3>Up to 2× leverage</h3>
          <p>Only with de-lever rules attached</p>
        </div>
        <div className="vbox" style={{ left: 1264, top: 330 }}>
          <p className="s-eyebrow">Outside v3 / v4 LPs</p>
          <h3>Borrow against a position</h3>
          <p>Same rules, same limits</p>
        </div>
      </div>
      <div className="nx-more in" style={d(700)}>
        <span>Also next</span>
        {["Hidden rules (commit-reveal)", "An AI strategy builder", "Mainnet"].map((x) => (
          <b key={x}>{x}</b>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 11 · close */

function Close() {
  return (
    <div className="cv">
      <div className="cv-text">
        <p className="s-eyebrow in">Alucard</p>
        <h1 className="cl-title in" style={d(120)}>
          Set your rules. Then put it down.
        </h1>
        <div className="cl-links in" style={d(360)}>
          <p>Live on Ethereum Sepolia</p>
          <p>github.com/Ronnieraj37/alucard</p>
        </div>
        <p className="s-lead in" style={d(520)}>
          Thank you.
        </p>
      </div>
      <div className="cv-watch cl-watch in-scale" style={d(200)}>
        <Movement />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ the deck */

export type Slide = { id: string; title: string; theme: "paper" | "enamel" | "night"; C: () => ReactNode; notes: string };

export const SLIDES: Slide[] = [
  {
    id: "cover",
    title: "Alucard",
    theme: "enamel",
    C: Cover,
    notes: "Hi, I’m Roshan. Alucard lets a liquidity provider put their own rules on a Uniswap v4 position: when to exit, when to move the range, when to compound. Those rules run on-chain without anyone watching. It’s live on Sepolia today.",
  },
  {
    id: "idle",
    title: "The problem",
    theme: "paper",
    C: Idle,
    notes: "A 2026 Dune study looked at concentrated liquidity across seven chains. In a typical week only about 14% of it was used by trades. 57% sat in range but untouched, and close to a third was out of range, earning nothing. Almost half of the out-of-range money stayed untouched for 90 days, and most of it belongs to individual wallets, not managers. Those are the people Alucard is for.",
  },
  {
    id: "story",
    title: "One position, replayed",
    theme: "paper",
    C: Story,
    notes: "This is every real swap on mainnet ETH/USDC from 21 May to 20 July, replayed against $600 managed four ways. The plain position leaves its range two days in and the pool turns all the USDC into ETH: it ends at $541. Holding ends at $564. The auto re-range that today’s tools offer keeps chasing the price and paying for it: 15 re-ranges, $493. The red line is Alucard’s rule set: out to USDC when the price falls out of the range, back into a range after a 12% rebound, riding ETH when it breaks out above, and back into a range after a 12% pullback. It ends at $622, ahead of holding and of the plain position.",
  },
  {
    id: "trap",
    title: "Why out of range hurts",
    theme: "night",
    C: Trap,
    notes: "Concentrated liquidity has a trap. Once the price leaves your range you earn nothing, but the pool has already converted your whole position into the token that fell, so you keep taking the full drop. Nothing gets you out unless you watch the price and act yourself, day and night. That’s the job Alucard does.",
  },
  {
    id: "rules",
    title: "The rule set",
    theme: "enamel",
    C: Rules,
    notes: "Here is that rule set, written as Alucard rules. Rule 1: if the price falls below my range, withdraw and swap to USDC. Rule 2: if it rises above, withdraw and swap to ETH, so I keep the rally instead of selling into it. Rules 3 and 4 bring the money back into a ±5% range once the move has turned by 12%. While the price ranges, the money earns fees; when it trends, it steps aside. Rules 1 and 2 run on the contract today; the re-entry rules are part of the build for 3 December. Triggers can read the Chainlink price, so a thin pool can’t be pushed to fire them.",
  },
  {
    id: "results",
    title: "Results",
    theme: "paper",
    C: Results,
    notes: "The same $600, the same 60 days. With the rules: $621.59, a gain while ETH fell 12%. A stop-loss alone: $577. Holding: $564. The plain position: $541. And auto re-ranging, which is what most automation offers today: $493, because every re-range locks in the loss and pays the swap and gas.",
  },
  {
    id: "evidence",
    title: "Every window",
    theme: "enamel",
    C: Evidence,
    notes: "One window can be luck, so we ran every 60-day window in six months, a new one every week, $1,000 each. In the nine falling markets the rules beat holding nine times; in the nine rising markets eight times. The plain position and auto re-range never beat holding. To be straight about it: this was one of 80 settings we tested, 32 of them beat holding on average and 68 beat the plain position, and these six months trended. A flat, choppy market is harder. That is exactly why Alucard lets you backtest a rule on your own pool before you set it.",
  },
  {
    id: "landscape",
    title: "What exists today",
    theme: "paper",
    C: Landscape,
    notes: "Today’s tools give you a short menu: exit at a target price, move the range, compound fees. They watch the pool price, and their own bot runs it. Alucard turns that menu into a language: you combine conditions with and / or, choose actions, repeats and limits. Anyone can run your rule and is paid from the position, never above your cap. And you can backtest the exact rule first, using an engine we test against the contract case by case.",
  },
  {
    id: "how",
    title: "How it works",
    theme: "enamel",
    C: How,
    notes: "Every rule has four parts, like the parts of a watch movement. When: the conditions. Then: the actions. Limits: slippage, the most a keeper can be paid, how many times it can run, when it expires. And the keeper: anyone can execute it once the condition holds, and they are paid their measured gas plus a small premium, from the position, never above your cap. The money stays inside the Uniswap v4 pool the whole time. The example on screen is illustrative.",
  },
  {
    id: "built",
    title: "Built and live",
    theme: "paper",
    C: Built,
    notes: "What’s live on Sepolia today. Composable rules with two conditions, and / or, confirmation holds, repeats and run limits. Chainlink is built in twice: only tokens with a Chainlink feed can be used, and a Chainlink price can be a condition. Keepers are paid their measured gas per run, in the position’s own tokens, never above the cap. The hook also fills limit orders inside swaps. The backtest runs on your own pool’s Chainlink history. And it’s tested against itself: 79,682 rule shapes where the editor and contract agree, 4,000 orders where the backtest and contract run identically, 130 contract tests.",
  },
  {
    id: "now",
    title: "For 3 December",
    theme: "enamel",
    C: Now,
    notes: "Four things for the final submission. One: rules that repeat correctly, anchored to where the rule last acted rather than a fixed price, so they work for any pair. Two: a pool APR condition, and a condition on how my position is doing against simply holding. Three: Move, which exits and re-adds in one transaction, so liquidity can follow the fees. Four: bring existing Uniswap v3 and v4 positions, because that’s where the idle money already is.",
  },
  {
    id: "next",
    title: "Next: lending vault",
    theme: "night",
    C: Next,
    notes: "Where this goes. A lending vault for liquidity providers. Lenders deposit and get a share token that grows with interest. The vault only lends into LP positions: borrowed money never reaches a wallet. Alucard LPs can take up to 2x leverage, but only with de-lever rules attached, and LPs in outside v3 and v4 pools can borrow against their positions under the same rules. Repayment can be in either token at the Chainlink price, which in our backtests decided whether leverage paid. After that: hidden rules, an AI strategy builder, and mainnet.",
  },
  {
    id: "close",
    title: "Thank you",
    theme: "enamel",
    C: Close,
    notes: "That’s Alucard: set your rules once, and put the position down. It’s live on Sepolia, the code is public, and I’m happy to show the app or the backtest live. Thank you.",
  },
];
