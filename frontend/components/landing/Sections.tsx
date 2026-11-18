"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { animate, motion, useInView, useReducedMotion, useScroll, useSpring } from "framer-motion";
import { ArrowRight, FlaskConical, Landmark, PenLine, Zap } from "lucide-react";
import { CORE } from "@/lib/pools";

const EASE = [0.22, 1, 0.36, 1] as const;

// ---------------------------------------------------------------- rules: what a position can do on its own

type Diagram = "take" | "trail" | "follow" | "compound";
const RULES: { id: Diagram; name: string; line: string; body: string }[] = [
  { id: "trail", name: "Trailing stop", line: "Leave when it turns.", body: "The exit follows the price up and holds when it falls. Convert to USDC on the way out." },
  { id: "take", name: "Take profit", line: "Leave at your price.", body: "When the price leaves your range on the way up, withdraw everything, or 25% at every 5% step." },
  { id: "follow", name: "Follow the price", line: "Never sit out of range.", body: "When the price walks away, the range moves with it, so the position keeps earning fees." },
  { id: "compound", name: "Compound", line: "Fees that work too.", body: "On a timer or a fee threshold, the fees go back into the position." },
];

function MiniChart({ kind }: { kind: Diagram }) {
  const calm = useReducedMotion();
  const loop = calm ? undefined : { duration: 6, repeat: Infinity, ease: "easeInOut" as const, repeatDelay: 0.6 };
  // a 240 x 120 scene; the moon dot walks a path and the rule reacts
  const paths: Record<Diagram, string> = {
    trail: "M10,80 C50,70 70,40 100,36 S150,30 160,42 S200,92 230,100",
    take: "M10,92 C60,90 90,70 120,58 S180,26 230,18",
    follow: "M10,70 C60,66 90,50 120,46 S180,30 230,24",
    compound: "M10,64 C60,60 90,66 120,60 S180,58 230,62",
  };
  return (
    <svg viewBox="0 0 240 120" className="h-32 w-full">
      {kind === "follow" ? (
        <motion.rect
          x="10"
          width="110"
          y="40"
          height="36"
          rx="6"
          fill="rgba(240,194,123,0.1)"
          stroke="rgba(240,194,123,0.45)"
          animate={loop ? { x: [10, 10, 120, 120], y: [40, 40, 14, 14] } : undefined}
          transition={loop ? { ...loop, times: [0, 0.45, 0.6, 1] } : undefined}
        />
      ) : (
        <rect x="10" width="220" y={kind === "take" ? 50 : 44} height="36" rx="6" fill="rgba(240,194,123,0.08)" stroke="rgba(240,194,123,0.35)" />
      )}
      {kind === "trail" && <motion.line x1="10" x2="230" stroke="var(--n-crimson)" strokeDasharray="4 5" animate={loop ? { y1: [92, 50, 50, 50], y2: [92, 50, 50, 50] } : undefined} transition={loop ? { ...loop, times: [0, 0.4, 0.6, 1] } : undefined} y1="50" y2="50" />}
      {kind === "take" && <line x1="10" x2="230" y1="50" y2="50" stroke="var(--n-gold)" strokeDasharray="4 5" />}
      <path d={paths[kind]} fill="none" stroke="rgba(239,233,220,0.25)" strokeWidth="2" />
      <motion.path d={paths[kind]} fill="none" stroke="var(--n-moon)" strokeWidth="2.2" initial={{ pathLength: calm ? 1 : 0 }} animate={loop ? { pathLength: [0, 1, 1] } : undefined} transition={loop ? { ...loop, times: [0, 0.75, 1] } : undefined} />
      {kind === "compound" &&
        [0, 1, 2].map((k) => (
          <motion.circle key={k} r="3" fill="var(--n-sea)" cx={60 + k * 60} initial={{ cy: 30, opacity: 0 }} animate={loop ? { cy: [24, 60], opacity: [0, 1, 0] } : undefined} transition={loop ? { ...loop, delay: k * 0.5 } : undefined} />
        ))}
      {kind === "trail" && <motion.circle cx="200" cy="92" r="6" fill="var(--n-crimson)" initial={{ opacity: calm ? 1 : 0 }} animate={loop ? { opacity: [0, 0, 1, 0] } : undefined} transition={loop ? { ...loop, times: [0, 0.6, 0.72, 1] } : undefined} />}
      {kind === "take" && <motion.circle cx="168" cy="38" r="6" fill="var(--n-gold)" initial={{ opacity: calm ? 1 : 0 }} animate={loop ? { opacity: [0, 0, 1, 0] } : undefined} transition={loop ? { ...loop, times: [0, 0.55, 0.65, 1] } : undefined} />}
    </svg>
  );
}

