"use client";

import { type CSSProperties, type ReactNode } from "react";
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
          Your Uniswap position, with your rules. It runs on-chain while you’re away.
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

/* ------------------------------------------------------------------ main deck: short slides */

function Problem() {
  const items = [
    ["$0", "in fees, out of range"],
    ["100%", "in the token that fell"],
    ["24/7", "someone has to watch"],
  ];
  return (
    <>
      <Head eyebrow="The problem" title="A Uniswap position has no settings." />
      <div className="pb">
        <p className="num pb-big in" style={d(250)}>
          <Count to={29.4} dp={1} suffix="%" delay={250} />
        </p>
        <p className="s-lead pb-cap in" style={d(400)}>
          of concentrated liquidity sits out of range, earning nothing
        </p>
      </div>
      <div className="tri">
        {items.map(([n, t], k) => (
          <div key={n} className="in" style={d(700 + k * 140)}>
            <p className="num tri-n">{n}</p>
            <p className="s-lead">{t}</p>
          </div>
        ))}
      </div>
      <p className="s-small in" style={{ ...d(1200), marginTop: "auto" }}>
        Dune, Jan–Jun 2026, via The Block
      </p>
    </>
  );
}

const IDEA = [
  { tag: "Move and return", when: "ETH falls out of my range", then: "Park it in USDT/USDC. Bring it back when ETH recovers." },
  { tag: "Leave when fees dry up", when: "fees earn less than 10% a year", then: "Take my liquidity out." },
  { tag: "Your own condition", when: "my contract says yes", then: "Anything you can write: a depeg, volatility." },
];

function Idea() {
  return (
    <>
      <Head eyebrow="Alucard" title="If this happens, do that." />
      <div className="us-grid three">
        {IDEA.map((u, k) => (
          <div key={u.tag} className="us-card in" style={d(260 + k * 140)}>
            <p className="us-tag">{u.tag}</p>
            <p className="us-when">
              <span>If</span> {u.when},
            </p>
            <p className="us-then">{u.then}</p>
          </div>
        ))}
      </div>
      <p className="s-lead in" style={{ ...d(900), marginTop: 56 }}>
        Re-range, take profit, trailing stops, compound: any mix, on both sides.
      </p>
    </>
  );
}

function Safe() {
  const rows = [
    ["A push past 2% does nothing.", "Prices count only near Chainlink."],
    ["No step sells into a push.", "Every swap fills within your slippage, or waits."],
    ["Nobody can act on the spot.", "Admin changes wait two days. Cancel always works."],
  ];
  return (
    <>
      <Head eyebrow="Safe by design" title="Attacked on paper. Every attack is a test it passes." />
      <div className="sf">
        {rows.map(([h, t], k) => (
          <div key={h} className="sf-row in" style={d(300 + k * 180)}>
            <h3>{h}</h3>
            <p>{t}</p>
          </div>
        ))}
      </div>
    </>
  );
}

function Proof() {
  const nums: [number, string, string][] = [
    [48181, "", "strategy shapes: the builder and the contract agree on every one"],
    [0.1, "%", "the replay on real swaps matches the contract’s money, within"],
    [161, "", "contract tests, attacks included"],
  ];
  return (
    <>
      <Head eyebrow="Built" title="Live on Sepolia and Unichain." />
      <div className="tri pr">
        {nums.map(([n, sfx, t], k) => (
          <div key={t} className="in" style={d(300 + k * 160)}>
            <p className={`num tri-n ${k === 0 ? "ruby" : ""}`}>
              <Count to={n} dp={n < 1 ? 1 : 0} suffix={sfx} delay={300 + k * 160} />
            </p>
            <p className="s-lead">{t}</p>
          </div>
        ))}
      </div>
    </>
  );
}

