"use client";

import Link from "next/link";
import { useState } from "react";
import { motion, useMotionValueEvent, useScroll } from "framer-motion";
import { ArrowRight } from "lucide-react";

export default function LandingNav() {
  const { scrollY } = useScroll();
  const [solid, setSolid] = useState(false);
  useMotionValueEvent(scrollY, "change", (y) => setSolid(y > 40));
  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-4 z-40 px-4"
    >
      <nav
        className={`mx-auto flex h-14 max-w-5xl items-center gap-6 rounded-full pl-5 pr-2 transition-all duration-500 ${
          solid ? "n-panel shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]" : "border border-transparent"
        }`}
      >
        <Link href="/" className="n-display text-[22px] leading-none">
          Alucard
        </Link>
        <div className="hidden gap-6 text-[14px] text-[var(--n-dim)] sm:flex">
          <a href="#story" className="hover:text-white">See it run</a>
          <a href="#how" className="hover:text-white">How it works</a>
          <Link href="/docs" className="hover:text-white">Docs</Link>
        </div>
        <Link href="/swap" className="n-btn n-btn-primary ml-auto !min-h-10 !px-4 !text-[14px]">
          Open the app <ArrowRight className="h-4 w-4" />
        </Link>
      </nav>
    </motion.header>
  );
}