export function RulesGallery() {
  const track = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <section className="px-5 py-28 sm:py-36">
      <div className="mx-auto max-w-6xl">
        <Heading kicker="What it can do" title={<>Rules for the moments <em className="n-moonlit">you miss.</em></>} body="Pick a template or build your own: conditions on the price, a Chainlink feed, time or fees, joined with and/or, then the steps to take." />
        <div className="mt-16 grid gap-4 sm:grid-cols-2">
          {RULES.map((r, i) => (
            <motion.article
              key={r.id}
              onPointerMove={track}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.35 }}
              transition={{ duration: 0.8, delay: (i % 2) * 0.1, ease: EASE }}
              className="n-panel n-spot rounded-[26px] p-6 sm:p-8"
            >
              <MiniChart kind={r.id} />
              <p className="n-mono mt-4 text-xs uppercase tracking-[0.22em] text-[var(--n-faint)]">{r.name}</p>
              <h3 className="n-display mt-2 text-3xl">{r.line}</h3>
              <p className="mt-2 leading-relaxed text-[var(--n-dim)]">{r.body}</p>
            </motion.article>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- how it runs: four steps, a line fills as you scroll

const STEPS = [
  { icon: PenLine, k: "01", title: "Draw your rule", body: "In the editor, pick when and what: \"if WETH falls 5% from its high, withdraw and convert to USDC\". It reads back in plain words before you sign.", tag: "Templates · and / or · repeats" },
  { icon: FlaskConical, k: "02", title: "Backtest it", body: "Replay it on six months of your pool's Chainlink prices, or on real mainnet ETH/USDC swaps. Same steps as the contract, checked run for run.", tag: "No wallet needed" },
  { icon: Zap, k: "03", title: "Anyone can run it", body: "When the condition holds, any keeper can execute it. It is paid its gas from the position, in the position's tokens, never above your cap.", tag: "No central operator" },
  { icon: Landmark, k: "04", title: "Your money stays in Uniswap", body: "The position lives in a Uniswap v4 pool the whole time. The contract checks every limit: price, slippage, fee cap, run count. Cancel any time.", tag: "Uniswap v4 hook" },
];

function Step({ s, i }: { s: (typeof STEPS)[number]; i: number }) {
  const ref = useRef<HTMLLIElement | null>(null);
  const lit = useInView(ref, { amount: 0.6, margin: "0px 0px -20% 0px" });
  const right = i % 2 === 1;
  return (
    <li ref={ref} className="relative grid grid-cols-[40px_1fr] gap-6 md:grid-cols-[1fr_64px_1fr] md:gap-0">
      <div className="relative flex justify-center md:col-start-2 md:row-start-1">
        <span className={`relative z-10 mt-7 grid h-10 w-10 place-items-center rounded-full border transition-all duration-700 ${lit ? "border-white/70 bg-[radial-gradient(circle,#fff3e6,#ff4a5f)] shadow-[0_0_30px_6px_rgba(255,74,95,0.5)]" : "border-white/15 bg-[var(--n-deep)]"}`}>
          <span className={`h-2 w-2 rounded-full transition-colors duration-700 ${lit ? "bg-white" : "bg-white/30"}`} />
        </span>
      </div>
      <motion.article
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.8, ease: EASE }}
        className={`n-panel rounded-[26px] p-6 sm:p-8 md:row-start-1 ${right ? "md:col-start-3 md:ml-6" : "md:col-start-1 md:mr-6"}`}
      >
        <div className="mb-5 flex items-center justify-between">
          <span className="n-mono text-sm tracking-widest text-[var(--n-crimson)]">{s.k}</span>
          <s.icon className="h-5 w-5 text-[var(--n-dim)]" aria-hidden="true" />
        </div>
        <h3 className="n-display text-3xl sm:text-4xl">{s.title}</h3>
        <p className="mt-3 leading-relaxed text-[var(--n-dim)]">{s.body}</p>
        <p className="n-mono mt-6 inline-block rounded-full border border-white/10 px-3 py-1 text-xs text-[var(--n-faint)]">{s.tag}</p>
      </motion.article>
    </li>
  );
}

