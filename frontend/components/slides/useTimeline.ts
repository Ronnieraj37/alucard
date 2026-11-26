"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A clock from 0 to 1 over `duration` ms, driven by requestAnimationFrame.
 * With reduced motion it jumps straight to `rest` (the finished state by default).
 */
export function useTimeline(duration: number, opts: { delay?: number; loop?: boolean; autoplay?: boolean; rest?: number } = {}) {
  const { delay = 0, loop = false, autoplay = true, rest = 1 } = opts;
  const [p, setP] = useState(0);
  const [playing, setPlaying] = useState(false);
  const pRef = useRef(0);
  const raf = useRef(0);
  const finished = useRef(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setPlaying(false);
  }, []);

  const play = useCallback(
    (from?: number) => {
      cancelAnimationFrame(raf.current);
      if (reduced()) {
        pRef.current = rest;
        finished.current = !loop;
        setP(rest);
        return;
      }
      // play(0) is the automatic start. Once a one-shot timeline has finished, ignore it.
      if (!loop && finished.current && from === 0) return;
      if (!loop && pRef.current >= 1 && from === undefined) {
        finished.current = false;
        pRef.current = 0;
        from = 0;
      }
      let start = performance.now() - (from ?? pRef.current) * duration;
      setPlaying(true);
      const step = (now: number) => {
        let v = (now - start) / duration;
        if (v >= 1) {
          if (loop) {
            start = now;
            v = 0;
          } else {
            v = 1;
            finished.current = true;
          }
        }
        pRef.current = v;
        setP(v);
        if (v < 1 || loop) raf.current = requestAnimationFrame(step);
        else setPlaying(false);
      };
      raf.current = requestAnimationFrame(step);
    },
    [duration, loop, rest],
  );

  const seek = useCallback(
    (v: number) => {
      stop();
      pRef.current = v;
      setP(v);
    },
    [stop],
  );

  useEffect(() => {
    if (!autoplay || finished.current) return;
    const id = setTimeout(() => play(0), reduced() ? 0 : delay);
    return () => {
      clearTimeout(id);
      cancelAnimationFrame(raf.current);
    };
  }, [autoplay, delay, play]);

  return { p, playing, play, stop, seek };
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

/** A number that counts up to `to` once the slide is shown. */
export function useCount(to: number, delay = 0, duration = 1400) {
  const { p } = useTimeline(duration, { delay });
  return to * easeOut(p);
}
