"use client";

import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";
import story from "@/lib/story.json";

// A real backtest, scrubbed by scroll: our WETH/USDC pool on Sepolia, priced from every Chainlink round, with a 5%
// trailing stop. The numbers come from lib/story.json (frontend/api engine output), nothing here is made up.

const W = 1000;
const H = 330;
const PAD = 24;

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function Story() {
  const calm = useReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const smooth = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  const draw = useTransform(smooth, [0.04, 0.86], [0, 1]);

  const n = story.price.length;
  const geo = useMemo(() => {
    const lo = Math.min(...story.price) * 0.97;
    const hi = Math.max(...story.price) * 1.02;
    const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);
    const y = (p: number) => PAD + (1 - (p - lo) / (hi - lo)) * (H - 2 * PAD);
    const d = story.price.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join("");
    const exitT = story.events[0]?.t ?? Infinity;
    const exitI = story.t.findIndex((t) => t >= exitT);
    // the stop: 5% below the highest price so far, until the rule runs
    const stop: number[] = [];
    let best = 0;
    for (let i = 0; i < n; i++) {
      best = Math.max(best, story.price[i]);
      stop.push(best * 0.95);
    }
    const stopD = stop
      .slice(0, exitI + 1)
      .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`)
      .join("");
    return { x, y, d, stopD, exitI, lo, hi, rangeLo: y(story.range.lo), rangeHi: y(story.range.hi) };
  }, [n]);

  const stopDraw = useTransform(draw, [0, geo.exitI / (n - 1)], [0, 1]);
  const [i, setI] = useState(0);
  useMotionValueEvent(draw, "change", (v) => setI(Math.max(0, Math.min(n - 1, Math.round(v * (n - 1))))));
  const shown = calm ? n - 1 : i;
  const fired = shown >= geo.exitI;
  // open, watching, the rule runs, staying looks smarter for a while (when it does), the end
  const behind = story.noRules[shown] > story.rules[shown];
  const stage = shown < 6 ? 0 : !fired ? 1 : shown < geo.exitI + 14 ? 2 : shown >= n - 10 ? 4 : behind ? 3 : 2;

  const CAPTIONS = [
    { k: day(story.start), h: "You open a ±5% range on WETH/USDC.", b: `ETH is at ${usd(story.entryPrice)}. You add one rule: if the price falls 5% from its high, withdraw everything and convert it to USDC.` },
    { k: "Watching", h: "The stop follows the high.", b: "Every time ETH makes a new high, the line that triggers your rule moves up with it. Nothing to watch, nothing to sign." },
    { k: day(story.events[0]?.t ?? story.start), h: "ETH falls 5%. A keeper runs your rule.", b: `Withdrawn and converted to USDC at about ${usd(story.events[0]?.price ?? 0)}, on-chain, inside Uniswap. The keeper is paid for its gas from the position, capped by you.` },
    { k: "The honest part", h: "Then ETH climbs back.", b: "For weeks, keeping the position would have looked smarter: that line is ahead of yours. A rule trades upside for protection, and the backtest shows you both before you choose." },
    { k: day(story.end), h: "Weeks later, ETH is far lower.", b: `Your position ended at ${usd(story.final.rules)}. The same position without the rule: ${usd(story.final.noRules)}. Holding the two tokens: ${usd(story.final.hold)}.` },
  ];
  const cap = CAPTIONS[calm ? 4 : stage];

  return (
    <section id="story" ref={ref} className="relative" style={{ height: calm ? "auto" : "420vh" }}>
      <div className={`${calm ? "" : "sticky top-0"} flex min-h-screen flex-col justify-center px-5 pb-8 pt-24`}>
        <div className="mx-auto w-full max-w-6xl">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="n-mono text-xs uppercase tracking-[0.3em] text-[var(--n-crimson)]">A real night watch</p>
              <h2 className="n-display mt-3 text-[clamp(2.1rem,4.6vw,3.8rem)] leading-[1]">
                Ninety days of ETH, <em className="n-moonlit">one rule.</em>
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              <Value label="With the rule" value={story.rules[shown]} tone="var(--n-moon)" strong />
              <Value label="Without it" value={story.noRules[shown]} tone="var(--n-faint)" />
            </div>
          </div>

          <div className="n-panel relative overflow-hidden rounded-[28px] !bg-[rgba(9,10,24,0.9)] p-3 sm:p-5">
            <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="ETH price over 90 days with a trailing stop that exits to USDC">
              <rect x={PAD} width={W - 2 * PAD} y={geo.rangeHi} height={geo.rangeLo - geo.rangeHi} fill="rgba(240,194,123,0.08)" stroke="rgba(240,194,123,0.35)" strokeDasharray="4 6" />
              <text x={W - PAD - 8} y={geo.rangeLo + 18} textAnchor="end" fill="var(--n-gold)" fontSize="13" opacity="0.8" className="max-sm:hidden">
                your range
              </text>
              {[0.25, 0.5, 0.75].map((f) => (
                <line key={f} x1={PAD} x2={W - PAD} y1={PAD + f * (H - 2 * PAD)} y2={PAD + f * (H - 2 * PAD)} stroke="rgba(232,228,218,0.06)" />
              ))}
              <motion.path d={geo.stopD} fill="none" stroke="var(--n-crimson)" strokeWidth="1.5" strokeDasharray="5 6" style={{ pathLength: calm ? 1 : stopDraw }} opacity="0.85" />
              <motion.path d={geo.d} fill="none" stroke="var(--n-moon)" strokeWidth="2.4" strokeLinejoin="round" style={{ pathLength: calm ? 1 : draw }} />
              {fired && (
                <g>
                  <motion.circle
                    cx={geo.x(geo.exitI)}
                    cy={geo.y(story.price[geo.exitI])}
                    initial={{ r: 0, opacity: 0.9 }}
                    animate={{ r: 46, opacity: 0 }}
                    transition={{ duration: 1.4, repeat: calm ? 0 : Infinity, ease: "easeOut" }}
                    fill="none"
                    stroke="var(--n-crimson)"
                    strokeWidth="2"
                  />
                  <circle cx={geo.x(geo.exitI)} cy={geo.y(story.price[geo.exitI])} r="7" fill="var(--n-crimson)" />
                  <text x={geo.x(geo.exitI) + 14} y={geo.y(story.price[geo.exitI]) + 30} fill="var(--n-crimson)" fontSize="14" fontWeight="600" className="max-sm:hidden">
                    rule ran · exited to USDC
                  </text>
                </g>
              )}
              <circle cx={geo.x(shown)} cy={geo.y(story.price[shown])} r="5" fill="var(--n-moon)" style={{ filter: "drop-shadow(0 0 8px rgba(239,233,220,.8))" }} />
              <text x={W - PAD} y={H - 8} textAnchor="end" fill="var(--n-faint)" fontSize="13" className="max-sm:hidden">
                ETH {usd(story.price[shown])} · {day(story.t[shown])}
              </text>
            </svg>
            <p className="mt-2 px-2 text-right text-[12px] text-[var(--n-faint)] sm:hidden">
              ETH {usd(story.price[shown])} · {day(story.t[shown])}
              {fired && <span className="ml-2 text-[var(--n-crimson)]">· rule ran, exited to USDC</span>}
            </p>
          </div>

          <div className="mt-6 grid min-h-[150px] items-start gap-6 md:grid-cols-[1fr_auto]">
            <AnimatePresence mode="wait">
              <motion.div
                key={calm ? 4 : stage}
                initial={{ opacity: 0, y: 14, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -10, filter: "blur(6px)" }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="max-w-2xl"
              >
                <p className="n-mono text-xs uppercase tracking-[0.25em] text-[var(--n-faint)]">{cap.k}</p>
                <h3 className="n-display mt-2 text-3xl">{cap.h}</h3>
                <p className="mt-3 text-[16px] leading-relaxed text-[var(--n-dim)]">{cap.b}</p>
              </motion.div>
            </AnimatePresence>
            <ol className="flex gap-2 md:pt-8" aria-hidden="true">
              {CAPTIONS.map((_, k) => (
                <li key={k} className={`h-1.5 w-8 rounded-full transition-colors duration-500 ${k <= (calm ? 4 : stage) ? "bg-[var(--n-crimson)]" : "bg-white/12"}`} />
              ))}
            </ol>
          </div>
          <p className="mt-3 text-[12px] text-[var(--n-faint)]">
            Real data: {story.pool}, {day(story.start)} to {day(story.end)}, $10,000, keeper delay and pay included. Rules do not always win: backtest
            yours on the pool you use.
          </p>
        </div>
      </div>
    </section>
  );
}

function Value({ label, value, tone, strong }: { label: string; value: number; tone: string; strong?: boolean }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${strong ? "border-[var(--n-line2)] bg-[rgba(255,255,255,0.04)]" : "border-[var(--n-line)]"}`}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--n-faint)]">{label}</div>
      <div className="n-display mt-1 text-[28px] leading-none sm:text-[34px]" style={{ color: tone }}>
        {usd(value)}
      </div>
    </div>
  );
}
