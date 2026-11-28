"use client";

// Alucard's landing: the watcher that works at night. A black hole for the hero (the position, and the gravity that
// pulls the money back), then what it does in the order a visitor asks: what is it, how do I set one up, what does
// a move look like, why can nobody fire it, what am I trusting, what is proven.
import { motion, useInView, useScroll, useTransform, type MotionValue } from "framer-motion";
import { ArrowRight, Check, Eye, KeyRound, Moon, Radio, ShieldCheck, Sparkles, TriangleAlert, Users, Wand2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DEPLOYMENTS } from "@/lib/deployments";
import Horizon from "./Horizon";

const EASE = [0.22, 1, 0.36, 1] as const;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Rise({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.9, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function Nav() {
  return (
    <nav className="n-nav">
      <Link href="/" className="flex items-center gap-2.5">
        <Mark />
        <span className="n-word">Alucard</span>
      </Link>
      <div className="flex items-center gap-1 sm:gap-5">
        <a href="#build" className="n-navlink max-sm:hidden">How it works</a>
        <a href="#trust" className="n-navlink max-sm:hidden">Trust</a>
        <Link href="/docs" className="n-navlink">Docs</Link>
        <Link href="/pool/new" className="n-btn n-btn-glow !py-2 !text-[14px]">
          Open the app
        </Link>
      </div>
    </nav>
  );
}

export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="mk" x1="0" x2="1">
          <stop offset="0" stopColor="#ffb46b" />
          <stop offset="0.5" stopColor="#c4b2ff" />
          <stop offset="1" stopColor="#6d7cff" />
        </linearGradient>
      </defs>
      <ellipse cx="32" cy="32" rx="29" ry="9" transform="rotate(-18 32 32)" fill="none" stroke="url(#mk)" strokeWidth="3" />
      <circle cx="32" cy="32" r="12.5" fill="#05040b" stroke="#e8e0ff" strokeWidth="1.6" />
      <path d="M8 38 Q32 25 56 26" transform="rotate(-18 32 32)" fill="none" stroke="url(#mk)" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- hero

function Hero() {
  return (
    <section className="n-hero">
      <div className="n-hero-copy">
        <motion.p className="n-eyebrow" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.6, ease: EASE }}>
          <Moon className="h-3.5 w-3.5" /> Uniswap v4 · live on Sepolia and Unichain
        </motion.p>
        <motion.h1 className="n-h1" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.2, delay: 0.2, ease: EASE }}>
          You sleep.
          <br />
          <span className="n-grad">It keeps watch.</span>
        </motion.h1>
        <motion.p className="n-lead" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.1, delay: 0.45, ease: EASE }}>
          A Uniswap liquidity position has no settings: the money just sits there, even when the price runs out of your range. Alucard lets you tell it what
          to do. Park it in a stablecoin pool while ETH dumps and bring it back after, re-range, take profit, leave when the fees dry up. Any keeper runs it
          on-chain, and the money never leaves Uniswap v4.
        </motion.p>
        <motion.div className="mt-9 flex flex-col gap-3 sm:flex-row" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.7 }}>
          <Link href="/pool/new" className="n-btn n-btn-glow">
            Build a strategy <ArrowRight className="h-4 w-4" />
          </Link>
          <a href="#problem" className="n-btn n-btn-line">
            Why it matters
          </a>
        </motion.div>
      </div>
      <div className="n-scrollcue" aria-hidden="true" />
    </section>
  );
}

// ---------------------------------------------------------------- the problem, in the words we use to explain it

