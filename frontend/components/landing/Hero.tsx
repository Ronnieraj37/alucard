"use client";

import Link from "next/link";
import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { ArrowRight, ChevronDown } from "lucide-react";
import PositionCard from "./PositionCard";

const rise = (delay: number) => ({ style: { animationDelay: `${delay}s` } });

export default function Hero() {
  const calm = useReducedMotion();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({ target: cardRef, offset: ["start end", "center center"] });
  const tilt = useTransform(scrollYProgress, [0, 1], [32, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.9, 1]);
  const glow = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <section className="relative flex flex-col items-center px-5 pb-20 pt-36 text-center sm:pt-44">
      <a
        href="#story"
        {...rise(0)}
        className="n-rise n-panel group mb-9 inline-flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4 text-[13px] text-[var(--n-dim)] transition-colors hover:text-white"
      >
        <span className="rounded-full bg-[rgba(255,74,95,0.16)] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--n-crimson)]">
          Uniswap v4 hook
        </span>
        Live on Sepolia
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </a>

      <h1 className="n-display max-w-5xl text-[clamp(3.1rem,9.4vw,8.4rem)] leading-[0.92]">
        <span {...rise(0.1)} className="n-rise block">
          Your liquidity
        </span>
        <span {...rise(0.25)} className="n-rise n-moonlit block italic">
          keeps watch.
        </span>
      </h1>

      <p {...rise(0.45)} className="n-rise mt-8 max-w-[34rem] text-[17px] leading-relaxed text-[var(--n-dim)] sm:text-lg">
        Give your Uniswap position rules: take profit, trailing stops, follow the price, compound the fees. When a rule&apos;s
        moment comes, it runs on-chain, day or night, and your money never leaves Uniswap.
      </p>

      <div {...rise(0.6)} className="n-rise mt-10 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
        <Link href="/pool/new" className="n-btn n-btn-primary w-full sm:w-auto">
          Set your first rule
          <ArrowRight className="h-4 w-4" />
        </Link>
        <a href="#story" className="n-btn n-btn-ghost w-full sm:w-auto">
          Watch a rule run
        </a>
      </div>

      <ul {...rise(0.75)} className="n-rise mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-[var(--n-faint)]">
        {["Funds stay in Uniswap", "Any keeper can run it", "Backtest before you commit"].map((t) => (
          <li key={t} className="flex items-center gap-2">
            <span className="h-1 w-1 rounded-full bg-[var(--n-crimson)]" />
            {t}
          </li>
        ))}
      </ul>

      <motion.a
        href="#story"
        aria-label="Scroll to the story"
        animate={calm ? undefined : { y: [0, 6, 0] }}
        transition={{ duration: 2.4, repeat: Infinity }}
        className="mt-14 grid h-10 w-10 place-items-center rounded-full border border-white/15 text-[var(--n-faint)] hover:text-white"
      >
        <ChevronDown className="h-4 w-4" />
      </motion.a>

      <div ref={cardRef} className="mt-16 w-full max-w-5xl [perspective:1600px]">
        <motion.div style={calm ? undefined : { rotateX: tilt, scale }} className="relative origin-bottom">
          <motion.div
            aria-hidden="true"
            style={{ opacity: glow }}
            className="pointer-events-none absolute -inset-x-10 -bottom-10 top-1/3 -z-10 rounded-[48px] bg-[radial-gradient(closest-side,rgba(255,74,95,0.28),transparent)] blur-2xl"
          />
          <PositionCard />
        </motion.div>
      </div>
    </section>
  );
}
