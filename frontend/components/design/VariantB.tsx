"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight, GripHorizontal } from "lucide-react";
import story from "@/lib/story.json";
import { RULE_SHAPES } from "./options";

// B · Rules on the chart. The real 90 days of our Sepolia WETH/USDC pool (Chainlink prices). Drag the lines; the
// rules read back in plain words and the chart marks where each would have fired on this history.

const W = 900;
const H = 400;
const PAD = 28;
const fmt = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

type LineId = "tp" | "sl";

export default function VariantB() {
  const calm = useReducedMotion();
  const svg = useRef<SVGSVGElement | null>(null);
  const prices = story.price;
  const n = prices.length;
  const lo = Math.min(...prices) * 0.96;
  const hi = Math.max(...prices) * 1.03;
  const y = (p: number) => PAD + (1 - (p - lo) / (hi - lo)) * (H - 2 * PAD);
  const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const pAt = (py: number) => lo + (1 - (py - PAD) / (H - 2 * PAD)) * (hi - lo);

  const [tp, setTp] = useState(Math.round(story.entryPrice * 1.12));
  const [sl, setSl] = useState(Math.round(story.entryPrice * 0.92));
  const [trail, setTrail] = useState(true);
  const [trailPct, setTrailPct] = useState(5);
  const [follow, setFollow] = useState(false);
  const [compound, setCompound] = useState(true);
  const [drag, setDrag] = useState<LineId | null>(null);

  const d = useMemo(() => prices.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(""), []); // eslint-disable-line react-hooks/exhaustive-deps

  // where each rule would have fired on this history (first crossing)
  const stopLine = useMemo(() => {
    let best = 0;
    return prices.map((p) => {
      best = Math.max(best, p);
      return trail ? best * (1 - trailPct / 100) : sl;
    });
  }, [trail, trailPct, sl, prices]);
  const stopHit = prices.findIndex((p, i) => i > 0 && p <= stopLine[i]);
  const tpHit = prices.findIndex((p, i) => i > 0 && p >= tp);
  const first = [stopHit, tpHit].filter((i) => i > 0).sort((a, b) => a - b)[0];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const py = ((e.clientY - r.top) / r.height) * H;
    const p = Math.round(Math.min(hi, Math.max(lo, pAt(py))));
    if (drag === "tp") setTp(Math.max(p, Math.round(story.entryPrice * 1.01)));
    else setSl(Math.min(p, Math.round(story.entryPrice * 0.99)));
  };

  const stopD = stopLine.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join("");

  const rules = [
    trail
      ? { on: true, tone: "#17181c", text: `When WETH falls ${trailPct}% from its high: withdraw everything and convert to USDC.` }
      : { on: true, tone: "#17181c", text: `When WETH falls below ${fmt(sl)}: withdraw everything and convert to USDC.` },
    { on: true, tone: "#1f5fd6", text: `When WETH rises above ${fmt(tp)}: withdraw 50%, then keep watching.` },
    { on: follow, tone: "#167a4a", text: "When the price leaves the range: move the range next to it." },
    { on: compound, tone: "#d0223a", text: "Every 24 hours: put the fees back in." },
  ];

  return (
    <div>
      <section className="mx-auto max-w-6xl px-5 pb-12 pt-28 lg:pt-32">
        <div className="grid items-end gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <h1 className="t-display text-[clamp(2.6rem,5vw,4.4rem)] leading-[1.02]">Draw your exits on your position. It runs them for you.</h1>
          <p className="text-[17px] leading-relaxed text-[#4a4c55]">
            Drag the lines. Switch rules on and off. Every rule on a Uniswap v4 position is yours to shape, and once it is set the contract carries it out, 24/7.
          </p>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="rounded-[24px] bg-white p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_30px_80px_-40px_rgba(0,0,0,0.35)] sm:p-5">
            <div className="mb-2 flex flex-wrap items-center gap-3 px-2 text-[13px] text-[#5b5e68]">
              <span className="font-semibold text-[#17181c]">WETH / USDC · 0.3%</span>
              <span>{day(story.start)} – {day(story.end)} · real Chainlink prices</span>
              {first > 0 && <span className="ml-auto text-[#7d1426]">first rule would have run {day(story.t[first])}</span>}
            </div>
            <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="block w-full touch-none select-none" onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
              <rect x={PAD} width={W - 2 * PAD} y={y(story.range.hi)} height={y(story.range.lo) - y(story.range.hi)} fill="rgba(240,194,123,0.16)" />
              <text x={W - PAD - 6} y={y(story.range.lo) - 6} textAnchor="end" fontSize="12" fill="#a07a3a">your range</text>
              {compound &&
                Array.from({ length: 13 }, (_, k) => (
                  <line key={k} x1={PAD + (k / 12) * (W - 2 * PAD)} x2={PAD + (k / 12) * (W - 2 * PAD)} y1={H - PAD} y2={H - PAD + 7} stroke="#d0223a" strokeWidth="2" />
                ))}
              <path d={d} fill="none" stroke="#17181c" strokeWidth="2" opacity="0.18" />
              <motion.path d={d} fill="none" stroke="#17181c" strokeWidth="2" initial={{ pathLength: calm ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.8, ease: "easeInOut" }} />
              {/* stop: fixed line or trailing curve */}
              <path d={stopD} fill="none" stroke="#17181c" strokeWidth="1.5" strokeDasharray="6 6" opacity="0.7" />
              {!trail && (
                <g onPointerDown={() => setDrag("sl")} className="cursor-ns-resize">
                  <rect x={PAD} width={W - 2 * PAD} y={y(sl) - 10} height="20" fill="transparent" />
                  <rect x={W - PAD - 92} y={y(sl) - 13} width="92" height="26" rx="13" fill="#17181c" />
                  <text x={W - PAD - 46} y={y(sl) + 4} textAnchor="middle" fontSize="12" fill="#fff">stop {fmt(sl)}</text>
                </g>
              )}
              {/* take profit */}
              <g onPointerDown={() => setDrag("tp")} className="cursor-ns-resize">
                <line x1={PAD} x2={W - PAD} y1={y(tp)} y2={y(tp)} stroke="#1f5fd6" strokeWidth="1.5" strokeDasharray="6 6" />
                <rect x={PAD} width={W - 2 * PAD} y={y(tp) - 10} height="20" fill="transparent" />
                <rect x={W - PAD - 118} y={y(tp) - 13} width="118" height="26" rx="13" fill="#1f5fd6" />
                <text x={W - PAD - 59} y={y(tp) + 4} textAnchor="middle" fontSize="12" fill="#fff">take profit {fmt(tp)}</text>
              </g>
              {stopHit > 0 && <circle cx={x(stopHit)} cy={y(prices[stopHit])} r="6" fill="#17181c" stroke="#fff" strokeWidth="2" />}
              {tpHit > 0 && <circle cx={x(tpHit)} cy={y(prices[tpHit])} r="6" fill="#1f5fd6" stroke="#fff" strokeWidth="2" />}
            </svg>
            <div className="flex items-center gap-2 px-2 pt-1 text-[12px] text-[#8a8d97]">
              <GripHorizontal className="h-4 w-4" /> Drag the take-profit line{trail ? "" : " and the stop"}; the dots show where each would have run.
            </div>
          </div>

          <aside className="rounded-[24px] bg-white p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
            <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#7d1426]">Rules on this position</div>
            <div className="mt-4 flex gap-1 rounded-xl bg-[#eef0f2] p-1 text-[13px]">
              <button onClick={() => setTrail(true)} className={`flex-1 rounded-lg py-1.5 ${trail ? "bg-white font-semibold shadow-sm" : "text-[#5b5e68]"}`}>Trailing stop</button>
              <button onClick={() => setTrail(false)} className={`flex-1 rounded-lg py-1.5 ${!trail ? "bg-white font-semibold shadow-sm" : "text-[#5b5e68]"}`}>Fixed stop</button>
            </div>
            {trail && (
              <label className="mt-3 block text-[13px] text-[#5b5e68]">
                Falls {trailPct}% from its high
                <input type="range" min={2} max={15} value={trailPct} onChange={(e) => setTrailPct(Number(e.target.value))} className="mt-1 w-full accent-[#17181c]" />
              </label>
            )}
            <ul className="mt-4 space-y-2">
              {rules.map((r, i) => (
                <li key={i} className={`flex gap-2.5 rounded-xl border px-3 py-2.5 text-[14px] leading-snug transition-opacity ${r.on ? "border-black/10" : "border-dashed border-black/10 opacity-40"}`}>
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: r.tone }} />
                  {r.text}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2 text-[13px]">
              <button onClick={() => setFollow(!follow)} className="rounded-full border border-black/10 px-3 py-1 hover:border-black/30">{follow ? "− re-range" : "+ re-range"}</button>
              <button onClick={() => setCompound(!compound)} className="rounded-full border border-black/10 px-3 py-1 hover:border-black/30">{compound ? "− compound" : "+ compound"}</button>
              <span className="rounded-full border border-dashed border-black/20 px-3 py-1 text-[#8a8d97]">+ Chainlink, timers, and/or…</span>
            </div>
          </aside>
        </div>

        <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Link href="/pool/new" className="t-btn t-btn-dark">
            Set rules on a position <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="text-[15px] text-[#5b5e68]">{RULE_SHAPES.toLocaleString("en-US")} rule shapes, every one tested against the contract.</p>
        </div>
      </section>
    </div>
  );
}