export function HowItRuns() {
  const ref = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 70%", "end 60%"] });
  const fill = useSpring(scrollYProgress, { stiffness: 90, damping: 24 });
  return (
    <section id="how" className="px-5 py-28 sm:py-36">
      <div className="mx-auto max-w-6xl">
        <Heading kicker="How it runs" title={<>Set it once. <em className="n-moonlit">Sleep.</em></>} body="Four steps from an idea to a position that looks after itself." center />
        <div ref={ref} className="relative mt-20">
          <div className="absolute bottom-0 left-[19px] top-0 w-px bg-white/10 md:left-1/2 md:-translate-x-1/2" aria-hidden="true">
            <motion.div style={{ scaleY: fill }} className="h-full w-full origin-top bg-gradient-to-b from-[#f0c27b] via-[#ff4a5f] to-[#b3122e] shadow-[0_0_12px_2px_rgba(255,74,95,0.55)]" />
          </div>
          <ol className="relative flex flex-col gap-10 md:gap-4">
            {STEPS.map((s, i) => (
              <Step key={s.k} s={s} i={i} />
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- proof: tested numbers and live contracts

function Count({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const seen = useInView(ref, { once: true, amount: 0.8 });
  const calm = useReducedMotion();
  const [v, setV] = useState(calm ? to : 0);
  useEffect(() => {
    if (!seen || calm) return;
    const c = animate(0, to, { duration: 1.6, ease: EASE, onUpdate: (x) => setV(x) });
    return () => c.stop();
  }, [seen, to, calm]);
  return (
    <span ref={ref}>
      {Math.round(v).toLocaleString("en-US")}
      {suffix}
    </span>
  );
}

const PROOF = [
  { n: 79682, label: "rule shapes the editor and the contract agree on", foot: "0 mismatches" },
  { n: 4000, label: "orders replayed by the backtest engine and the contract", foot: "identical runs" },
  { n: 130, label: "contract tests, stress and fuzz included", foot: "all passing" },
];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Proof() {
  const contracts = [
    { name: "RuleHook", addr: CORE.ruleHook },
    { name: "ConditionalOrders", addr: CORE.conditionalOrders },
  ];
  return (
    <section className="px-5 py-28 sm:py-36">
      <div className="mx-auto max-w-6xl">
        <Heading kicker="Checked, not claimed" title={<>Every rule runs <em className="n-moonlit">the way it reads.</em></>} body="The editor, the backtest engine and the contract are tested against each other, case by case." />
        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {PROOF.map((p, i) => (
            <motion.div key={p.label} initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.5 }} transition={{ duration: 0.8, delay: i * 0.1, ease: EASE }} className="n-panel rounded-[26px] p-7">
              <div className="n-display text-[clamp(2.8rem,5vw,4rem)] leading-none">
                <Count to={p.n} />
              </div>
              <p className="mt-4 text-[var(--n-dim)]">{p.label}</p>
              <p className="n-mono mt-5 text-xs uppercase tracking-[0.2em] text-[var(--n-sea)]">{p.foot}</p>
            </motion.div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-[22px] border border-[var(--n-line)] px-6 py-4 text-sm">
          <span className="text-[var(--n-faint)]">Live on Ethereum Sepolia</span>
          {contracts.map((c) => (
            <a key={c.name} href={`https://sepolia.etherscan.io/address/${c.addr}`} target="_blank" rel="noreferrer" className="group flex items-center gap-2 text-[var(--n-dim)] hover:text-white">
              {c.name} <span className="n-mono text-[var(--n-faint)] group-hover:text-[var(--n-crimson)]">{short(c.addr)}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- close

export function FinalCall() {
  return (
    <section className="relative px-5 pb-16 pt-28 text-center sm:pt-40">
      <motion.h2 initial={{ opacity: 0, y: 30, filter: "blur(10px)" }} whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }} viewport={{ once: true, amount: 0.6 }} transition={{ duration: 1.1, ease: EASE }} className="n-display mx-auto max-w-4xl text-[clamp(2.8rem,8vw,6.6rem)] leading-[0.95]">
        Give your position <em className="n-moonlit">a night watch.</em>
      </motion.h2>
      <p className="mx-auto mt-6 max-w-md text-lg text-[var(--n-dim)]">Free test tokens are one click away. Set a rule, backtest it, watch it run.</p>
      <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link href="/pool/new" className="n-btn n-btn-primary w-full sm:w-auto">
          Set your first rule <ArrowRight className="h-4 w-4" />
        </Link>
        <Link href="/docs" className="n-btn n-btn-ghost w-full sm:w-auto">
          Read how it works
        </Link>
      </div>
      <footer className="mx-auto mt-32 flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-[var(--n-line)] pt-6 text-[13px] text-[var(--n-faint)]">
        <span className="n-display text-lg text-[var(--n-moon)]">Alucard</span>
        <span>A Uniswap v4 hook · built for the Uniswap Hook Incubator</span>
        <span className="flex gap-5">
          <Link href="/swap" className="hover:text-white">App</Link>
          <Link href="/docs" className="hover:text-white">Docs</Link>
          <a href="https://github.com/Ronnieraj37/alucard" target="_blank" rel="noreferrer" className="hover:text-white">GitHub</a>
        </span>
      </footer>
    </section>
  );
}

function Heading({ kicker, title, body, center }: { kicker: string; title: React.ReactNode; body: string; center?: boolean }) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <p className="n-mono text-xs uppercase tracking-[0.3em] text-[var(--n-crimson)]">{kicker}</p>
      <h2 className="n-display mt-5 text-[clamp(2.4rem,6vw,4.6rem)] leading-[1]">{title}</h2>
      <p className={`mt-6 text-lg leading-relaxed text-[var(--n-dim)] ${center ? "mx-auto max-w-lg" : "max-w-xl"}`}>{body}</p>
    </div>
  );
}
