"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useInView, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";
import { ArrowRight, Minus, Plus } from "lucide-react";
import Movement from "./Movement";
import story from "@/lib/story.json";
import { CORE } from "@/lib/pools";
const rc = (a: number) => Math.round(Math.cos(a) * 1e6) / 1e6;
const rs = (a: number) => Math.round(Math.sin(a) * 1e6) / 1e6;

const EASE = [0.22, 1, 0.36, 1] as const;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// ---------------------------------------------------------------- the dial: a price gauge with set points

const DIAL_START = 210; // degrees, clockwise from 12 o'clock: the gauge runs from 7 o'clock round to 5 o'clock
const DIAL_SWEEP = 300;
const LO = Math.floor((Math.min(...story.price) * 0.97) / 50) * 50;
const HI = Math.ceil((Math.max(...story.price) * 1.03) / 50) * 50;
const angOf = (p: number) => DIAL_START + ((Math.min(HI, Math.max(LO, p)) - LO) / (HI - LO)) * DIAL_SWEEP;
const pt = (a: number, r: number) => {
  const t = ((a - 90) * Math.PI) / 180;
  return [300 + rc(t) * r, 300 + rs(t) * r] as const;
};
const arc = (a0: number, a1: number, r: number) => {
  const [x0, y0] = pt(a0, r);
  const [x1, y1] = pt(a1, r);
  return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1},${y1}`;
};

function Marker({ price, tone, label, inner = false }: { price: number; tone: string; label: string; inner?: boolean }) {
  const a = angOf(price);
  return (
    <motion.g animate={{ rotate: a }} initial={false} transition={{ type: "spring", stiffness: 90, damping: 16 }} style={{ transformBox: "view-box", transformOrigin: "300px 300px" }}>
      <path d={inner ? "M300,96 l-8,-15 h16 Z" : "M300,48 l-9,-16 h18 Z"} fill={tone} />
      <title>{label}</title>
    </motion.g>
  );
}

export function Dial({
  price,
  stop,
  take,
  status,
  runs,
  fees,
  showStop = true,
  showTake = true,
  subdials = true,
}: {
  price: number;
  stop?: number;
  take?: number;
  status: string;
  runs: number;
  fees: number;
  showStop?: boolean;
  showTake?: boolean;
  subdials?: boolean;
}) {
  const ticks = useMemo(() => {
    const out: { a: number; major: boolean; p: number }[] = [];
    for (let p = LO; p <= HI; p += 50) out.push({ a: angOf(p), major: p % 200 === 0, p });
    return out;
  }, []);
  return (
    <svg viewBox="0 0 600 600" className="mv" role="img" aria-label={`Price ${usd(price)}; ${status}`}>
      <circle cx="300" cy="300" r="296" className="mv-case" />
      <circle cx="300" cy="300" r="276" fill="#fbfbfc" stroke="var(--hair)" />
      <path d={arc(DIAL_START, DIAL_START + DIAL_SWEEP, 250)} fill="none" stroke="var(--ink)" strokeWidth="1" />
      {ticks.map((t) => {
        const [x0, y0] = pt(t.a, 250);
        const [x1, y1] = pt(t.a, t.major ? 228 : 240);
        const [tx, ty] = pt(t.a, 210);
        return (
          <g key={t.p}>
            <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--ink)" strokeWidth={t.major ? 2 : 1} />
            {t.major && (
              <text x={tx} y={ty + 5} textAnchor="middle" className="w-measure" fill="var(--ink2)" fontSize="15">
                {t.p.toLocaleString("en-US")}
              </text>
            )}
          </g>
        );
      })}
      {/* your range, in gilt */}
      <path d={arc(angOf(story.range.lo), angOf(story.range.hi), 258)} fill="none" stroke="var(--gilt)" strokeWidth="7" strokeLinecap="round" />
      {showTake && take && <Marker price={take} tone="var(--ink)" label="take profit" />}
      {showStop && stop && <Marker price={stop} tone="var(--ruby)" label="stop" />}

      <text x="300" y="168" textAnchor="middle" className="mv-engrave" style={{ fontSize: 17 }}>ALUCARD</text>
      <text x="300" y="188" textAnchor="middle" className="mv-engrave mv-engrave-sm">WETH / USDC · AUTOMATIC</text>

      {/* subdials */}
      {(subdials ? [
        { x: 205, label: "RUNS", value: String(runs) },
        { x: 395, label: "FEES", value: usd(fees) },
      ] : []).map((s) => (
        <g key={s.label}>
          <circle cx={s.x} cy="330" r="50" fill="none" stroke="var(--hair)" />
          {Array.from({ length: 24 }, (_, k) => {
            const a = (k / 24) * Math.PI * 2;
            return <line key={k} x1={s.x + rc(a) * 44} y1={330 + rs(a) * 44} x2={s.x + rc(a) * 49} y2={330 + rs(a) * 49} stroke="var(--hair)" />;
          })}
          <text x={s.x} y="328" textAnchor="middle" className="w-measure" fill="var(--ink)" fontSize="19">{s.value}</text>
          <text x={s.x} y="350" textAnchor="middle" className="mv-engrave mv-engrave-sm">{s.label}</text>
        </g>
      ))}
      {/* status window */}
      <rect x="236" y="420" width="128" height="34" rx="4" fill="#fff" stroke="var(--ink2)" />
      <text x="300" y="442" textAnchor="middle" className="w-measure" fontSize="14" fill={status.startsWith("RAN") ? "var(--ruby)" : "var(--ink)"}>{status}</text>

      {/* the hand: the price */}
      <motion.g animate={{ rotate: angOf(price) }} initial={false} transition={{ type: "spring", stiffness: 120, damping: 18 }} style={{ transformBox: "view-box", transformOrigin: "300px 300px" }}>
        <path d="M296,318 L298,64 L300,52 L302,64 L304,318 Z" fill="var(--ink)" />
        <circle cx="300" cy="96" r="5" fill="#fbfbfc" stroke="var(--ink)" strokeWidth="1.5" />
      </motion.g>
      <circle cx="300" cy="300" r="11" fill="var(--ink)" />
      <circle cx="300" cy="300" r="4" fill="var(--ruby)" />
    </svg>
  );
}

// ---------------------------------------------------------------- nav

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--hair)] bg-[var(--paper)]/90 backdrop-blur-sm">
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5">
        <Link href="/" className="w-display text-[22px] tracking-[-0.02em]">Alucard</Link>
        <div className="hidden gap-7 text-[15px] text-[var(--ink2)] md:flex">
          <a href="#replay" className="hover:text-[var(--ink)]">See it run</a>
          <a href="#configure" className="hover:text-[var(--ink)]">Make a rule</a>
          <a href="#sealed" className="hover:text-[var(--ink)]">Safety</a>
          <Link href="/docs" className="hover:text-[var(--ink)]">Docs</Link>
        </div>
        <Link href="/swap" className="w-btn w-btn-ink ml-auto !h-10 !px-4 !text-[14px]">
          Open the app <ArrowRight className="h-4 w-4" />
        </Link>
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------- hero

function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-12 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[1fr_560px] lg:py-10">
      <div className="max-lg:order-2">
        <h1 className="w-display text-[clamp(3rem,6.2vw,5.6rem)]">Wind it once. It keeps working.</h1>
        <p className="mt-7 max-w-[34rem] text-[19px] leading-relaxed text-[var(--ink2)]">
          Alucard puts your own rules inside a Uniswap v4 position: when to exit, when to move the range, when to convert, when to compound. Set them once.
          From then on they run on-chain, day and night, and your money never leaves Uniswap.
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link href="/swap" className="w-btn w-btn-ink">
            Open the app <ArrowRight className="h-4 w-4" />
          </Link>
          <a href="#replay" className="w-btn w-btn-line">Watch a rule run</a>
        </div>
      </div>
      <motion.div initial={{ opacity: 0, scale: 0.96, rotate: -6 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={{ duration: 1.4, ease: EASE }} className="mx-auto w-full max-w-[300px] sm:max-w-[420px] lg:max-w-[560px] max-lg:order-1">
        <Movement />
      </motion.div>
    </section>
  );
}

// ---------------------------------------------------------------- replay: the watch turns over, the dial runs the real history

function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 1024px)");
    const f = () => setWide(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return wide;
}

function Replay() {
  const prefersCalm = useReducedMotion();
  const wide = useWide();
  // the server renders the pinned version; the browser switches after mounting, so both first renders match
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const reduced = mounted && !!prefersCalm;
  // pinned and scroll-driven on wide screens; on phones it plays by itself while in view
  const calm = reduced || (mounted && !wide);
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useInView(ref, { amount: 0.4 });
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const p = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
  const turn = useTransform(p, [0, 0.18], [180, 0]);
  const n = story.price.length;
  const [i, setI] = useState(0);
  const [manual, setManual] = useState(false);
  useMotionValueEvent(p, "change", (v) => {
    if (manual) return;
    setI(Math.max(0, Math.min(n - 1, Math.round(((v - 0.2) / 0.75) * (n - 1)))));
  });
  useEffect(() => {
    if (wide || reduced || manual || !seen) return;
    const id = setInterval(() => setI((x) => (x >= n - 1 ? n - 1 : x + 2)), 60);
    return () => clearInterval(id);
  }, [wide, reduced, manual, seen, n]);
  const k = reduced ? n - 1 : i;
  const exitI = useMemo(() => story.t.findIndex((t) => t >= (story.events[0]?.t ?? Infinity)), []);
  const high = useMemo(() => {
    let best = 0;
    return story.price.map((v) => (best = Math.max(best, v)));
  }, []);
  const ran = k >= exitI;
  const stop = ran ? story.events[0].price : high[k] * 0.95;

  return (
    <section id="replay" ref={ref} className="relative" style={{ height: calm ? "auto" : "320vh" }}>
      <div className={`${calm ? "" : "sticky top-16"} mx-auto grid max-w-6xl items-center gap-12 px-5 py-12 lg:min-h-[calc(100svh-4rem)] lg:grid-cols-[520px_1fr]`}>
        <div className="mx-auto w-full max-w-[520px] [perspective:1800px]">
          <motion.div style={calm ? undefined : { rotateY: turn }} className="relative max-lg:mx-auto max-lg:max-w-[340px] [transform-style:preserve-3d]">
            <div className="[backface-visibility:hidden]">
              <Dial price={story.price[k]} stop={stop} take={undefined} showTake={false} status={ran ? `RAN · ${day(story.events[0].t)}` : "ARMED"} runs={ran ? 1 : 0} fees={0} />
            </div>
            <div className="absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]">
              <Movement />
            </div>
          </motion.div>
        </div>
        <div>
          <h2 className="w-display text-[clamp(2.4rem,4.4vw,3.8rem)]">Ninety days, one rule, no one watching.</h2>
          <p className="mt-6 max-w-lg text-[18px] text-[var(--ink2)]">
            One rule on our live WETH/USDC pool: if WETH falls 5% from its highest price, withdraw everything and convert it to USDC. The ruby mark follows the
            high; the hand is the real Chainlink price, {day(story.start)} to {day(story.end)}.
          </p>
          <div className="mt-9">
            <input
              type="range"
              min={0}
              max={n - 1}
              value={k}
              onChange={(e) => {
                setManual(true);
                setI(Number(e.target.value));
              }}
              aria-label="Move through the 90 days"
              className="w-range w-full"
            />
            <div className="mt-2 flex justify-between text-[13px] text-[var(--ink3)]">
              <span>{day(story.t[k])}</span>
              <span>WETH {usd(story.price[k])}</span>
            </div>
          </div>
          <dl className="mt-8 grid grid-cols-3 border-y border-[var(--hair)]">
            {[
              ["With the rule", story.rules[k], true],
              ["Without it", story.noRules[k], false],
              ["Just holding", story.hold[k], false],
            ].map(([label, v, strong]) => (
              <div key={label as string} className="border-r border-[var(--hair)] py-4 pr-4 last:border-r-0 [&:not(:first-child)]:pl-4">
                <dt className="text-[13px] text-[var(--ink3)]">{label as string}</dt>
                <dd className={`w-display mt-1 text-[clamp(1.5rem,2.6vw,2.1rem)] ${strong ? "text-[var(--ink)]" : "text-[var(--ink3)]"}`}>{usd(v as number)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 max-w-lg text-[14px] text-[var(--ink3)]">
            {ran
              ? k >= n - 10
                ? `The rule ran on ${day(story.events[0].t)}. ETH climbed for weeks afterwards, when staying in looked better, then fell to ${usd(story.endPrice)}. A rule trades upside for protection; the backtest shows you both before you choose.`
                : `The rule ran on ${day(story.events[0].t)}: withdrawn and converted to USDC, on-chain. Keep scrolling: ETH did not go straight down.`
              : "Armed. Nothing to watch, nothing to sign."}
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- configure: choose the complications, turn the crown

type When = "trail" | "below" | "above" | "leave" | "oracle" | "timer";
type Then = "withdraw" | "convert" | "readd" | "follow" | "collect";
const WHEN: { id: When; label: string; unit: string; min: number; max: number; step: number; def: number; field: string }[] = [
  { id: "trail", label: "Falls a set % from its high", unit: "%", min: 1, max: 20, step: 1, def: 5, field: "checker TRAIL" },
  { id: "below", label: "Falls below a price", unit: "$", min: 1500, max: 2400, step: 25, def: 2150, field: "checker TICK (lower side)" },
  { id: "above", label: "Rises above a price", unit: "$", min: 2300, max: 3200, step: 25, def: 2600, field: "checker TICK (upper side)" },
  { id: "leave", label: "Leaves your range by", unit: "%", min: 0, max: 10, step: 1, def: 1, field: "checker EDGE" },
  { id: "oracle", label: "Chainlink price below", unit: "$", min: 1500, max: 2400, step: 25, def: 2100, field: "checker ORACLE" },
  { id: "timer", label: "Every few hours", unit: "h", min: 1, max: 168, step: 1, def: 24, field: "checker TIME" },
];
const THEN: { id: Then; label: string; says: string; field: string }[] = [
  { id: "withdraw", label: "Withdraw everything", says: "withdraw everything", field: "REMOVE · removeBps 10000" },
  { id: "convert", label: "Withdraw and convert to USDC", says: "withdraw everything and convert it to USDC", field: "REMOVE | SWAP" },
  { id: "readd", label: "Collect fees and put them back", says: "collect the fees and put them back in", field: "REMOVE fees | ADD (same range)" },
  { id: "follow", label: "Move the range next to the price", says: "move the range next to the price", field: "REMOVE | ADD (follow)" },
  { id: "collect", label: "Collect the fees only", says: "collect the fees", field: "REMOVE · removeBps 0" },
];

function Crown({ value, set, min, max, step, unit }: { value: number; set: (v: number) => void; min: number; max: number; step: number; unit: string }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const drag = useRef<{ y: number; v: number } | null>(null);
  const fmt = unit === "$" ? usd(value) : `${value}${unit === "%" ? "%" : " h"}`;
  return (
    <div className="flex items-center gap-3">
      <button aria-label="Less" onClick={() => set(clamp(value - step))} className="grid h-10 w-10 place-items-center rounded-full shadow-[inset_0_0_0_1px_var(--hair)] hover:shadow-[inset_0_0_0_1px_var(--ink)]">
        <Minus className="h-4 w-4" />
      </button>
      <div
        role="slider"
        tabIndex={0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label="Turn the crown"
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowRight") set(clamp(value + step));
          if (e.key === "ArrowDown" || e.key === "ArrowLeft") set(clamp(value - step));
        }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, v: value };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const d = Math.round((drag.current.y - e.clientY) / 6);
          set(clamp(drag.current.v + d * step));
        }}
        onPointerUp={() => (drag.current = null)}
        className="relative h-14 w-9 cursor-ns-resize touch-none rounded-[8px] bg-[linear-gradient(90deg,#c9ced5,#f2f3f5_45%,#aeb4bd)] shadow-[0_2px_6px_rgba(27,29,34,0.25)]"
      >
        {Array.from({ length: 9 }, (_, k) => (
          <span key={k} className="absolute inset-x-1 h-px bg-[rgba(27,29,34,0.35)]" style={{ top: `${10 + k * 10}%` }} />
        ))}
      </div>
      <button aria-label="More" onClick={() => set(clamp(value + step))} className="grid h-10 w-10 place-items-center rounded-full shadow-[inset_0_0_0_1px_var(--hair)] hover:shadow-[inset_0_0_0_1px_var(--ink)]">
        <Plus className="h-4 w-4" />
      </button>
      <span className="w-display ml-2 text-[30px]">{fmt}</span>
    </div>
  );
}

function Configure() {
  const [when, setWhen] = useState<When>("trail");
  const [val, setVal] = useState(5);
  const [then, setThen] = useState<Then>("convert");
  const [repeat, setRepeat] = useState(false);
  const [maxRuns, setMaxRuns] = useState(4);
  const [reveal, setReveal] = useState(false);
  const w = WHEN.find((x) => x.id === when)!;
  const t = THEN.find((x) => x.id === then)!;
  const pick = (id: When) => {
    setWhen(id);
    setVal(WHEN.find((x) => x.id === id)!.def);
  };

  const now = story.price[story.price.length - 1];
  const markerPrice = when === "trail" ? Math.max(...story.price) * (1 - val / 100) : when === "leave" ? story.range.lo * (1 - val / 100) : when === "timer" ? undefined : val;
  const phrase: Record<When, string> = {
    trail: `WETH falls ${val}% from its highest price`,
    below: `WETH falls below ${usd(val)}`,
    above: `WETH rises above ${usd(val)}`,
    leave: `WETH leaves your range by ${val}%`,
    oracle: `Chainlink says WETH is below ${usd(val)}`,
    timer: `${val} hours have passed`,
  };
  const sentence = `When ${phrase[when]}, ${t.says}${repeat ? `, and do it again each time, at most ${maxRuns} times` : ", once"}.`;

  return (
    <section id="configure" className="border-t border-[var(--hair)] bg-[#fbfbfc]">
      <div className="mx-auto grid max-w-6xl gap-14 px-5 py-28 lg:grid-cols-[1fr_440px]">
        <div>
          <h2 className="w-display text-[clamp(2.4rem,4.4vw,3.8rem)]">Choose your complications.</h2>
          <p className="mt-6 max-w-xl text-[18px] text-[var(--ink2)]">
            A watchmaker adds complications to a movement; you add rules to a position. Pick when, pick what happens, then turn the crown. Any condition, any
            action, joined with and/or in the app, with repeats and limits.
          </p>

          <div className="mt-12 grid gap-10 md:grid-cols-2">
            <fieldset>
              <legend className="w-engraved mb-4">When</legend>
              {WHEN.map((x) => (
                <label key={x.id} className="flex cursor-pointer items-center gap-3 border-b border-[var(--hair)] py-3 text-[16px]">
                  <input type="radio" name="when" checked={when === x.id} onChange={() => pick(x.id)} className="w-radio" />
                  <span className={when === x.id ? "text-[var(--ink)]" : "text-[var(--ink2)]"}>{x.label}</span>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="w-engraved mb-4">Then</legend>
              {THEN.map((x) => (
                <label key={x.id} className="flex cursor-pointer items-center gap-3 border-b border-[var(--hair)] py-3 text-[16px]">
                  <input type="radio" name="then" checked={then === x.id} onChange={() => setThen(x.id)} className="w-radio" />
                  <span className={then === x.id ? "text-[var(--ink)]" : "text-[var(--ink2)]"}>{x.label}</span>
                </label>
              ))}
              <label className="mt-6 flex cursor-pointer items-center gap-3 text-[16px]">
                <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} className="w-radio" />
                Repeat, at most
                <select value={maxRuns} onChange={(e) => setMaxRuns(Number(e.target.value))} disabled={!repeat} className="rounded-md bg-transparent px-1 shadow-[inset_0_0_0_1px_var(--hair)] disabled:opacity-40">
                  {[2, 3, 4, 8, 20].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                times
              </label>
            </fieldset>
          </div>

          <div className="mt-12">
            <div className="w-engraved mb-4">Turn the crown</div>
            <Crown value={val} set={setVal} min={w.min} max={w.max} step={w.step} unit={w.unit} />
          </div>
        </div>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <Dial price={now} stop={markerPrice} showStop={markerPrice !== undefined} showTake={false} status={repeat ? `UP TO ${maxRuns} RUNS` : "RUNS ONCE"} runs={0} fees={0} subdials={false} />
          <p className="mt-6 text-[19px] leading-relaxed text-[var(--ink)]" aria-live="polite">
            {sentence}
          </p>
          <button onClick={() => setReveal(!reveal)} className="w-link mt-3 text-[14px] text-[var(--ink2)]">
            {reveal ? "Hide" : "Reveal"} what the contract stores
          </button>
          {reveal && (
            <dl className="w-measure mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-[var(--hair)] pt-3 text-[var(--ink2)]">
              <dt>condition</dt>
              <dd>{w.field}</dd>
              <dt>actions</dt>
              <dd>{t.field}</dd>
              <dt>repeat</dt>
              <dd>{repeat ? `on · runsLeft ${maxRuns}` : "off"}</dd>
              <dt>limits</dt>
              <dd>maxKeeperFeeBps · maxSlippage · expiry</dd>
            </dl>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- sealed: the caseback

function Sealed() {
  const statements = [
    ["Your money stays in Uniswap.", "The position lives in a Uniswap v4 pool the whole time. Alucard is a hook on that pool, not a vault."],
    ["Anyone can wind it.", "When a rule's moment comes, any keeper can run it, and is paid its gas from the position, never above the cap you set."],
    ["No one can open it.", "Price limits, slippage, fee cap and run count are checked by the contract on every run. You can cancel at any time."],
  ];
  return (
    <section id="sealed" className="border-t border-[var(--hair)]">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 py-28 lg:grid-cols-[440px_1fr]">
        <div className="relative mx-auto w-full max-w-[440px]">
          <svg viewBox="0 0 600 600" className="mv" aria-hidden="true">
            <defs>
              <path id="seal-ring" d="M 300 300 m -262 0 a 262 262 0 1 1 524 0 a 262 262 0 1 1 -524 0" />
            </defs>
            <circle cx="300" cy="300" r="296" className="mv-case" />
            <circle cx="300" cy="300" r="282" fill="none" stroke="var(--ink2)" strokeWidth="1" />
            <text className="mv-ring-text" style={{ fontSize: 13 }}>
              <textPath href="#seal-ring">FUNDS STAY IN UNISWAP · LIMITS ENFORCED ON-CHAIN · ANYONE CAN WIND IT · NO ONE CAN OPEN IT ·</textPath>
            </text>
            {Array.from({ length: 6 }, (_, k) => {
              const a = (k / 6) * Math.PI * 2;
              return <rect key={k} x={300 + rc(a) * 246 - 9} y={300 + rs(a) * 246 - 5} width="18" height="10" rx="2" fill="var(--steel2)" transform={`rotate(${(k / 6) * 360 + 90} ${300 + rc(a) * 246} ${300 + rs(a) * 246})`} />;
            })}
          </svg>
          <div className="absolute inset-[16%] overflow-hidden rounded-full shadow-[inset_0_0_0_1px_var(--ink2)]">
            <Movement />
          </div>
        </div>
        <div>
          <h2 className="w-display text-[clamp(2.4rem,4.4vw,3.8rem)]">A sealed case.</h2>
          <dl className="mt-10 border-t border-[var(--hair)]">
            {statements.map(([h, b]) => (
              <div key={h} className="grid gap-2 border-b border-[var(--hair)] py-6 md:grid-cols-[240px_1fr]">
                <dt className="w-display text-[24px] tracking-[-0.02em]">{h}</dt>
                <dd className="text-[var(--ink2)]">{b}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- certificate of tests

function Certificate() {
  const rows = [
    ["Rule shapes the editor builds, checked against the contract", "79,682", "0 mismatches"],
    ["Orders replayed by the backtest engine and the contract", "4,000", "identical runs"],
    ["Contract tests, stress and fuzz included", "130", "all passing"],
    ["Batched exits in one stress run", "300", "every token accounted for"],
  ];
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  return (
    <section className="border-t border-[var(--hair)] bg-[#fbfbfc]">
      <div className="mx-auto max-w-4xl px-5 py-28">
        <div className="rounded-[4px] p-8 shadow-[0_0_0_1px_var(--hair),0_0_0_7px_#fbfbfc,0_0_0_8px_var(--hair)] sm:p-12">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--ink)] pb-5">
            <h2 className="w-display text-[clamp(2rem,3.6vw,3rem)]">Certificate of tests</h2>
            <span className="w-engraved">Alucard · Ethereum Sepolia</span>
          </div>
          <table className="mt-2 w-full text-left text-[16px]">
            <tbody>
              {rows.map(([what, n, result]) => (
                <tr key={what} className="border-b border-[var(--hair)]">
                  <td className="py-4 pr-4 text-[var(--ink2)]">{what}</td>
                  <td className="w-display py-4 pr-4 text-right text-[26px]">{n}</td>
                  <td className="py-4 text-right text-[14px] text-[var(--ruby)]">{result}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-6 text-[14px] text-[var(--ink3)]">
            Deployed:{" "}
            <a className="w-link" href={`https://sepolia.etherscan.io/address/${CORE.ruleHook}`} target="_blank" rel="noreferrer">RuleHook {short(CORE.ruleHook)}</a>
            {" · "}
            <a className="w-link" href={`https://sepolia.etherscan.io/address/${CORE.conditionalOrders}`} target="_blank" rel="noreferrer">ConditionalOrders {short(CORE.conditionalOrders)}</a>
          </p>
        </div>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section className="border-t border-[var(--hair)]">
      <div className="mx-auto max-w-6xl px-5 pb-10 pt-28 text-center">
        <h2 className="w-display mx-auto max-w-3xl text-[clamp(2.6rem,5vw,4.4rem)]">Set your rules. Then put it down.</h2>
        <p className="mx-auto mt-5 max-w-md text-[var(--ink2)]">Free test tokens are one click away in the app.</p>
        <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/swap" className="w-btn w-btn-ink">
            Open the app <ArrowRight className="h-4 w-4" />
          </Link>
          <Link href="/docs" className="w-btn w-btn-line">Read the docs</Link>
        </div>
        <footer className="mt-28 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--hair)] pt-6 text-[14px] text-[var(--ink3)]">
          <span className="w-display text-[18px] text-[var(--ink)]">Alucard</span>
          <span>A Uniswap v4 hook · Uniswap Hook Incubator</span>
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

export default function WatchLanding() {
  return (
    <div className="w-page min-h-screen overflow-x-clip">
      <Nav />
      <main>
        <Hero />
        <Replay />
        <Configure />
        <Sealed />
        <Certificate />
        <Close />
      </main>
    </div>
  );
}
