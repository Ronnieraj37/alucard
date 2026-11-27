"use client";

import { useEffect, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Movement from "@/components/watch/Movement";
import { DEPLOYMENT as deployment, explorerAddress } from "@/lib/chain";
import { SIM, tokensAt } from "./sim";
import { useCount, useTimeline } from "./useTimeline";

/* ------------------------------------------------------------------ helpers */

const d = (ms: number): CSSProperties => ({ ["--d" as string]: `${ms}ms` });
const usd = (v: number, dp = 0) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
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

function Run({
  p,
  playing,
  play,
  stop,
  seek,
}: {
  p: number;
  playing: boolean;
  play: (from?: number) => void;
  stop: () => void;
  seek: (v: number) => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key !== "p" && e.key !== "P") return;
      e.preventDefault();
      if (playing) stop();
      else play();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [playing, play, stop]);

  const ended = !playing && p >= 0.999;
  const label = playing ? "Pause" : ended ? "Replay" : "Play";
  const onScrub = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(clamp((e.clientX - r.left) / r.width));
  };

  return (
    <div className="run">
      <button type="button" className="run-btn" onClick={() => (playing ? stop() : play())} aria-pressed={playing}>
        {label}
        <span>P</span>
      </button>
      <button type="button" className="run-track" onClick={onScrub} aria-label="Move through this slide">
        <i style={{ width: `${p * 100}%` }} />
      </button>
    </div>
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
          Your own strategy, running on your Uniswap v4 position: exit, move to another pool and back, re-range, compound. Set it once; it runs on-chain while you’re away.
        </p>
        <div className="cv-tags in" style={d(420)}>
          {["Uniswap v4", "Any pool, Chainlink-checked", "Live on Sepolia and Unichain"].map((t) => (
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

/* ------------------------------------------------------------------ 4 · build a strategy */

type StLine = { side: "down" | "up"; k: string; title: string; sub: string; at: number };
type StChoice = { label: string; hint: string; off?: boolean };
type StOffer = { at: number; until: number; title: string; pick: number; options: StChoice[] };

const ST_LINES: StLine[] = [
  { side: "down", k: "When", title: "Leaves my range", sub: "WETH leaves the range below", at: 0.18 },
  { side: "down", k: "Then", title: "Into USDT / USDC", sub: "Swap to USDC, then a ±0.2% range", at: 0.4 },
  { side: "down", k: "Return", title: "When WETH is back", sub: "Into the same range, 1,686 – 1,727", at: 0.5 },
  { side: "up", k: "When", title: "Reaches a price", sub: "WETH rises above 1,790 USDC", at: 0.68 },
  { side: "up", k: "Then", title: "Withdraw 25%", sub: "To your wallet", at: 0.78 },
  { side: "up", k: "Again", title: "At most four times", sub: "The price steps 5% further each time", at: 0.86 },
];

const ST_OFFERS: StOffer[] = [
  {
    at: 0.04,
    until: 0.18,
    title: "If it falls — when",
    pick: 0,
    options: [
      { label: "Leaves the range below", hint: "As soon as the price is out" },
      { label: "Drops below a price", hint: "A USDC price you choose" },
      { label: "Falls from its high", hint: "A trailing stop" },
    ],
  },
  {
    at: 0.24,
    until: 0.4,
    title: "Then",
    pick: 0,
    options: [
      { label: "Move to another pool", hint: "Any pool sharing a token, and it comes back" },
      { label: "Withdraw everything", hint: "To your wallet" },
      { label: "Swap to USDC", hint: "Never worse than the slippage limit" },
    ],
  },
  {
    at: 0.56,
    until: 0.68,
    title: "If it rises — when",
    pick: 0,
    options: [
      { label: "Rises above a price", hint: "A USDC price you choose" },
      { label: "Leaves the range above", hint: "As soon as the price is out" },
      { label: "Rises from its low", hint: "Waits for the turn" },
    ],
  },
  {
    at: 0.9,
    until: 1.01,
    title: "Then also — one does not fit",
    pick: -1,
    options: [
      { label: "Swap it to USDC", hint: "Never worse than the slippage limit" },
      { label: "Send the fees out", hint: "To your wallet, instead of keeping them in" },
      { label: "Follow the price", hint: "Not here. A repeating price cannot step if the range follows it.", off: true },
    ],
  },
];

function Side({ name, lines }: { name: string; lines: StLine[] }) {
  return (
    <div className="st-col">
      <p className="st-side">{name}</p>
      {lines.map((l) => (
        <div key={l.title} className="st-line">
          <span className="st-mark on" />
          <span className="st-k">{l.k}</span>
          <span>
            <h3>{l.title}</h3>
            <p>{l.sub}</p>
          </span>
        </div>
      ))}
    </div>
  );
}

function Build() {
  const clock = useTimeline(32000, { loop: false, delay: 400, rest: 1 });
  const { p } = clock;
  const down = ST_LINES.filter((l) => l.side === "down" && p >= l.at);
  const up = ST_LINES.filter((l) => l.side === "up" && p >= l.at);
  const offer = ST_OFFERS.find((o) => p >= o.at && p < o.until);
  const picked = offer && offer.pick >= 0 && p >= offer.until - 0.03 ? offer.pick : -1;
  const falls = p >= 0.5;
  const rises = p >= 0.86;
  return (
    <>
      <Head eyebrow="Build a strategy" title="Two sides. Only what fits." />
      <div className="st">
        <Side name="If WETH falls" lines={down} />
        <Side name="If WETH rises" lines={up} />
        <div className="st-offer" key={offer ? offer.title : "words"}>
          {offer ? (
            <>
              <p className="st-offer-h">{offer.title}</p>
              <div className="st-opts">
                {offer.options.map((o, k) => (
                  <div key={o.label} className={`st-opt ${o.off ? "off" : ""} ${picked === k ? "pick" : ""}`}>
                    <span className={`st-mark ${picked === k ? "on" : ""}`} />
                    <span>
                      <h3>{o.label}</h3>
                      <p>{o.hint}</p>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="st-words">
              <b>If it falls. </b>
              {falls ? "When WETH leaves the range, the money moves into USDT / USDC and comes back into the same range." : "Nothing yet."}
              <b> If it rises. </b>
              {rises ? "Above 1,790 USDC, withdraw 25%, up to four times." : "Nothing yet."}
            </p>
          )}
        </div>
      </div>
      <Run {...clock} />
    </>
  );
}

/* ------------------------------------------------------------------ 5 · the price guard */

const GD_W = 1080;
const GD_H = 460;
const gdC = (t: number) => (t < 0.62 ? 1700 : t < 0.8 ? 1700 - 110 * ease((t - 0.62) / 0.18) : 1590);
const gdQ = (t: number) => {
  const c = gdC(t);
  if (t >= 0.25 && t < 0.3) return c - 115 * ease((t - 0.25) / 0.05);
  if (t >= 0.3 && t < 0.5) return c - 115 + 4 * Math.sin(t * 90);
  if (t >= 0.5 && t < 0.58) return c - 115 * (1 - ease((t - 0.5) / 0.08));
  return c + 6 * Math.sin(t * 70);
};
const GD_STOP = 1650;
const gdY = (v: number) => GD_H - 40 - ((v - 1540) / (1760 - 1540)) * (GD_H - 80);
const gdPath = (f: (t: number) => number, upTo: number) => {
  const pts: string[] = [];
  for (let k = 0; k <= 200; k++) {
    const t = k / 200;
    if (t > upTo) break;
    pts.push(`${k ? "L" : "M"}${(t * GD_W).toFixed(1)},${gdY(f(t)).toFixed(1)}`);
  }
  return pts.join(" ");
};

function Guard() {
  const clock = useTimeline(20600, { loop: false, delay: 400, rest: 1 });
  const { p } = clock;
  const q = gdQ(p);
  const c = gdC(p);
  const out = Math.abs(q - c) > c * 0.02;
  const below = q < GD_STOP;
  const ran = p >= 0.82;
  const status = ran
    ? { t: "The market really fell: Chainlink agrees, the keeper runs the step", cls: "go" }
    : below && out
      ? { t: "Pushed below the stop, far from Chainlink: it does not count", cls: "no" }
      : p >= 0.5 && p < 0.62
        ? { t: "Arbitrage takes the push back", cls: "" }
        : { t: "Watching: the pool is on Chainlink", cls: "" };
  const band = (() => {
    const n = 40;
    const edge = (f: number) =>
      Array.from({ length: n + 1 }, (_, k) => {
        const t = (k / n) * p;
        return `${(t * GD_W).toFixed(1)},${gdY(gdC(t) * f).toFixed(1)}`;
      });
    const top = edge(1.02);
    const bot = edge(0.98);
    return `M${top.join(" L")} L${[...bot].reverse().join(" L")} Z`;
  })();
  return (
    <>
      <Head eyebrow="Why nobody can fire your strategy" title="A push does nothing. A real move runs at once." />
      <div className="gd">
        <div className="gd-chart in" style={d(250)}>
          <svg width={GD_W} height={GD_H} viewBox={`0 0 ${GD_W} ${GD_H}`} aria-label="A pool's price pushed below a stop does not fire it; when Chainlink moves, it runs">
            <path d={band} className="gd-band" />
            <line x1="0" x2={GD_W} y1={gdY(GD_STOP)} y2={gdY(GD_STOP)} className="gd-stop" />
            <text x={GD_W - 8} y={gdY(GD_STOP) - 10} textAnchor="end" className="gd-label">
              your stop · WETH leaves the range
            </text>
            <path d={gdPath(gdC, p)} className="gd-link" />
            <path d={gdPath(gdQ, p)} className="gd-pool" />
            <circle cx={p * GD_W} cy={gdY(q)} r="11" className={`gd-dot ${out ? "out" : ""}`} />
            {ran && <circle cx={0.82 * GD_W} cy={gdY(gdQ(0.82))} r="22" className="gd-ran" />}
          </svg>
          <div className="gd-legend">
            <span className="l-link">Chainlink</span>
            <span className="l-band">±2% band</span>
            <span className="l-pool">the pool’s price</span>
          </div>
          <p className={`gd-status ${status.cls}`}>{status.t}</p>
        </div>
        <div className="gd-facts">
          {[
            ["±2% of Chainlink", "A pool’s price counts only inside the band, for every condition and before every step."],
            ["Held for hours, still nothing", "A push stays a push until the market itself moves. No averaging lag in a real crash."],
            ["No price history", "Swaps pay nothing for strategies, and any v4 pool of listed tokens works, hookless too."],
          ].map(([h, t], k) => (
            <div key={h} className="gd-fact in" style={d(400 + k * 140)}>
              <h3>{h}</h3>
              <p>{t}</p>
            </div>
          ))}
        </div>
      </div>
      <Run {...clock} />
    </>
  );
}

/* ------------------------------------------------------------------ 6 · landscape */

function Landscape() {
  const rows = [
    ["What you can set", "A few presets: exit at a price, re-range, compound", "Your own strategy: conditions, steps, moves to another pool and back"],
    ["Where it runs", "The platform’s own vaults or pools", "Any Uniswap v4 pool of listed tokens, with or without our hook"],
    ["What it trusts", "The pool price, or the operator", "A pool’s price only while Chainlink agrees with it"],
    ["Who runs it", "The platform’s own bot", "Any keeper, paid the fee you set"],
    ["Before you commit", "No replay of your strategy", "Replay on real history, exactly as the contract runs"],
  ];
  return (
    <>
      <Head eyebrow="What exists today" title="A menu of automations. Alucard runs yours." />
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
  { k: "When", h: "Leaves the range, a price, a turn, time, fees", s: "Two conditions, and / or, true for N minutes" },
  { k: "Then", h: "Move to another pool, withdraw, swap, re-centre, compound", s: "Once or repeating, and back by your own rule" },
  { k: "Limits", h: "Slippage, keeper fee, run count, expiry", s: "Enforced by the contract on every run" },
  { k: "Keeper", h: "Anyone can run it; nobody can take it", s: "Money stays in Uniswap v4 until you withdraw" },
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
  const status = !met
    ? "Watching the price…"
    : hold < 1
      ? `True · ${Math.floor(hold * 10)}:${String(Math.floor((hold * 600) % 60)).padStart(2, "0")} of 10:00 in a row`
      : !then2
        ? "A keeper calls execute()"
        : !lim
          ? "Withdrawn and swapped"
          : "Done · position in USDC, inside your limits";

  return (
    <>
      <Head eyebrow="How it works" title="Wind it once. It keeps working." />
      <div className="hw-demo in" style={d(200)}>
        <p className="hw-ex">One side of a strategy, running</p>
        <div className="hw-sentence">
          <span className={`hw-k ${active === 0 ? "on" : ""}`}>When</span>
          <span className={`hw-chip ${met ? "lit" : ""}`}>ETH price &lt; $2,020</span>
          <span className="hw-and">and</span>
          <span className={`hw-chip hw-hold ${hold >= 1 ? "lit" : ""}`}>
            <i style={{ width: `${hold * 100}%` }} />
            <em>10 min in a row</em>
          </span>
          <span className={`hw-k ${active === 1 ? "on" : ""}`}>Then</span>
          <span className={`hw-chip ${then1 ? "lit" : ""}`}>Withdraw</span>
          <span className="hw-and">→</span>
          <span className={`hw-chip ${then2 ? "lit" : ""}`}>Swap to USDC</span>
        </div>
        <div className="hw-sentence">
          <span className={`hw-k ${active === 2 ? "on" : ""}`}>Limits</span>
          <span className={`hw-chip ${lim ? "lit" : ""}`}>slippage ≤ 0.5%</span>
          <span className={`hw-chip ${lim ? "lit" : ""}`}>keeper fee 0.1%</span>
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
    ["Your strategy, card by card", "Two conditions, and / or, holds, repeats, run limits"],
    ["Move to any pool and back", "Into any pool sharing a token, or hold one; back by your own rule"],
    ["Prices Chainlink agrees with", "A push does nothing; a real move runs at once. No price history"],
    ["Any v4 pool", "Hookless or ours, as long as both tokens have a Chainlink feed"],
    ["A fee you set", "Keepers are paid your fee per step, whatever the gas price"],
    ["Limit orders in the swap", "The hook fills them while trades happen, no bot needed"],
  ];
  const c = deployment.core as Record<string, string | number>;
  const addrs = [
    ["Strategies", String(c.conditionalOrders)],
    ["Rules", String(c.rules)],
    ["v4 hook", String(c.ruleHook)],
    ["Price feeds", String(c.priceFeeds)],
  ];
  return (
    <>
      <Head eyebrow="Built and live on Sepolia and Unichain" title="An editor, a contract and a backtest that agree." />
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
              <Count to={35126} delay={900} duration={1800} />
            </p>
            <p className="s-small">strategy shapes, editor = contract</p>
          </div>
          <div className="in" style={d(1000)}>
            <p className="num">
              <Count to={2000} delay={1000} duration={1800} />
            </p>
            <p className="s-small">orders, backtest = contract</p>
          </div>
          <div className="in" style={d(1100)}>
            <p className="num">
              <Count to={138} delay={1100} duration={1800} />
            </p>
            <p className="s-small">contract tests, 84% of branches</p>
          </div>
        </div>
        <div className="bt-addrs in" style={d(1200)}>
          {addrs.map(([k, a]) => (
            <a key={k} href={explorerAddress(a)} target="_blank" rel="noreferrer">
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
    ["Bring your positions", "Strategies on v3 and v4 positions people already hold"],
    ["Moves with two swaps", "Between pools with no token in common"],
    ["More places to wait", "Hold a moved token in a lending vault, not only in a pool"],
    ["More conditions", "Volatility, volume, another pool’s fee rate"],
  ];
  return (
    <>
      <Head eyebrow="What’s next" title="More options, for every LP’s own strategy." />
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
          Set your strategy. Then put it down.
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
    id: "trap",
    title: "Why out of range hurts",
    theme: "night",
    C: Trap,
    notes: "Concentrated liquidity has a trap. Once the price leaves your range you earn nothing, but the pool has already converted your whole position into the token that fell, so you keep taking the full drop. Nothing gets you out unless you watch the price and act yourself, day and night. That’s the job Alucard does. Alucard does not pick a strategy, and it does not claim one beats holding.",
  },
  {
    id: "build",
    title: "Build a strategy",
    theme: "enamel",
    C: Build,
    notes: "This plays once, slowly. Pause with P, or the button, and scrub the line if you want to hold a step. Two sides, if it falls and if it rises. Each step offers only what fits, and the one that does not fit stays on screen with the reason. The sentence underneath is the strategy in plain words, the same one the contract runs.",
  },
  {
    id: "guard",
    title: "The price guard",
    theme: "paper",
    C: Guard,
    notes: "Chainlink is not a condition you set. It is the check on every price. A pool’s price counts only while it is within about 2% of Chainlink. Push the pool below someone’s stop and the push does not count, however long you hold it. When the market itself moves, Chainlink moves too, and a keeper runs the step at once. No price history is stored, so swaps pay nothing for strategies, and any v4 pool of listed tokens works, with our hook or without one.",
  },
  {
    id: "landscape",
    title: "What exists today",
    theme: "paper",
    C: Landscape,
    notes: "Today’s tools give you a short menu: exit at a target price, move the range, compound fees. They watch the pool price, or an operator, and their own bot runs it. Alucard is the parts: conditions, steps, a move to another pool and back. Anyone can run a step and is paid the fee you set, a share of what the step moves, whatever the gas price. Before you commit, you replay that exact strategy on real history, with an engine we test against the contract run for run.",
  },
  {
    id: "how",
    title: "How it works",
    theme: "enamel",
    C: How,
    notes: "Every strategy has four parts. When: the conditions, two of them with and or or, and a hold so it has to stay true. Then: the steps, including a move to another pool that comes back by your own rule. Limits: slippage, the keeper fee, how many times it can run, when it expires, all checked by the contract. And the keeper: anyone can call execute once the condition holds, and is paid your fee, 0.1% by default and at most 1%. The money stays inside Uniswap v4 until you withdraw. The example on screen is one side, illustrative.",
  },
  {
    id: "built",
    title: "Built and live",
    theme: "paper",
    C: Built,
    notes: "What’s live on Sepolia and Unichain Sepolia. Two conditions, and or or, holds, repeats and run limits. Move into any pool that shares a token, or hold one token, and come back by your own rule. A price counts only while Chainlink agrees; a push does nothing and a real move runs at once. Keepers are paid the fee you set, whatever the gas. The hook fills limit orders inside swaps. The checks: 35,126 strategy shapes where the editor and the contract agree, 2,000 orders where the backtest and the contract run identically, 138 contract tests covering 84% of branches. You can also just say the strategy to the assistant: it asks back, then fills in the same steps.",
  },
  {
    id: "now",
    title: "What’s next",
    theme: "enamel",
    C: Now,
    notes: "What comes after what’s live. Strategies on v3 and v4 positions people already hold, because that’s where the idle money is. Moves between pools that share no token, which need two swaps. A place to hold a moved token in a lending vault, not only in a pool. And more conditions: volatility, volume, another pool’s fee rate. Each one is another option in the same editor.",
  },
  {
    id: "next",
    title: "Next: lending vault",
    theme: "night",
    C: Next,
    notes: "Where this goes, after the editor that’s live. A lending vault for liquidity providers. Lenders deposit and get a share token that grows with interest. The vault only lends into LP positions: borrowed money never reaches a wallet. Alucard LPs can take up to 2× leverage, but only with de-lever rules attached, and LPs in outside v3 and v4 pools can borrow against their positions under the same rules. Repayment can be in either token at the Chainlink price. After that: hidden rules, an AI strategy builder, and mainnet.",
  },
  {
    id: "close",
    title: "Thank you",
    theme: "enamel",
    C: Close,
    notes: "That’s Alucard: set your rules once, and put the position down. It’s live on Sepolia and Unichain Sepolia, the code is public, and I’m happy to show the app or the backtest live. Thank you.",
  },
];
