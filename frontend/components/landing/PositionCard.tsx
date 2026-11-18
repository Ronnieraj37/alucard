"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Clock, Shield, TrendingUp, Repeat } from "lucide-react";

// A position as the app shows it, with its rules armed. Illustration: the numbers are an example.
const RULES = [
  { icon: Shield, name: "Trailing stop", when: "Price falls 5% from its high", then: "Withdraw, convert to USDC", state: "Armed", tone: "crimson" },
  { icon: TrendingUp, name: "Take profit", when: "Price rises above 2,195", then: "Withdraw everything", state: "Armed", tone: "gold" },
  { icon: Repeat, name: "Compound", when: "Every 24 hours", then: "Add the fees back in", state: "Next in 6h 12m", tone: "sea" },
];

const TONE: Record<string, string> = { crimson: "var(--n-crimson)", gold: "var(--n-gold)", sea: "var(--n-sea)" };

export default function PositionCard() {
  const calm = useReducedMotion();
  return (
    <div className="n-panel overflow-hidden rounded-[28px] text-left shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-3 border-b border-[var(--n-line)] px-6 py-4">
        <span className="flex -space-x-1.5">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[#627eea] text-[11px] font-bold text-white ring-2 ring-[var(--n-deep)]">Ξ</span>
          <span className="grid h-7 w-7 place-items-center rounded-full bg-[#2775ca] text-[11px] font-bold text-white ring-2 ring-[var(--n-deep)]">$</span>
        </span>
        <span className="font-semibold">WETH / USDC</span>
        <span className="rounded-full border border-[var(--n-line2)] px-2 py-0.5 text-[11px] text-[var(--n-dim)]">0.3%</span>
        <span className="ml-auto flex items-center gap-2 text-[12px] text-[var(--n-sea)]">
          <span className="n-pulse h-1.5 w-1.5 rounded-full bg-[var(--n-sea)]" /> In range
        </span>
      </div>

      <div className="grid gap-0 md:grid-cols-[1.05fr_1fr]">
        <div className="border-b border-[var(--n-line)] p-6 md:border-b-0 md:border-r">
          <div className="text-[12px] uppercase tracking-[0.18em] text-[var(--n-faint)]">Position value</div>
          <div className="n-display mt-1 text-[44px] leading-none">$10,000</div>
          <div className="mt-2 text-[13px] text-[var(--n-dim)]">Fees earned $0 · opened today</div>

          <div className="mt-8">
            <div className="mb-2 flex justify-between text-[12px] text-[var(--n-faint)]">
              <span>1,982</span>
              <span>Your range</span>
              <span>2,195</span>
            </div>
            <div className="relative h-14 rounded-xl border border-[var(--n-line)] bg-[rgba(255,255,255,0.02)]">
              <div className="absolute inset-y-2 left-[12%] right-[12%] rounded-lg bg-[rgba(240,194,123,0.14)] ring-1 ring-[rgba(240,194,123,0.35)]" />
              <div className="absolute inset-y-0 left-[22%] w-px border-l border-dashed border-[var(--n-crimson)]" />
              <span className="absolute -bottom-5 left-[22%] -translate-x-1/2 text-[11px] text-[var(--n-crimson)]">stop</span>
              <motion.div
                className="absolute inset-y-1 w-[3px] rounded-full bg-[var(--n-moon)] shadow-[0_0_14px_3px_rgba(239,233,220,0.55)]"
                initial={{ left: "52%" }}
                animate={calm ? undefined : { left: ["52%", "61%", "47%", "57%", "52%"] }}
                transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          </div>
        </div>

        <ul className="divide-y divide-[var(--n-line)]">
          {RULES.map((r, i) => (
            <motion.li
              key={r.name}
              initial={{ opacity: 0, x: 18 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.7, delay: 0.15 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-start gap-4 px-6 py-5"
            >
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[var(--n-line)]" style={{ color: TONE[r.tone] }}>
                <r.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{r.name}</span>
                <span className="block text-[13px] text-[var(--n-dim)]">
                  {r.when} <span className="text-[var(--n-faint)]">→</span> {r.then}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[12px]" style={{ color: TONE[r.tone] }}>
                {r.state.startsWith("Next") ? <Clock className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full" style={{ background: TONE[r.tone] }} />}
                {r.state}
              </span>
            </motion.li>
          ))}
        </ul>
      </div>
    </div>
  );
}