function Problem() {
  return (
    <section id="problem" className="n-sec">
      <div className="n-wrap grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
        <Rise>
          <p className="n-kicker">
            <TriangleAlert className="h-4 w-4" /> The problem
          </p>
          <h2 className="n-h2">Your liquidity can’t be told what to do.</h2>
          <p className="n-p">
            On Uniswap you choose a range and the money sits there. When the price leaves the range, two things happen at once: you stop earning fees, and the
            pool has already swapped your whole position into the token that fell. Nothing changes until you notice and act yourself, at any hour.
          </p>
          <p className="n-p">
            Some apps add a stop-loss or auto-compounding: a few fixed buttons. Alucard gives you the parts to write the plan you actually want.
          </p>
        </Rise>
        <Rise delay={0.12}>
          <OutOfRange />
        </Rise>
      </div>
      <div className="n-wrap mt-14 grid gap-4 sm:grid-cols-2">
        <Rise>
          <div className="n-stat">
            <b>~4 in 10</b>
            <span>
              positions in Uniswap v3’s largest ETH/USDC pool were out of range, earning no fees, when CrocSwap counted them in 2022.{" "}
              <a className="n-link" href="https://crocswap.medium.com/impermanent-loss-and-jit-liquidity-in-the-uniswap-eth-usdc-0-3-pool-8fc58c755d7" target="_blank" rel="noreferrer">
                CrocSwap
              </a>
            </span>
          </div>
        </Rise>
        <Rise delay={0.08}>
          <div className="n-stat">
            <b>~30%</b>
            <span>
              of the capital in concentrated-liquidity pools sat out of range, on average over 26 weeks of 2026.{" "}
              <a className="n-link" href="https://www.theblock.co/news/defi/2026-07-16-dune-research-finds-85-of-concentrated-defi-liquidity-is-underutilized-with-150m-in-annual-fees-foregone-408591" target="_blank" rel="noreferrer">
                Dune, via The Block
              </a>
            </span>
          </div>
        </Rise>
      </div>
    </section>
  );
}

/** A range, a price that falls out of it, and what that does to the position: a loop. */
function OutOfRange() {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setT(0.8);
    let raf = 0;
    const t0 = performance.now();
    const f = (now: number) => {
      setT(((now - t0) / 7000) % 1);
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, []);
  // price path: wanders inside the range, then falls out and stays there
  const x = t < 0.45 ? 0.55 + 0.12 * Math.sin(t * 18) : Math.max(0.12, 0.55 + 0.12 * Math.sin(0.45 * 18) - (t - 0.45) * 1.6);
  const lo = 0.34;
  const hi = 0.78;
  const inside = x >= lo && x <= hi;
  const eth = inside ? 0.5 + (0.56 - x) * 1.1 : 1; // below the range: all ETH
  const price = Math.round(1500 + x * 1000);
  return (
    <div className="n-oor" aria-label="A price falling out of a range: fees stop and the position becomes all ETH">
      <div className="n-oor-track">
        <div className="n-oor-band" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }}>
          <span>your range</span>
        </div>
        <div className={`n-oor-dot ${inside ? "" : "out"}`} style={{ left: `${x * 100}%` }}>
          <i>ETH ${price.toLocaleString("en-US")}</i>
        </div>
      </div>
      <div className="n-oor-row">
        <span>Fees</span>
        <b className={inside ? "" : "dead"}>{inside ? "earning" : "$0 an hour"}</b>
      </div>
      <div className="n-oor-row">
        <span>Your position</span>
        <div className="n-oor-mix">
          <div style={{ width: `${Math.min(1, Math.max(0, eth)) * 100}%` }} />
        </div>
        <b className={inside ? "" : "dead"}>{Math.round(Math.min(1, eth) * 100)}% ETH</b>
      </div>
      <div className="n-oor-row">
        <span>Who acts</span>
        <b className={inside ? "" : "dead"}>{inside ? "nobody needs to" : "nobody, unless you are awake"}</b>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- what you can tell it

