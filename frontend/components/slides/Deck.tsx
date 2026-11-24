"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, NotebookText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SLIDES } from "./scenes";
import "./slides.css";

const W = 1920;
const H = 1080;

export default function Deck() {
  const [mounted, setMounted] = useState(false);
  const [i, setI] = useState(0);
  const [scale, setScale] = useState(1);
  const [notes, setNotes] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [full, setFull] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const n = SLIDES.length;

  const go = useCallback((k: number) => setI(Math.max(0, Math.min(n - 1, k))), [n]);

  // start on the slide named in the hash (#4), so a reload keeps your place
  useEffect(() => {
    const k = parseInt(window.location.hash.slice(1), 10);
    if (k >= 1 && k <= n) setI(k - 1);
    setMounted(true);
  }, [n]);

  useEffect(() => {
    if (mounted) history.replaceState(null, "", `#${i + 1}`);
  }, [i, mounted]);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener("resize", fit);
    const fs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("fullscreenchange", fs);
    };
  }, []);

  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) {
        e.preventDefault();
        go(i + 1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) {
        e.preventDefault();
        go(i - 1);
      } else if (e.key === "Home") go(0);
      else if (e.key === "End") go(n - 1);
      else if (e.key === "f" || e.key === "F") toggleFull();
      else if (e.key === "n" || e.key === "N") setNotes((v) => !v);
      else if (/^[1-9]$/.test(e.key)) go(parseInt(e.key, 10) - 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [i, n, go, toggleFull]);

  // the controls fade away while presenting and come back when the mouse moves
  useEffect(() => {
    const wake = () => {
      setChrome(true);
      clearTimeout(idle.current);
      idle.current = setTimeout(() => setChrome(false), 2600);
    };
    wake();
    window.addEventListener("mousemove", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      clearTimeout(idle.current);
    };
  }, []);

  if (!mounted) return <div className="dk" />;
  const S = SLIDES[i];

  return (
    <div className={`dk dk-${S.theme} ${chrome || notes ? "" : "dk-quiet"}`}>
      <div className="dk-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <AnimatePresence mode="wait">
          <motion.section
            key={S.id}
            className="dk-slide"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.18 } }}
            transition={{ duration: 0.35 }}
            aria-label={`Slide ${i + 1} of ${n}`}
          >
            <S.C />
          </motion.section>
        </AnimatePresence>
      </div>

      {notes && (
        <div className="dk-notes" role="note">
          <p className="dk-notes-h">Speaker notes · {i + 1} / {n}</p>
          <p>{S.notes}</p>
        </div>
      )}

      <div className="dk-bar">
        <p className="dk-brand">
          <span className="dk-jewel" />
          Alucard
        </p>
        <div className="dk-ticks">
          {SLIDES.map((s, k) => (
            <button key={s.id} className={`dk-tick ${k === i ? "on" : k < i ? "past" : ""}`} onClick={() => go(k)} aria-label={`Go to slide ${k + 1}: ${s.title}`} title={s.title} />
          ))}
        </div>
        <div className="dk-ctl">
          <span className="dk-count">
            {String(i + 1).padStart(2, "0")} / {String(n).padStart(2, "0")}
          </span>
          <button onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous slide">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => go(i + 1)} disabled={i === n - 1} aria-label="Next slide">
            <ChevronRight size={18} />
          </button>
          <button onClick={() => setNotes((v) => !v)} className={notes ? "on" : ""} aria-label="Speaker notes (N)" title="Speaker notes (N)">
            <NotebookText size={17} />
          </button>
          <button onClick={toggleFull} aria-label="Full screen (F)" title="Full screen (F)">
            {full ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}
