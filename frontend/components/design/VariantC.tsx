"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Plus, X } from "lucide-react";
import { RULE_SHAPES } from "./options";

// C · Building blocks. A rule is a stack: when blocks (joined with and / or), then blocks in order, and limits.
// Blocks swap on their own to show the range; the palette adds any block, the × removes it.

type Kind = "when" | "then" | "limit";
type Block = { id: string; kind: Kind; text: string };

const PALETTE: Record<Kind, string[]> = {
  when: ["Price falls 5% from its high", "Price leaves the range", "Price reaches $2,400", "Chainlink price below $1,950", "Another pool's price passes a level", "Every 24 hours", "Holds for 30 minutes"],
  then: ["Withdraw everything", "Withdraw 25%", "Collect the fees", "Convert to USDC", "Re-add in the same range", "Move the range next to the price"],
  limit: ["Run once", "Repeat every 5% step", "At most 4 runs", "Keeper fee ≤ 0.1%", "Slippage ≤ 1%", "Expires in 30 days"],
};
const TONE: Record<Kind, { label: string; color: string; tint: string }> = {
  when: { label: "When", color: "#1f5fd6", tint: "#e8effc" },
  then: { label: "Then", color: "#167a4a", tint: "#e5f3ec" },
  limit: { label: "Limits", color: "#7d1426", tint: "#f6e6e9" },
};

let uid = 0;
const mk = (kind: Kind, text: string): Block => ({ id: `${kind}-${uid++}`, kind, text });
const START: Block[] = [mk("when", PALETTE.when[0]), mk("when", PALETTE.when[3]), mk("then", PALETTE.then[0]), mk("then", PALETTE.then[3]), mk("limit", PALETTE.limit[0]), mk("limit", PALETTE.limit[3])];

export default function VariantC() {
  const calm = useReducedMotion();
  const [blocks, setBlocks] = useState<Block[]>(START);
  const [join, setJoin] = useState<"and" | "or">("and");
  const [touched, setTouched] = useState(false);

  // until you touch it, one block swaps every few seconds
  useEffect(() => {
    if (calm || touched) return;
    let k = 0;
    const id = setInterval(() => {
      setBlocks((bs) => {
        const i = [0, 2, 1, 4, 3][k++ % 5] % bs.length;
        const b = bs[i];
        const list = PALETTE[b.kind];
        const next = list[(list.indexOf(b.text) + 1) % list.length];
        return bs.map((x, j) => (j === i ? mk(b.kind, next) : x));
      });
      if (k % 3 === 0) setJoin((j) => (j === "and" ? "or" : "and"));
    }, 2200);
    return () => clearInterval(id);
  }, [calm, touched]);

  const add = (kind: Kind, text: string) => {
    setTouched(true);
    setBlocks((bs) => {
      if (bs.filter((b) => b.kind === kind).length >= (kind === "when" ? 2 : 4)) return bs;
      const last = bs.map((b) => b.kind).lastIndexOf(kind);
      const at = last >= 0 ? last + 1 : kind === "when" ? 0 : kind === "then" ? bs.filter((b) => b.kind === "when").length : bs.length;
      return [...bs.slice(0, at), mk(kind, text), ...bs.slice(at)];
    });
  };
  const remove = (id: string) => {
    setTouched(true);
    setBlocks((bs) => bs.filter((b) => b.id !== id));
  };

  const group = (kind: Kind) => blocks.filter((b) => b.kind === kind);

  return (
    <section className="mx-auto max-w-6xl px-5 pb-24 pt-28 lg:pt-32">
      <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="t-kicker">Rules for Uniswap v4 positions</p>
          <h1 className="t-display mt-5 text-[clamp(2.6rem,5vw,4.4rem)] leading-[1.02]">Build the exit your position needs. Block by block.</h1>
          <p className="mt-6 max-w-md text-[17px] leading-relaxed text-[#4a4c55]">
            Not a menu of four automations. Join any conditions, chain any actions, set your limits. The contract runs exactly what you built, around the clock, and your money stays in Uniswap.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/pool/new" className="t-btn t-btn-dark">
              Start building <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/docs" className="t-btn t-btn-light">How it runs</Link>
          </div>
          <p className="mt-8 text-[15px] text-[#5b5e68]">
            <b className="text-[#17181c]">{RULE_SHAPES.toLocaleString("en-US")}</b> rule shapes, every one tested against the contract.
          </p>
        </div>

        <div className="rounded-[28px] bg-white p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_30px_80px_-40px_rgba(0,0,0,0.35)] sm:p-7">
          <div className="mb-5 flex items-center justify-between rounded-2xl bg-[#eef0f2] px-4 py-3 text-[14px]">
            <span className="font-semibold">WETH / USDC · 0.3%</span>
            <span className="text-[#5b5e68]">Range 1,982 – 2,195 · $10,000</span>
          </div>
          <LayoutGroup>
            {(["when", "then", "limit"] as Kind[]).map((kind) => (
              <motion.div layout key={kind} className="mb-4">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: TONE[kind].color }}>
                  {TONE[kind].label}
                </div>
                <div className="flex flex-col gap-2">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {group(kind).map((b, i) => (
                      <motion.div key={b.id} layout initial={{ opacity: 0, x: 30, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -30, scale: 0.96 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}>
                        {kind === "when" && i === 1 && (
                          <button onClick={() => { setTouched(true); setJoin(join === "and" ? "or" : "and"); }} className="mb-2 ml-5 rounded-full border border-black/10 bg-white px-3 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-[#5b5e68] hover:border-black/30">
                            {join}
                          </button>
                        )}
                        <div className="group flex items-center gap-3 rounded-xl border border-black/[0.07] px-4 py-3" style={{ background: TONE[kind].tint }}>
                          <span className="text-[15px] font-medium text-[#17181c]">{b.text}</span>
                          <button onClick={() => remove(b.id)} aria-label="Remove" className="ml-auto rounded-md p-1 text-[#8a8d97] opacity-0 transition-opacity hover:bg-black/5 group-hover:opacity-100">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </motion.div>
            ))}
          </LayoutGroup>

          <div className="mt-6 border-t border-black/5 pt-5">
            <div className="text-[12px] font-semibold text-[#8a8d97]">Add a block</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["when", "then", "limit"] as Kind[]).flatMap((kind) =>
                PALETTE[kind].slice(0, kind === "limit" ? 3 : 4).map((t) => (
                  <button key={kind + t} onClick={() => add(kind, t)} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[13px] transition-colors hover:bg-black/[0.03]" style={{ borderColor: `${TONE[kind].color}40`, color: TONE[kind].color }}>
                    <Plus className="h-3.5 w-3.5" /> {t}
                  </button>
                )),
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
