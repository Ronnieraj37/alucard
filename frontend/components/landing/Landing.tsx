"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { animate, motion, useInView, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Card, { DeckBack } from "@/components/cards/Card";
import { SUITS, SUIT_ORDER, type Suit } from "@/lib/suits";
import { CORE } from "@/lib/pools";
import story from "@/lib/story.json";

const EASE = [0.22, 1, 0.36, 1] as const;
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

// The four cards of the hero hand: one per suit, real templates from the rule editor.
const HAND: { suit: Suit; title: string; when: string; then: string }[] = [
  { suit: "protect", title: "Trailing stop", when: "ETH falls 5% from its high", then: "Withdraw, convert to USDC" },
  { suit: "profit", title: "Take profit", when: "ETH rises above your range", then: "Withdraw everything" },
  { suit: "follow", title: "Follow the price", when: "ETH leaves your range", then: "Move the range next to it" },
  { suit: "grow", title: "Compound", when: "Every 24 hours", then: "Add the fees back in" },
];

// ---------------------------------------------------------------- nav

function Nav() {
  const { scrollY } = useScroll();
  const [solid, setSolid] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setSolid(y > 24));
  return (
    <header className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${solid ? "border-b border-black/5 bg-[#eef0f2]/85 backdrop-blur-md" : ""}`}>
      <nav className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="relative h-7 w-5">
            <span className="absolute inset-0 rotate-[-10deg] rounded-[4px] bg-[#7d1426] shadow-sm" />
            <span className="absolute inset-0 rotate-[6deg] rounded-[4px] border border-black/10 bg-white text-center text-[11px] leading-7 text-[#d0223a] shadow-sm">♥</span>
          </span>
          <span className="t-display text-[22px] leading-none">Alucard</span>
        </Link>
        <div className="hidden gap-7 text-[14px] text-[#5b5e68] md:flex">
          <a href="#build" className="hover:text-black">How it works</a>
          <a href="#suits" className="hover:text-black">The four suits</a>
          <Link href="/docs" className="hover:text-black">Docs</Link>
        </div>
        <Link href="/swap" className="t-btn t-btn-dark ml-auto !h-10 !px-4 !text-[14px]">
          Open the app <ArrowRight className="h-4 w-4" />
        </Link>
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------- hero: a hand dealt onto a position

function Hero() {
  const calm = useReducedMotion();
  const [open, setOpen] = useState<number | null>(null);
  // a tighter fan on phones
  const [k, setK] = useState(1);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 640px)");
    const f = () => setK(m.matches ? 0.36 : 1);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  // fanned resting places around the position
  const fan = [
    { x: -270, y: 30, r: -14 },
    { x: -92, y: -6, r: -5 },
    { x: 92, y: -6, r: 5 },
    { x: 270, y: 30, r: 14 },
  ];
  return (
    <section className="relative mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-28 lg:min-h-[100svh] lg:grid-cols-[0.9fr_1.1fr] lg:pt-20">
      <div>
        <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE }} className="t-kicker">
          Rules for Uniswap v4 positions · live on Sepolia
        </motion.p>
        <motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.05, ease: EASE }} className="t-display mt-5 text-[clamp(2.7rem,5.2vw,4.5rem)] leading-[1]">
          Play your rules.
          <br />
          <span className="text-[#7d1426]">Keep your position.</span>
        </motion.h1>
        <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.15, ease: EASE }} className="mt-6 max-w-md text-[17px] leading-relaxed text-[#4a4c55]">
          Every rule is a card: <em className="not-italic text-[#17181c]">when this happens, do that.</em> Stop a loss, lock in a gain, follow the price, compound the fees.
          Test the hand on real prices, then the contract plays it for you, and your money never leaves Uniswap.
        </motion.p>
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.25, ease: EASE }} className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Link href="/pool/new" className="t-btn t-btn-dark">
            Deal your first rule <ArrowRight className="h-4 w-4" />
          </Link>
          <a href="#build" className="t-btn t-btn-light">
            See how a rule is made
          </a>
        </motion.div>
      </div>

      <div className="relative mx-auto h-[440px] w-full max-w-[620px] sm:h-[500px]">
        {/* the position: the table the cards are played on */}
        <div className="absolute bottom-0 left-1/2 w-[300px] -translate-x-1/2 rounded-2xl border border-dashed border-black/15 bg-white/60 px-5 py-4 text-center">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a8d97]">Your position</div>
          <div className="mt-1 font-semibold">WETH / USDC · 0.3%</div>
          <div className="text-[13px] text-[#5b5e68]">Range 1,982 – 2,195 · $10,000</div>
        </div>
        {/* the deck the hand is dealt from */}
        <div className="absolute bottom-2 right-2 hidden w-[84px] sm:block" aria-hidden="true">
          {[3, 2, 1, 0].map((k) => (
            <div key={k} className="absolute aspect-[5/7] w-full overflow-hidden rounded-[12px]" style={{ top: -k * 2, left: k * 1.5 }}>
              <DeckBack />
            </div>
          ))}
        </div>
        {HAND.map((c, i) => (
          <motion.div
            key={c.title}
            className="absolute left-1/2 top-6 -ml-[105px] cursor-pointer max-sm:top-2 max-sm:scale-[0.8]"
            initial={calm ? false : { x: 260, y: -40, rotate: 25, opacity: 0 }}
            animate={{ x: fan[i].x * k, y: open === i ? fan[i].y - 34 : fan[i].y, rotate: open === i ? 0 : fan[i].r, opacity: 1, zIndex: open === i ? 10 : i }}
            transition={{ type: "spring", stiffness: 140, damping: 18, delay: calm ? 0 : 0.35 + i * 0.12 }}
            whileHover={{ y: fan[i].y - 18 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setOpen(open === i ? null : i)}
          >
            <Card
              suit={c.suit}
              title={c.title}
              when={c.when}
              then={c.then}
              size="md"
              flipped={open === i}
              back={<HandBack suit={c.suit} title={c.title} />}
            />
          </motion.div>
        ))}
        <p className="absolute -bottom-9 left-0 right-0 text-center text-[12px] text-[#8a8d97]">Tap a card to turn it over</p>
      </div>
    </section>
  );
}

function HandBack({ suit, title }: { suit: Suit; title: string }) {
  const s = SUITS[suit];
  const lines: Record<Suit, string[]> = {
    protect: [`Last 90 days, $10,000: ${usd(story.final.rules)} with it, ${usd(story.final.noRules)} without.`, "Real Chainlink prices on our Sepolia pool."],
    profit: ["Fires once the price is above your range.", "Or in steps: 25% at every 5% up."],
    follow: ["The range moves next to the price.", "Keeps earning fees instead of sitting out."],
    grow: ["Collects the fees and adds them back.", "On a timer or once fees pass a level."],
  };
  return (
    <div className="flex h-full flex-col" style={{ color: s.color }}>
      <div className="text-[10px] font-bold uppercase tracking-[0.18em]">{s.pip} {s.job}</div>
      <div className="t-display mt-2 text-[20px] leading-tight text-[#17181c]">{title}</div>
      {lines[suit].map((l) => (
        <p key={l} className="mt-2 text-[12px] leading-snug text-[#4a4c55]">{l}</p>
      ))}
      <div className="mt-auto text-[10px] text-[#8a8d97]">Checked on-chain every time it runs</div>
    </div>
  );
}

// ---------------------------------------------------------------- how a rule is made: when + then snap together

function Build() {
  const calm = useReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const p = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
  const [stage, setStage] = useState(0);
  useMotionValueEvent(p, "change", (v) => setStage(v < 0.3 ? 0 : v < 0.62 ? 1 : 2));
  const whenX = useTransform(p, [0, 0.3, 0.55], [-260, -130, 0]);
  const thenX = useTransform(p, [0, 0.3, 0.55], [260, 130, 0]);
  const join = useTransform(p, [0.5, 0.6], [0, 1]);
  const lift = useTransform(p, [0.62, 0.95], [0, 1]);
  const ruleY = useTransform(lift, [0, 1], [0, 120]);
  const ruleScale = useTransform(lift, [0, 1], [1, 0.82]);
  const halves = useTransform(join, [0, 1], [1, 0]);
  const joined = useTransform(join, [0, 1], [0.92, 1]);

  const STEPS = [
    { k: "1 · When", h: "Pick the moment.", b: "The price leaves your range, falls a set % from its high, passes a Chainlink price, a timer, or fees past a level. Join two with and / or." },
    { k: "2 · Then", h: "Pick what happens.", b: "Withdraw some or all, convert to one token, put it back in a new range, or add the fees back. Repeat it, or run it once." },
    { k: "3 · Play it", h: "It becomes one card on your position.", b: "It reads back in plain words before you sign. From then on, it is the contract's job." },
  ];
  const step = calm ? 2 : stage;
  return (
    <section id="build" ref={ref} className="relative" style={{ height: calm ? "auto" : "300vh" }}>
      <div className={`${calm ? "" : "sticky top-0"} mx-auto grid min-h-[100svh] max-w-6xl items-center gap-10 px-5 py-24 lg:grid-cols-[0.85fr_1.15fr]`}>
        <div>
          <p className="t-kicker">How a rule is made</p>
          <h2 className="t-display mt-4 text-[clamp(2.3rem,4.8vw,3.9rem)] leading-[1]">A when card and a then card.</h2>
          <ol className="mt-10 space-y-5">
            {STEPS.map((s, k) => (
              <li key={s.k} className={`border-l-2 pl-5 transition-all duration-500 ${k === step ? "border-[#7d1426] opacity-100" : "border-black/10 opacity-40"}`}>
                <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[#7d1426]">{s.k}</div>
                <div className="t-display mt-1 text-2xl">{s.h}</div>
                <p className="mt-1 max-w-md text-[15px] leading-relaxed text-[#4a4c55]">{s.b}</p>
              </li>
            ))}
          </ol>
        </div>
        <div className="relative h-[460px]">
          <div className="absolute bottom-0 left-1/2 w-[280px] -translate-x-1/2 rounded-2xl border border-dashed border-black/15 bg-white/60 px-5 py-4 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a8d97]">Your position</div>
            <div className="mt-1 font-semibold">WETH / USDC · 0.3%</div>
          </div>
          <motion.div style={calm ? undefined : { y: ruleY, scale: ruleScale }} className="absolute left-1/2 top-4 -ml-[105px]">
            <motion.div style={calm ? undefined : { x: whenX }} className="absolute left-0 top-0">
              <motion.div style={calm ? { opacity: 0 } : { opacity: halves }}>
                <HalfCard label="When" text="ETH falls 5% from its high" />
              </motion.div>
            </motion.div>
            <motion.div style={calm ? undefined : { x: thenX }} className="absolute left-0 top-[150px]">
              <motion.div style={calm ? { opacity: 0 } : { opacity: halves }}>
                <HalfCard label="Then" text="Withdraw everything, convert to USDC" />
              </motion.div>
            </motion.div>
            <motion.div style={calm ? undefined : { opacity: join, scale: joined }}>
              <Card suit="protect" title="Trailing stop" when="ETH falls 5% from its high" then="Withdraw, convert to USDC" />
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function HalfCard({ label, text }: { label: string; text: string }) {
  return (
    <div className="w-[210px] rounded-[14px] bg-white p-4 shadow-[0_0_0_1px_rgba(23,24,28,0.09),0_8px_24px_-10px_rgba(23,24,28,0.28)]">
      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#17181c]">♠ {label}</div>
      <div className="t-display mt-2 text-[19px] leading-tight">{text}</div>
    </div>
  );
}

// ---------------------------------------------------------------- test the hand: the card turns over to its backtest

function TestHand() {
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useInView(ref, { once: true, amount: 0.5 });
  const calm = useReducedMotion();
  const flipped = calm || seen;
  const path = useMemo(() => {
    const n = story.price.length;
    const lo = Math.min(...story.price);
    const hi = Math.max(...story.price);
    const x = (i: number) => (i / (n - 1)) * 230;
    const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * 92;
    const exitI = story.t.findIndex((t) => t >= (story.events[0]?.t ?? Infinity));
    return { d: story.price.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(""), ex: x(exitI), ey: y(story.price[exitI]) };
  }, []);
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-14 px-5 py-28 lg:grid-cols-2">
      <div ref={ref} className="flex justify-center">
        <motion.div initial={{ rotate: -4 }} whileInView={{ rotate: 0 }} viewport={{ once: true }} transition={{ duration: 1, ease: EASE }}>
          <Card
            suit="protect"
            title="Trailing stop"
            when="ETH falls 5% from its high"
            then="Withdraw, convert to USDC"
            size="lg"
            flipped={flipped}
            back={
              <div className="flex h-full flex-col">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em]">♠ Last 90 days · $10,000</div>
                <svg viewBox="0 0 230 108" className="mt-3 w-full">
                  <motion.path d={path.d} fill="none" stroke="#17181c" strokeWidth="1.6" initial={{ pathLength: calm ? 1 : 0 }} animate={flipped ? { pathLength: 1 } : undefined} transition={{ duration: 1.6, delay: 0.5, ease: "easeInOut" }} />
                  <circle cx={path.ex} cy={path.ey} r="4" fill="#d0223a" />
                </svg>
                <div className="mt-1 text-[10px] text-[#d0223a]">ran {day(story.events[0]?.t ?? story.start)} · exited to USDC</div>
                <dl className="mt-auto space-y-1.5 text-[13px]">
                  <Row k="With the card" v={usd(story.final.rules)} strong />
                  <Row k="Without it" v={usd(story.final.noRules)} />
                  <Row k="Just holding" v={usd(story.final.hold)} />
                </dl>
              </div>
            }
          />
        </motion.div>
      </div>
      <div>
        <p className="t-kicker">Test the hand</p>
        <h2 className="t-display mt-4 text-[clamp(2.3rem,4.8vw,3.9rem)] leading-[1]">Turn the card over before you play it.</h2>
        <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-[#4a4c55]">
          Every card has its history on the back. Replay it on six months of your pool&apos;s Chainlink prices, with keeper delay and pay counted, using the
          same steps the contract runs.
        </p>
        <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-[#5b5e68]">
          This one is real: our Sepolia WETH/USDC pool, {day(story.start)} to {day(story.end)}. The stop ran on {day(story.events[0]?.t ?? story.start)}. ETH then climbed for
          weeks, when keeping the position looked better, before falling to {usd(story.endPrice)}. A card trades some upside for protection; the back shows you both.
        </p>
      </div>
    </section>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between border-b border-black/5 pb-1">
      <dt className="text-[#5b5e68]">{k}</dt>
      <dd className={strong ? "font-semibold text-[#17181c]" : "text-[#5b5e68]"}>{v}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- played on-chain

function Played() {
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useInView(ref, { once: true, amount: 0.6 });
  const calm = useReducedMotion();
  const go = calm || seen;
  return (
    <section className="bg-white/60 py-28">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 lg:grid-cols-[1.1fr_0.9fr]">
        <div ref={ref} className="relative mx-auto h-[360px] w-full max-w-[520px]">
          <div className="absolute left-0 top-10 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a8d97]">On your position</div>
          <div className="absolute right-0 top-10 text-right text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8a8d97]">Played</div>
          <div className="absolute right-0 top-16 h-[294px] w-[210px] rounded-[14px] border border-dashed border-black/15" />
          <motion.div
            className="absolute left-0 top-16"
            initial={false}
            animate={go ? { x: [0, 0, 300], y: [0, -26, 0], rotate: [0, -3, 4] } : {}}
            transition={{ duration: 1.6, times: [0, 0.35, 1], ease: EASE, delay: 0.3 }}
          >
            <Card suit="protect" title="Trailing stop" when="ETH falls 5% from its high" then="Withdraw, convert to USDC" />
            <motion.div
              initial={{ opacity: 0, scale: 1.6, rotate: -14 }}
              animate={go ? { opacity: 1, scale: 1, rotate: -10 } : {}}
              transition={{ duration: 0.35, delay: 1.9, ease: EASE }}
              className="absolute left-6 top-[46%] rounded-md border-[3px] border-[#7d1426] px-3 py-1 text-[15px] font-bold uppercase tracking-[0.16em] text-[#7d1426]"
            >
              Ran · {day(story.events[0]?.t ?? story.start)}
            </motion.div>
          </motion.div>
        </div>
        <div>
          <p className="t-kicker">Played on-chain</p>
          <h2 className="t-display mt-4 text-[clamp(2.3rem,4.8vw,3.9rem)] leading-[1]">Anyone can play your card. Only by your rules.</h2>
          <ul className="mt-8 space-y-4 text-[16px] leading-relaxed text-[#4a4c55]">
            <li><b className="text-[#17181c]">No operator.</b> When the moment comes, any keeper can run it, and is paid its gas from the position, never above the cap you set.</li>
            <li><b className="text-[#17181c]">Your money stays in Uniswap.</b> The position lives in a Uniswap v4 pool the whole time; Alucard is a hook on it.</li>
            <li><b className="text-[#17181c]">The contract checks every card.</b> Price limits, slippage, fee cap and run count are enforced on-chain. Take a card back any time.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the four suits

const DECK: Record<Suit, { title: string; when: string; then: string }[]> = {
  protect: [
    { title: "Stop loss", when: "ETH falls below your range", then: "Exit to USDC" },
    { title: "Trailing stop", when: "ETH falls 5% from its high", then: "Exit to USDC" },
    { title: "Confirmed stop", when: "Below the range for 30 minutes", then: "Exit to USDC" },
  ],
  profit: [
    { title: "Take profit", when: "ETH rises above your range", then: "Withdraw everything" },
    { title: "Profit in steps", when: "Every 5% up, at most 4 times", then: "Withdraw 25%" },
  ],
  follow: [{ title: "Auto re-range", when: "ETH leaves your range", then: "Move the range next to it" }],
  grow: [{ title: "Compound", when: "Every 24 hours", then: "Add the fees back in" }],
};

function Suits() {
  const [hover, setHover] = useState<Suit | null>(null);
  return (
    <section id="suits" className="mx-auto max-w-6xl px-5 py-28">
      <p className="t-kicker">The four suits</p>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h2 className="t-display mt-4 max-w-2xl text-[clamp(2.3rem,4.8vw,3.9rem)] leading-[1]">Know what a position is protected against, at a glance.</h2>
        <p className="max-w-sm text-[15px] text-[#5b5e68]">Start from these, or make your own from any when and then. Mix suits: a stop below and a take-profit above is a classic hand.</p>
      </div>
      <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {SUIT_ORDER.map((s) => (
          <div key={s} onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(null)} className="rounded-3xl p-5" style={{ background: SUITS[s].tint }}>
            <div className="flex items-baseline justify-between" style={{ color: SUITS[s].color }}>
              <span className="t-display text-2xl">
                {SUITS[s].pip} {SUITS[s].name}
              </span>
              <span className="text-[12px] font-semibold">{SUITS[s].job}</span>
            </div>
            <div className="relative mt-5 h-[250px]">
              {DECK[s].map((c, k) => {
                const spread = hover === s;
                return (
                  <motion.div
                    key={c.title}
                    className="absolute left-1/2 top-0 -ml-[75px]"
                    animate={{ x: spread ? (k - (DECK[s].length - 1) / 2) * 46 : k * 4, y: spread ? Math.abs(k - (DECK[s].length - 1) / 2) * 10 : k * 6, rotate: spread ? (k - (DECK[s].length - 1) / 2) * 9 : k * 1.5 }}
                    transition={{ type: "spring", stiffness: 220, damping: 20 }}
                    style={{ zIndex: k }}
                  >
                    <Card suit={s} title={c.title} when={c.when} then={c.then} size="sm" />
                  </motion.div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- proof and the close

function Count({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const seen = useInView(ref, { once: true, amount: 0.8 });
  const calm = useReducedMotion();
  const [v, setV] = useState(calm ? to : 0);
  useEffect(() => {
    if (!seen || calm) return;
    const c = animate(0, to, { duration: 1.4, ease: EASE, onUpdate: setV });
    return () => c.stop();
  }, [seen, to, calm]);
  return <span ref={ref}>{Math.round(v).toLocaleString("en-US")}</span>;
}

function Proof() {
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  return (
    <section className="mx-auto max-w-6xl px-5 py-20">
      <div className="grid gap-px overflow-hidden rounded-3xl border border-black/10 bg-black/10 md:grid-cols-3">
        {[
          { n: 79682, l: "rules the editor and the contract agree on, with 0 mismatches" },
          { n: 4000, l: "orders replayed by the backtest and the contract, with identical runs" },
          { n: 130, l: "contract tests, stress and fuzz included, all passing" },
        ].map((x) => (
          <div key={x.l} className="bg-[#f6f7f8] p-8">
            <div className="t-display text-[clamp(2.6rem,5vw,3.6rem)] leading-none">
              <Count to={x.n} />
            </div>
            <p className="mt-3 text-[15px] text-[#5b5e68]">{x.l}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 px-2 text-[13px] text-[#5b5e68]">
        <span>Live on Ethereum Sepolia:</span>
        {[
          ["RuleHook", CORE.ruleHook],
          ["ConditionalOrders", CORE.conditionalOrders],
        ].map(([n, a]) => (
          <a key={n} href={`https://sepolia.etherscan.io/address/${a}`} target="_blank" rel="noreferrer" className="hover:text-black">
            {n} <span className="font-mono text-[#8a8d97]">{short(a)}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function Close() {
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useInView(ref, { once: true, amount: 0.7 });
  const calm = useReducedMotion();
  return (
    <section className="px-5 pb-12 pt-24 text-center">
      <div ref={ref} className="mx-auto flex justify-center">
        <motion.div initial={{ rotate: -6, y: 20 }} whileInView={{ rotate: 0, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.9, ease: EASE }}>
          <Card suit="grow" title="Your move" when="You set the rules" then="The contract plays them" faceDown={!(calm || seen)} />
        </motion.div>
      </div>
      <h2 className="t-display mx-auto mt-12 max-w-3xl text-[clamp(2.4rem,5.6vw,4.4rem)] leading-[1]">Deal your position a better hand.</h2>
      <p className="mx-auto mt-5 max-w-md text-[17px] text-[#5b5e68]">Free test tokens are one click away in the app.</p>
      <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
        <Link href="/pool/new" className="t-btn t-btn-dark">
          Deal your first rule <ArrowRight className="h-4 w-4" />
        </Link>
        <Link href="/docs" className="t-btn t-btn-light">
          Read the docs
        </Link>
      </div>
      <footer className="mx-auto mt-28 flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-black/10 pt-6 text-[13px] text-[#8a8d97]">
        <span className="t-display text-lg text-[#17181c]">Alucard</span>
        <span>A Uniswap v4 hook · Uniswap Hook Incubator</span>
        <span className="flex gap-5">
          <Link href="/swap" className="hover:text-black">App</Link>
          <Link href="/docs" className="hover:text-black">Docs</Link>
          <a href="https://github.com/Ronnieraj37/alucard" target="_blank" rel="noreferrer" className="hover:text-black">GitHub</a>
        </span>
      </footer>
    </section>
  );
}

export default function Landing() {
  return (
    <div className="table-page min-h-screen overflow-x-clip">
      <Nav />
      <main>
        <Hero />
        <Build />
        <TestHand />
        <Played />
        <Suits />
        <Proof />
        <Close />
      </main>
    </div>
  );
}