function Next() {
  const items = ["An audit, then mainnet", "Bring the positions you already hold", "A gallery of strategies, ranked by their replays"];
  return (
    <>
      <Head eyebrow="What’s next" title="From testnet to every LP." />
      <div className="nx2">
        {items.map((t, k) => (
          <p key={t} className="nx2-row in" style={d(300 + k * 160)}>
            <span className="num">{k + 1}</span>
            {t}
          </p>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ backup: the detail, for questions */

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

/* ------------------------------------------------------------------ 3b · what you can tell it */

const USES = [
  { tag: "Move and return", when: "ETH falls out of my range", then: "Park it in USDT/USDC. Bring it back once ETH is back in my range." },
  { tag: "Re-range", when: "it leaves my range", then: "Re-centre a new range around the price, either way." },
  { tag: "Leave when fees dry up", when: "the fee APR falls below 10%", then: "Take my liquidity out." },
  { tag: "Take profit in steps", when: "ETH rises 10%", then: "Withdraw 25%, again every 5% higher, four times." },
  { tag: "Trailing stop", when: "ETH falls 8% from its best", then: "Withdraw everything and swap to USDC." },
  { tag: "Your own condition", when: "my contract says yes", then: "Paste any contract that answers yes or no: a depeg, volatility, any logic." },
];

function Uses() {
  const { p } = useTimeline(12000, { loop: true, delay: 1400, rest: 0 });
  const on = Math.min(USES.length - 1, Math.floor(p * USES.length));
  return (
    <>
      <Head eyebrow="What would you tell your position?" title="If this happens, do that. In your words." />
      <div className="us-grid">
        {USES.map((u, k) => (
          <div key={u.tag} className={`us-card in ${k === on ? "on" : ""}`} style={d(260 + k * 120)}>
            <p className="us-tag">{u.tag}</p>
            <p className="us-when">
              <span>If</span> {u.when},
            </p>
            <p className="us-then">{u.then}</p>
          </div>
        ))}
      </div>
      <p className="s-lead in" style={{ ...d(1200), marginTop: 44 }}>
        Pick the cards, or type the sentence to the assistant. Mix them: a plan for each direction, two conditions with and / or, “only if it lasts”,
        repeats. Today’s tools offer a few of these as fixed buttons.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ 4 · build a strategy */

type StLine = { side: "down" | "up"; k: string; title: string; sub: string; at: number };

const ST_LINES: StLine[] = [
  { side: "down", k: "When", title: "Leaves my range", sub: "WETH leaves the range below", at: 0.18 },
  { side: "down", k: "Then", title: "Into USDT / USDC", sub: "Swap to USDC, then a ±0.2% range", at: 0.4 },
  { side: "down", k: "Return", title: "When WETH is back", sub: "Into the same range, 1,686 – 1,727", at: 0.5 },
  { side: "up", k: "When", title: "Reaches a price", sub: "WETH rises above 1,790 USDC", at: 0.68 },
  { side: "up", k: "Then", title: "Withdraw 25%", sub: "To your wallet", at: 0.78 },
  { side: "up", k: "Again", title: "At most four times", sub: "The price steps 5% further each time", at: 0.86 },
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

function Build({ step }: { step: number }) {
  const down = step >= 1 ? ST_LINES.filter((l) => l.side === "down") : [];
  const up = step >= 2 ? ST_LINES.filter((l) => l.side === "up") : [];
  return (
    <>
      <Head eyebrow="Build it" title="Two sides. Pick what should happen." />
      <div className="st">
        <Side name="If WETH falls" lines={down} />
        <Side name="If WETH rises" lines={up} />
        <p className="st-words in" key={step}>
          {step === 0 && "Cards, or one sentence to the assistant. The builder only offers what fits."}
          {step === 1 && "Falls out of range: move into USDT/USDC, come back when WETH is back."}
          {step >= 2 && "Rises: take 25% profit, up to four times. That is the whole strategy."}
        </p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 4b · every problem, and the fix */

const FIXES = [
  ["Out of range, it earns nothing", "It leaves, re-ranges, or parks in another pool and comes back: by your rules"],
  ["It ends up 100% in the token that fell", "Swap to a stablecoin, or move into a stable pool, the moment it leaves"],
  ["Someone has to watch, day and night", "Any keeper runs it on-chain, paid only the fee you set (at most 1%)"],
  ["Fee rates swing; a dead pool keeps your money", "“Fees earn less than 10% a year” is a trigger: it leaves"],
  ["Tools give a few fixed buttons", "Your own steps and conditions, and any contract you paste as a condition"],
  ["You can’t know if a strategy works", "Replay it on real mainnet swaps first; the replay matches the contract within 0.1%"],
];

function Fixes() {
  return (
    <>
      <Head eyebrow="What goes wrong for LPs today" title="Every problem, and what Alucard does about it." />
      <div className="ls fx">
        <div className="ls-h in" style={d(200)}>
          <span>The problem</span>
          <span className="ruby">Alucard</span>
        </div>
        {FIXES.map(([a, b], k) => (
          <div key={a} className="ls-row in" style={d(320 + k * 130)}>
            <span className="ls-them">{a}</span>
            <span className="ls-us" style={d(480 + k * 130)}>
              {b}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 5b · your position, at a glance */

const PS_STEPS = [
  { at: 0, badge: "● In range", tone: "ok", line: "In range, earning fees. Watching: WETH leaves my range below.", price: 1712, down: "Watching", back: "—" },
  { at: 0.22, badge: "● Out of range", tone: "warn", line: "Out of range: not earning fees. Watching: WETH leaves my range below.", price: 1671, down: "Ready: a keeper runs it now", back: "—" },
  { at: 0.4, badge: "● Moved to USDT/USDC", tone: "blue", line: "Moved to USDT/USDC, earning fees there. Watching: WETH is back in my range.", price: 1642, down: "Ran 2 min ago: moved into USDT/USDC", back: "Waiting: WETH 1,642, range from 1,686" },
  { at: 0.72, badge: "● In range", tone: "ok", line: "In range, earning fees. Watching: WETH leaves my range below.", price: 1701, down: "Watching (ready for next time)", back: "Ran 1 min ago: back into the same range" },
];

function Position({ step }: { step: number }) {
  const st = PS_STEPS[Math.min(step, PS_STEPS.length - 1)];
  const lo = 1686;
  const hi = 1727;
  const x = (v: number) => ((v - 1620) / (1760 - 1620)) * 100;
  return (
    <>
      <Head eyebrow="Your position" title="Always know what it does, and what comes next." />
      <div className="ps solo">
        <div className="ps-card in" style={d(200)}>
          <div className="ps-top">
            <span className="ps-pair">WETH / USDC · 0.3%</span>
            <span className={`ps-badge ${st.tone}`}>{st.badge}</span>
          </div>
          <p className="ps-line">{st.line}</p>
          <div className="ps-bar">
            <i className="ps-range" style={{ left: `${x(lo)}%`, width: `${x(hi) - x(lo)}%` }} />
            <b className="ps-dot" style={{ left: `${x(st.price)}%` }}>
              <em>{st.price.toLocaleString("en-US")}</em>
            </b>
          </div>
          <div className="ps-rows">
            <div>
              <span>If WETH falls · move into USDT/USDC</span>
              <b className={step === 1 ? "go" : ""}>{st.down}</b>
            </div>
            <div>
              <span>Way back · when WETH is back in my range</span>
              <b>{st.back}</b>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 6b · every attack, and what stops it */

const ATTACKS = [
  ["Push the pool to fire your stop", "A pool’s price counts only within ~2% of Chainlink (0.5% for stablecoins)"],
  ["Push it a little, then sell you cheap", "Every swap must fill within your slippage of Chainlink, or the step waits"],
  ["Reset your “only if it lasts”", "Only prices near Chainlink, in every pool the side reads, can restart it"],
  ["Overcharge as the keeper", "The fee is yours to set: at most 1% of what the step moves, whatever the gas"],
  ["Steer the feeds, or pause everyone", "No instant admin power: every change waits two days; no upgrades, no pause"],
  ["Act on an old price, or an L2 outage", "No step runs without a fresh price; cancelling always works"],
];

function Attacks() {
  return (
    <>
      <Head eyebrow="Reviewed, attacked, fixed" title="Every attack we know of, and what stops it." />
      <div className="ls fx">
        <div className="ls-h in" style={d(200)}>
          <span>The attack</span>
          <span className="ruby">What stops it</span>
        </div>
        {ATTACKS.map(([a, b], k) => (
          <div key={a} className="ls-row in" style={d(320 + k * 130)}>
            <span className="ls-them">{a}</span>
            <span className="ls-us" style={d(480 + k * 130)}>
              {b}
            </span>
          </div>
        ))}
      </div>
      <p className="s-small in" style={{ ...d(1300), marginTop: 28 }}>
        Each one is a test the attacker must lose, run on every change (test/Manipulation.t.sol, Safety.t.sol, Conditions.t.sol). Not audited yet.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ 6 · landscape */

function Landscape() {
  const rows = [
    ["What you can set", "A few presets: exit at a price, re-range, compound", "Your own strategy: conditions, steps, moves to another pool and back, your own condition contract"],
    ["Where it runs", "The platform’s own vaults or pools", "Any Uniswap v4 pool of listed tokens, with or without our hook"],
    ["What it trusts", "The pool price, or the operator", "A pool’s price only near Chainlink; no step sells into a push"],
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

/* ------------------------------------------------------------------ 7b · your own condition */

function Cards() {
  return (
    <>
      <Head eyebrow="Your own condition" title="Anything that answers yes or no." />
      <pre className="cd-code solo in" style={d(250)}>{`interface IAlucardCondition {
  function isMet(address vault, uint256 orderId, bool upper)
    external view returns (bool);
}`}</pre>
      <p className="s-lead in" style={{ ...d(500), marginTop: 48 }}>
        Paste its address. It only decides <b>when</b>; it can’t touch your money.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ 8 · built */

function Built() {
  const facts = [
    ["Your strategy, card by card", "Two conditions, and / or, holds, repeats, run limits, your own condition contract"],
    ["Move to any pool and back", "Into any pool sharing a token, or hold one; back by your own rule"],
    ["Prices near Chainlink", "A push past ~2% does nothing; no step sells into a smaller one"],
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
              <Count to={48181} delay={900} duration={1800} />
            </p>
            <p className="s-small">strategy shapes, editor = contract</p>
          </div>
          <div className="in" style={d(1000)}>
            <p className="num">
              <Count to={2000} delay={1000} duration={1800} />
            </p>
            <p className="s-small">orders: same runs, money within 0.1%</p>
          </div>
          <div className="in" style={d(1100)}>
            <p className="num">
              <Count to={161} delay={1100} duration={1800} />
            </p>
            <p className="s-small">contract tests, attacks included</p>
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
          <p>Live on Ethereum Sepolia and Unichain Sepolia</p>
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

export type Slide = {
  id: string;
  title: string;
  theme: "paper" | "enamel" | "night";
  C: (p: { step: number }) => ReactNode;
  notes: string;
  /** parts revealed one click at a time */
  steps?: number;
  /** after the close: for questions */
  backup?: boolean;
};

export const SLIDES: Slide[] = [
  {
    id: "cover",
    title: "Alucard",
    theme: "enamel",
    C: Cover,
    notes: "Hi, I’m Roshan. This is Alucard: your Uniswap position, with your own rules, running on-chain while you’re away.",
  },
  {
    id: "problem",
    title: "The problem",
    theme: "night",
    C: Problem,
    notes: "When you provide liquidity on Uniswap, there is nothing to set. If the price leaves your range, you stop earning, and the pool has already turned your whole position into the token that fell. Nothing happens unless you are watching. And it is common: in the first half of 2026, about 30% of concentrated liquidity sat out of range, earning nothing.",
  },
  {
    id: "idea",
    title: "The idea",
    theme: "night",
    C: Idea,
    notes: "Alucard lets you tell your position what to do. If ETH falls out of my range, park it in the USDT/USDC pool and bring it back when ETH recovers. If fees earn less than 10% a year, take my liquidity out. Or plug in your own contract as the condition. Re-ranging, profit-taking, trailing stops, compounding: any mix.",
  },
  {
    id: "build",
    title: "Build it",
    theme: "enamel",
    C: Build,
    steps: 3,
    notes: "Building one takes a minute. [click] If WETH falls out of the range, move into USDT/USDC, and come back when it is back. [click] If it rises, take 25% profit, up to four times. That is the whole strategy. You can also just type that sentence to the assistant.",
  },
  {
    id: "position",
    title: "Your position",
    theme: "enamel",
    C: Position,
    steps: 4,
    notes: "And you always know what it is doing. In range, earning. [click] The price falls out: the side is ready, and any keeper runs it. [click] Now the money is in USDT/USDC, earning there, and the way back tells you how far WETH is from coming home. [click] WETH recovers, and it is back in the same range, ready for next time.",
  },
  {
    id: "cards",
    title: "Your own condition",
    theme: "night",
    C: Cards,
    notes: "If the conditions we built aren’t enough, write your own: any contract with one function that answers yes or no. Paste its address into the builder. It only decides when; the vault still does everything else, with every guard.",
  },
  {
    id: "safe",
    title: "Safe",
    theme: "paper",
    C: Safe,
    notes: "We had it attacked on paper, and every attack is now a test it passes. Pushing the pool to fire your stop does nothing: prices only count near Chainlink. Pushing it a little to sell you cheap does not work either: every swap fills within your slippage or waits. And nobody, including us, can act on the spot. It is not audited yet; that is next.",
  },
  {
    id: "proof",
    title: "Built",
    theme: "paper",
    C: Proof,
    notes: "It is live on Ethereum Sepolia and Unichain Sepolia. The builder and the contract agree on every one of 48,181 strategy shapes. Replays on real mainnet swaps match the contract’s money within 0.1%. And 161 contract tests, attacks included.",
  },
  {
    id: "next",
    title: "What’s next",
    theme: "enamel",
    C: Next,
    notes: "Next: an audit and mainnet; bringing positions people already hold; and a gallery where strategies are ranked by how they replay, not by votes.",
  },
  {
    id: "close",
    title: "Thank you",
    theme: "enamel",
    C: Close,
    notes: "That’s Alucard: set your rules once, and put the position down. It’s live on Sepolia and Unichain Sepolia, the code is public, and I’m happy to show the app or the backtest live. Thank you.",
  },
  {
    id: "fixes",
    title: "Every problem, fixed",
    theme: "paper",
    C: Fixes,
    backup: true,
    notes: "Here is what goes wrong for a liquidity provider today, and what Alucard does about each. Out of range, the position earns nothing: it leaves, re-ranges, or parks in another pool and comes back, by your rules. It ends up all in the token that fell: it can swap to a stablecoin or move into a stable pool the moment it leaves. Someone has to watch day and night: any keeper runs it on-chain, paid only the fee you set. Fee rates swing: a falling fee rate is a trigger. Tools give a few fixed buttons: here you set your own steps, and even paste your own condition contract. And you can replay it on real mainnet swaps before you commit; the replay matches the contract within 0.1%.",
  },
  {
    id: "attacks",
    backup: true,
    title: "Every attack, and what stops it",
    theme: "paper",
    C: Attacks,
    notes: "We had the contracts attacked on paper by outside reviewers, and every attack became a test the attacker must lose. Pushing the pool to fire your stop does nothing: a pool's price counts only near Chainlink. Pushing it a little and then selling you cheap does not work: every swap must fill within your slippage of Chainlink, or the step simply waits. Your hold cannot be reset by a pushed price. A keeper cannot overcharge: the fee is yours, capped at 1%. The admin has no instant power: every change waits two days, and there are no upgrades and no pause. And nothing runs on an old price. It is not audited yet; that is the next step.",
  },
  {
    id: "landscape",
    backup: true,
    title: "What exists today",
    theme: "paper",
    C: Landscape,
    notes: "Today’s tools give you a short menu: exit at a target price, move the range, compound fees. They watch the pool price, or an operator, and their own bot runs it. Alucard is the parts: conditions, steps, a move to another pool and back. Anyone can run a step and is paid the fee you set, a share of what the step moves, whatever the gas price. Before you commit, you replay that exact strategy on real history, with an engine we test against the contract run for run.",
  },
  {
    id: "how",
    backup: true,
    title: "How it works",
    theme: "enamel",
    C: How,
    notes: "Every strategy has four parts. When: the conditions, two of them with and or or, and a hold so it has to stay true. Then: the steps, including a move to another pool that comes back by your own rule. Limits: slippage, the keeper fee, how many times it can run, when it expires, all checked by the contract. And the keeper: anyone can call execute once the condition holds, and is paid your fee, 0.1% by default and at most 1%. The money stays inside Uniswap v4 until you withdraw. The example on screen is one side, illustrative.",
  },
  {
    id: "uses",
    backup: true,
    title: "What you can tell it",
    theme: "night",
    C: Uses,
    notes: "So what does a rule look like? In Uniswap today, once you add liquidity there is nothing to configure. With Alucard: if ETH falls out of my range, park the money in the USDT/USDC pool and bring it back when ETH recovers. If it leaves my range, re-range. Fee rates swing a lot, so you can make them a trigger: if the APR drops below 10%, take my liquidity out. Take profit in steps on the way up, a trailing stop on the way down, and ignore quick wicks with a hold. Other tools give you a few of these as fixed buttons; here you combine them however you want.",
  },
  {
    id: "idle",
    backup: true,
    title: "The problem",
    theme: "paper",
    C: Idle,
    notes: "A 2026 Dune study looked at concentrated liquidity across seven chains. In a typical week only about 14% of it was used by trades. 57% sat in range but untouched, and close to a third was out of range, earning nothing. Almost half of the out-of-range money stayed untouched for 90 days, and most of it belongs to individual wallets, not managers. Those are the people Alucard is for.",
  },
  {
    id: "trap",
    backup: true,
    title: "Why out of range hurts",
    theme: "night",
    C: Trap,
    notes: "Concentrated liquidity has a trap. Once the price leaves your range you earn nothing, but the pool has already converted your whole position into the token that fell, so you keep taking the full drop. Nothing gets you out unless you watch the price and act yourself, day and night. That’s the job Alucard does. Alucard does not pick a strategy, and it does not claim one beats holding.",
  },
  {
    id: "built",
    backup: true,
    title: "Built and live",
    theme: "paper",
    C: Built,
    notes: "What’s live on Sepolia and Unichain Sepolia. Two conditions, and or or, holds, repeats and run limits. Move into any pool that shares a token, or hold one token, and come back by your own rule. A pool’s price counts only near Chainlink, and no step sells into a push; a real move runs at once. You can also add a Chainlink price condition, or your own condition contract. Keepers are paid the fee you set, whatever the gas. The hook fills limit orders inside swaps. The checks: 48,181 strategy shapes where the editor and the contract agree, 2,000 orders where the backtest and the contract run at the same swaps and end within 0.1% of each other’s money on the strategies that test covers, 161 contract tests including the in-band pushes an outside review asked about. You can also just say the strategy to the assistant: it asks back, then fills in the same steps.",
  },
];
