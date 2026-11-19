"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, ChevronDown } from "lucide-react";
import { JOIN, LIMITS, MENU, REPEAT, RULE_SHAPES, THEN, THEN2, WHEN, WHEN2 } from "./options";

// A · Write your rule. The rule is a sentence; every underlined part is a choice. The parts change on their own to
// show how many rules there are, and any part can be clicked and picked.

const SLOTS: { id: string; options: string[]; tone: string }[] = [
  { id: "when", options: WHEN, tone: "#1f5fd6" },
  { id: "join", options: JOIN, tone: "#5b5e68" },
  { id: "when2", options: WHEN2, tone: "#1f5fd6" },
  { id: "then", options: THEN, tone: "#167a4a" },
  { id: "then2", options: THEN2, tone: "#167a4a" },
  { id: "repeat", options: REPEAT, tone: "#7d1426" },
];

function Chip({ slot, value, onPick }: { slot: (typeof SLOTS)[number]; value: number; onPick: (i: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block align-baseline">
      <button
        onClick={() => setOpen(!open)}
        className="group relative inline-flex items-baseline rounded-md px-1 underline decoration-2 underline-offset-[6px] transition-colors hover:bg-black/[0.04]"
        style={{ color: slot.tone, textDecorationColor: `${slot.tone}55` }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={value} initial={{ y: 14, opacity: 0, filter: "blur(4px)" }} animate={{ y: 0, opacity: 1, filter: "blur(0px)" }} exit={{ y: -14, opacity: 0, filter: "blur(4px)" }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
            {slot.options[value]}
          </motion.span>
        </AnimatePresence>
        <ChevronDown className="pointer-events-none absolute -right-4 top-1/2 h-4 w-4 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
      {open && (
        <span className="absolute left-0 top-full z-20 mt-2 w-72 rounded-xl bg-white p-1.5 text-[15px] shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_16px_40px_-12px_rgba(0,0,0,0.3)]" style={{ fontFamily: "var(--font-geist)" }}>
          {slot.options.map((o, i) => (
            <button key={o} onClick={() => { onPick(i); setOpen(false); }} className={`block w-full rounded-lg px-3 py-2 text-left hover:bg-black/[0.04] ${i === value ? "font-semibold" : ""}`} style={{ color: i === value ? slot.tone : "#2b2d33" }}>
              {o}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export default function VariantA() {
  const calm = useReducedMotion();
  const [vals, setVals] = useState<number[]>(SLOTS.map(() => 0));
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (calm || paused) return;
    let k = 0;
    const id = setInterval(() => {
      const order = [0, 3, 1, 5, 2, 4];
      const s = order[k++ % order.length];
      setVals((v) => v.map((x, i) => (i === s ? (x + 1) % SLOTS[i].options.length : x)));
    }, 1700);
    return () => clearInterval(id);
  }, [calm, paused]);
  const pick = (s: number) => (i: number) => {
    setPaused(true);
    setVals((v) => v.map((x, j) => (j === s ? i : x)));
  };
  const c = (i: number) => <Chip slot={SLOTS[i]} value={vals[i]} onPick={pick(i)} />;

  return (
    <div>
      <section className="mx-auto max-w-6xl px-5 pb-20 pt-28 lg:pt-32">
        <p className="t-kicker">Rules for Uniswap v4 positions</p>
        <h1 className="t-display mt-5 max-w-3xl text-[clamp(2.6rem,5vw,4.4rem)] leading-[1.02]">Your position. Your rules. Written the way you think them.</h1>

        <div onMouseEnter={() => setPaused(true)} className="relative mt-12 rounded-[28px] bg-white p-7 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_30px_80px_-40px_rgba(0,0,0,0.35)] sm:p-10">
          <div className="mb-6 flex flex-wrap items-center gap-3 text-[13px] text-[#5b5e68]">
            <span className="rounded-full bg-[#eef0f2] px-3 py-1 font-semibold text-[#17181c]">WETH / USDC · 0.3%</span>
            <span>Range 1,982 – 2,195 · $10,000</span>
            <span className="ml-auto">{paused ? "Your rule" : "Changing on its own; hover to stop, click any part"}</span>
          </div>
          <p className="t-display text-[clamp(1.6rem,3.2vw,2.6rem)] leading-[1.45] text-[#17181c]">
            When {c(0)} {c(1)} {c(2)}, then {c(3)} and {c(4)}, {c(5)}.
          </p>
          <div className="mt-8 flex flex-wrap gap-2 border-t border-black/5 pt-6 text-[13px] text-[#5b5e68]">
            {LIMITS.map((l) => (
              <span key={l} className="rounded-full border border-black/10 px-3 py-1">{l}</span>
            ))}
            <span className="rounded-full border border-dashed border-black/20 px-3 py-1">+ add another rule above the range</span>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/pool/new" className="t-btn t-btn-dark">
            Write your first rule <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/docs" className="t-btn t-btn-light">How it runs</Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-28">
        <div className="grid gap-px overflow-hidden rounded-3xl bg-black/10 md:grid-cols-5">
          {Object.entries(MENU).map(([k, items]) => (
            <div key={k} className="bg-[#f6f7f8] p-6">
              <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#7d1426]">{k}</div>
              <ul className="mt-3 space-y-1.5 text-[15px] text-[#2b2d33]">
                {items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-6 max-w-2xl text-[17px] text-[#4a4c55]">
          Mix any of them. That is <b className="text-[#17181c]">{RULE_SHAPES.toLocaleString("en-US")}</b> different rule shapes, and every one is tested against the contract, so the rule you write is the rule that runs.
        </p>
      </section>
    </div>
  );
}