const USES = [
  { when: "ETH falls out of my range", then: "Park the money in the USDT/USDC pool, and bring it back once ETH is back in my range.", tag: "Move and return" },
  { when: "it leaves my range", then: "Re-centre a new range around the price, whichever way it went.", tag: "Re-range" },
  { when: "the fee APR falls below 10%", then: "Take my liquidity out. Rates swing; the trigger is yours.", tag: "Leave when fees dry up" },
  { when: "ETH rises 10%", then: "Take 25% profit, then again every 5% higher, four times.", tag: "Take profit in steps" },
  { when: "ETH falls 8% from its best", then: "Withdraw everything and sell to USDC.", tag: "Trailing stop" },
  { when: "a day has passed", then: "Put the fees earned back into the position.", tag: "Compound" },
  { when: "my own contract says so", then: "Paste any contract that answers yes or no: a depeg, volatility, any logic. It decides when; the vault does the rest.", tag: "Your own condition" },
];

function Uses() {
  return (
    <section id="uses" className="n-sec">
      <div className="n-wrap">
        <Rise className="max-w-3xl">
          <p className="n-kicker">
            <Wand2 className="h-4 w-4" /> What would you tell it?
          </p>
          <h2 className="n-h2">If this happens, do that. In your words.</h2>
          <p className="n-p">
            Each line below is a strategy you can build in a minute, by picking cards or by typing the sentence to the assistant. Combine them: one plan for
            when the price falls and another for when it rises, two conditions joined with and/or, “only if it lasts 30 minutes”, repeat it N times.
          </p>
        </Rise>
        <div className="n-uses">
          {USES.map((u, k) => (
            <Rise key={u.tag} delay={k * 0.06}>
              <div className="n-use">
                <span className="n-use-tag">{u.tag}</span>
                <p>
                  <em>If</em> {u.when},
                </p>
                <p className="n-use-then">{u.then}</p>
              </div>
            </Rise>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- build: a sentence becomes cards

const ASK = "If ETH drops out of my range, park it in USDT/USDC and bring it back when ETH is back in range.";
const CARDS = [
  { side: "falls", k: "When", t: "Leaves my range", s: "ETH leaves my range below" },
  { side: "falls", k: "Then move it", t: "Into USDT / USDC · 0.01%", s: "swapped to USDC, a ±0.2% range there" },
  { side: "falls", k: "Come back when", t: "ETH is back in my range", s: "checked against Chainlink" },
  { side: "falls", k: "Back into", t: "The same range", s: "1,686 – 1,727 USDC" },
];

function Build() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, margin: "-120px" });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!seen) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) return setN(ASK.length + 60);
    const id = setInterval(() => setN((x) => (x > ASK.length + 60 ? x : x + 1)), 28);
    return () => clearInterval(id);
  }, [seen]);
  const typed = ASK.slice(0, n);
  const shown = Math.max(0, Math.min(CARDS.length, Math.floor((n - ASK.length - 6) / 10)));
  return (
    <section id="build" className="n-sec">
      <div className="n-wrap grid items-center gap-14 lg:grid-cols-[1fr_1.15fr]">
        <Rise>
          <p className="n-kicker">
            <Sparkles className="h-4 w-4" /> Say it
          </p>
          <h2 className="n-h2">Describe it. The cards fill themselves in.</h2>
          <p className="n-p">
            Type or say what you want. The assistant fills in the same cards you could pick by hand. Every card is checked against what the contract allows, so
            it can only build what the chain accepts. It never signs: you read the plain-words summary, replay it on real history, then save.
          </p>
          <ul className="n-ticks">
            <li>
              <Check className="h-4 w-4" /> Only options that fit after the card above, and a reason for the rest
            </li>
            <li>
              <Check className="h-4 w-4" /> One click to replay it on real swaps
            </li>
          </ul>
        </Rise>
        <div ref={ref} className="n-app">
          <div className="n-app-bar">
            <span className="n-dot" />
            <span className="n-dot" />
            <span className="n-dot" />
            <span className="ml-3 truncate text-[12px] text-[var(--muted)]">Strategy · WETH / USDC · 0.3% · range 1,686 – 1,727</span>
          </div>
          <div className="n-ask">
            <Sparkles className="h-4 w-4 shrink-0 text-[var(--glow)]" />
            <span className="min-w-0 flex-1">
              {typed}
              {n < ASK.length && <span className="n-caret" />}
            </span>
            <span className={`n-ask-go ${n >= ASK.length ? "on" : ""}`}>Build</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="n-pill down">If ETH falls</p>
              <div className="n-stack">
                {CARDS.slice(0, shown).map((c, i) => (
                  <motion.div key={c.t} className={`n-card ${i ? "move" : ""}`} initial={{ opacity: 0, y: -8, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.45, ease: EASE }}>
                    <em>{c.k}</em>
                    <b>{c.t}</b>
                    <i>{c.s}</i>
                  </motion.div>
                ))}
              </div>
            </div>
            <div>
              <p className="n-pill up">If ETH rises</p>
              <div className="n-card ghost">Nothing happens</div>
              {shown >= CARDS.length && (
                <motion.div className="n-sum" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
                  <p className="n-sum-h">In plain words</p>
                  When ETH leaves my range (below): swap to USDC and move it into USDT / USDC. It comes back into the same range when ETH is back in it.
                  <span className="n-sum-ok">
                    <ShieldCheck className="h-3.5 w-3.5" /> the contract accepts this
                  </span>
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the move: one position, two homes

const PATH = (() => {
  // ETH's price: drifts, falls out of the range, waits, comes back
  const pts: [number, number][] = [];
  for (let k = 0; k <= 120; k++) {
    const x = k / 120;
    let y = 0.45 + 0.03 * Math.sin(x * 40);
    if (x > 0.22) y += Math.min(0.32, (x - 0.22) * 2.2);
    if (x > 0.6) y -= Math.min(0.34, (x - 0.6) * 1.6);
    y += 0.012 * Math.sin(x * 97);
    pts.push([x, y]);
  }
  return pts;
})();

function Move() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const p = useTransform(scrollYProgress, [0.18, 0.72], [0, 1], { clamp: true });
  return (
    <section id="move" ref={ref} className="n-sec">
      <div className="n-wrap">
        <Rise className="max-w-3xl">
          <p className="n-kicker">
            <Radio className="h-4 w-4" /> One position, two homes
          </p>
          <h2 className="n-h2">It leaves when your range dies. It comes back when it lives again.</h2>
          <p className="n-p">
            Out of range, a position earns nothing and holds only the falling token. With a move, the money goes into another Uniswap pool that shares a token,
            earns there, and comes back by your own rule. It never leaves Uniswap v4.
          </p>
        </Rise>
        <MoveChart p={p} />
      </div>
    </section>
  );
}

function MoveChart({ p }: { p: MotionValue<number> }) {
  const [v, setV] = useState(0);
  useEffect(() => p.on("change", setV), [p]);
  const W = 1000,
    H = 360,
    lo = 0.38,
    hi = 0.52;
  const k = Math.round(v * 120);
  const d = PATH.slice(0, k + 1)
    .map(([x, y], i) => `${i ? "L" : "M"}${x * W},${y * H}`)
    .join(" ");
  const [hx, hy] = PATH[k];
  const out = hy > hi + 0.0;
  const phase = v < 0.3 ? "In range: earning fees" : v < 0.78 ? "Out of range → moved into USDT / USDC, earning there" : "ETH is back in range → moved back into the same range";
  return (
    <div className="n-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="ETH leaves the range, the money moves to another pool, and comes back">
        <defs>
          <linearGradient id="mvline" x1="0" x2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#6d7cff" />
          </linearGradient>
        </defs>
        <rect x="0" y={lo * H} width={W} height={(hi - lo) * H} className="n-band" />
        <text x="12" y={lo * H - 10} className="n-axis">your range</text>
        <path d={d} fill="none" stroke="url(#mvline)" strokeWidth="2.5" />
        <circle cx={hx * W} cy={hy * H} r="7" className={out ? "n-orb away" : "n-orb"} />
        {/* the other pool: where the money waits */}
        <g transform={`translate(${W - 190} ${H - 92})`} className={`n-park ${out ? "on" : ""}`}>
          <rect width="170" height="66" rx="12" />
          <text x="16" y="28" className="n-park-t">USDT / USDC · 0.01%</text>
          <text x="16" y="48" className="n-park-s">{out ? "your money is here, earning" : "waiting"}</text>
        </g>
      </svg>
      <p className="n-chart-cap">{phase}</p>
    </div>
  );
}

// ---------------------------------------------------------------- the guard

function Guard() {
  return (
    <section className="n-sec">
      <div className="n-wrap grid items-center gap-12 lg:grid-cols-2">
        <Rise>
          <p className="n-kicker">
            <Eye className="h-4 w-4" /> Nobody can fire it for you
          </p>
          <h2 className="n-h2">A push can’t make your step sell cheap.</h2>
          <p className="n-p">
            A pool&apos;s price counts only while it is within about 2% of Chainlink&apos;s (0.5% for two stablecoins), so a bigger push fires nothing,
            however long it is held. And every swap a step makes must fill within your slippage of Chainlink&apos;s price, or the step simply waits while
            your position keeps earning. Want Chainlink itself to confirm a level? Add the Chainlink price condition with “and”.
          </p>
        </Rise>
        <Rise delay={0.15}>
          <div className="n-guard">
            {[
              ["Pool pushed 7% below the stop", "refused", "no"],
              ["Pushed 1.5% to sell you cheap", "the step waits: no sale below Chainlink", "no"],
              ["…with a Chainlink condition added", "it doesn’t fire at all", "no"],
              ["Chainlink falls with it", "the step runs", "go"],
            ].map(([a, b, c], i) => (
              <motion.div
                key={a}
                className={`n-guard-row ${c}`}
                initial={{ opacity: 0, x: 20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.3 + i * 0.35, duration: 0.6, ease: EASE }}
              >
                <span>{a}</span>
                <b>{b}</b>
              </motion.div>
            ))}
            <p className="mt-3 text-[12.5px] text-[var(--muted)]">From the tests in test/Manipulation.t.sol, run on every change.</p>
          </div>
        </Rise>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- trust

function Trust() {
  const rows = [
    { i: KeyRound, h: "Only you can take the money out", b: "Positions are held by the contract per order; cancel at any time, wherever the money is. After expiry anyone can close it, and it still goes to you." },
    { i: Users, h: "Keepers: anyone, paid what you set", b: "Any address can run a step once its condition is true. It earns your keeper fee (0.1% by default, at most 1%) of what the step moves, nothing else." },
    { i: Eye, h: "Chainlink decides what a price is", b: "A pool's price counts only near Chainlink's. With no fresh Chainlink price (or an L2 sequencer that just restarted), nothing runs; cancelling always works." },
    { i: ShieldCheck, h: "The admin can’t act on the spot", b: "The token list and the price bands are the only settings, and every change waits two days after it is announced. No upgrades, no pause, no fee switch." },
  ];
  return (
    <section id="trust" className="n-sec">
      <div className="n-wrap">
        <Rise className="max-w-3xl">
          <p className="n-kicker">
            <ShieldCheck className="h-4 w-4" /> What you are trusting
          </p>
          <h2 className="n-h2">Four things, said plainly.</h2>
        </Rise>
        <div className="mt-12 grid gap-4 md:grid-cols-2">
          {rows.map((r, k) => (
            <Rise key={r.h} delay={k * 0.08}>
              <div className="n-trust">
                <r.i className="h-5 w-5 text-[var(--glow)]" />
                <h3>{r.h}</h3>
                <p>{r.b}</p>
              </div>
            </Rise>
          ))}
        </div>
        <p className="mt-6 text-[14px] text-[var(--muted)]">
          Not audited yet. On testnets nobody arbitrages the pools, so we run a small bot that keeps them on Chainlink, the job arbitrageurs do on mainnet.
          Every attack we know of, and what stops it, is in the <Link href="/docs#safety" className="n-link">docs</Link>.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- proof

function Count({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true });
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!seen) return;
    const t0 = performance.now();
    let raf = 0;
    const f = (t: number) => {
      const x = Math.min(1, (t - t0) / 1400);
      setV(Math.round(to * (1 - Math.pow(1 - x, 3))));
      if (x < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [seen, to]);
  return (
    <span ref={ref}>
      {v.toLocaleString("en-US")}
      {suffix}
    </span>
  );
}

function Proof() {
  const rows: [number, string, string][] = [
    [43554, "", "strategy shapes where the editor and the contract agree"],
    [2000, "", "random orders where the backtest fires at the same swaps as the contract"],
    [2000, "", "of them end within 0.1% of the contract’s money (on the strategies that test covers)"],
    [161, "", "contract tests, fuzz included, all passing"],
  ];
  return (
    <section className="n-sec">
      <div className="n-wrap">
        <Rise>
          <h2 className="n-h2 max-w-3xl">The replay is the contract. We checked.</h2>
        </Rise>
        <div className="mt-12 grid gap-px overflow-hidden rounded-[16px] border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-4">
          {rows.map(([n, s, t]) => (
            <div key={t} className="bg-[var(--paper)] p-6">
              <div className="n-num">
                <Count to={n} suffix={s} />
              </div>
              <p className="mt-2 text-[14px] text-[var(--ink2)]">{t}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-[14px] text-[var(--muted)]">
          Live on{" "}
          {DEPLOYMENTS.map((d, k) => (
            <span key={d.id}>
              {k > 0 && "; "}
              {d.label}:{" "}
              {(["conditionalOrders", "rules", "ruleHook"] as const).map((n, i) => (
                <span key={n}>
                  {i > 0 && " · "}
                  <a className="n-link" href={`${d.explorer}/address/${d.core[n]}`} target="_blank" rel="noreferrer">
                    {n === "conditionalOrders" ? "ConditionalOrders" : n === "rules" ? "Rules" : "RuleHook"} {short(d.core[n])}
                  </a>
                </span>
              ))}
            </span>
          ))}
        </p>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section className="n-sec n-close">
      <div className="n-wrap text-center">
        <Rise>
          <h2 className="n-h2 mx-auto max-w-3xl">Set your strategy. Then go to sleep.</h2>
          <p className="n-p mx-auto">Free test tokens are one click away in the app.</p>
          <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/pool/new" className="n-btn n-btn-glow">
              Build a strategy <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/docs" className="n-btn n-btn-line">
              Read the docs
            </Link>
          </div>
        </Rise>
        <footer className="mt-28 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--line)] pt-6 text-[14px] text-[var(--muted)]">
          <span className="flex items-center gap-2 text-[var(--ink)]">
            <Mark size={20} /> Alucard
          </span>
          <span>Uniswap v4 · Uniswap Hook Incubator</span>
          <span className="flex gap-5">
            <Link href="/swap" className="hover:text-[var(--ink)]">App</Link>
            <Link href="/docs" className="hover:text-[var(--ink)]">Docs</Link>
            <a href="https://github.com/Ronnieraj37/alucard" target="_blank" rel="noreferrer" className="hover:text-[var(--ink)]">GitHub</a>
          </span>
        </footer>
      </div>
    </section>
  );
}

export default function NightLanding() {
  return (
    <div className="n-page">
      <Horizon />
      <Nav />
      <Hero />
      <Problem />
      <Uses />
      <Build />
      <Move />
      <Guard />
      <Trust />
      <Proof />
      <Close />
    </div>
  );
}
