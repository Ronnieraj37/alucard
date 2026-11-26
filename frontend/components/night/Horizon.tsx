"use client";

// The hero's black hole, drawn on a canvas: a starfield, a tilted accretion disk (ember on the side coming toward us,
// violet on the other), the far side of the disk lensed over the top, a photon ring and the shadow.
//
// Cheap to run: everything that does not move (stars, glow, the blurred disk bands, the shadow) is drawn once per
// resize into offscreen layers; each frame only copies those layers and moves a few hundred particles. It stops when
// it is off screen or the tab is hidden, caps the pixel ratio, and with reduced motion renders one still frame.
import { useEffect, useRef } from "react";

type P = { r: number; a: number; w: number; s: number; h: number };

const TILT = 0.21; // how flat the disk looks
const ROT = -0.32; // the disk's angle on screen

export default function Horizon({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0,
      H = 0,
      dpr = 1,
      raf = 0,
      cx = 0,
      cy = 0,
      R = 0,
      visible = true;
    // layers drawn once per size: behind the particles, and in front of the far-side particles
    let back: HTMLCanvasElement | null = null;
    let front: HTMLCanvasElement | null = null;
    const disk: P[] = Array.from({ length: 700 }, () => {
      const r = 1.25 + Math.pow(Math.random(), 1.6) * 2.6; // in shadow radii
      return { r, a: Math.random() * 6.283, w: 0.9 / Math.pow(r, 1.5), s: Math.random() * 1.4 + 0.6, h: Math.random() };
    });

    const layer = (draw: (c: CanvasRenderingContext2D) => void) => {
      const l = document.createElement("canvas");
      l.width = cv.width;
      l.height = cv.height;
      const c = l.getContext("2d")!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(c);
      return l;
    };

    const grad = (c: CanvasRenderingContext2D, a: number) => {
      const gr = c.createLinearGradient(-R * 4.2, 0, R * 4.2, 0);
      gr.addColorStop(0, `rgba(255,190,120,${a})`);
      gr.addColorStop(0.35, `rgba(255,236,220,${Math.min(1, a * 1.2)})`);
      gr.addColorStop(0.6, `rgba(196,178,255,${a})`);
      gr.addColorStop(1, `rgba(109,124,255,${a * 0.7})`);
      return gr;
    };

    const band = (c: CanvasRenderingContext2D, isFront: boolean) => {
      c.filter = "blur(2.5px)";
      const rings = 40;
      for (let k = 0; k < rings; k++) {
        const f = k / (rings - 1);
        const r = 1.32 + f * 2.9;
        c.strokeStyle = grad(c, (1 - f) * (1 - f) * (isFront ? 0.7 : 0.45) * (0.75 + 0.25 * Math.sin(k * 1.7)));
        c.lineWidth = 1.6 + (1 - f) * 2.4;
        c.beginPath();
        if (isFront) c.ellipse(0, 0, r * R, r * R * TILT, 0, 0, Math.PI);
        else c.ellipse(0, 0, r * R, r * R * TILT, 0, Math.PI, 2 * Math.PI);
        c.stroke();
      }
      c.filter = "none";
    };

    const build = () => {
      const wide = W > 900;
      cx = wide ? W * 0.66 : W * 0.5;
      cy = wide ? H * 0.46 : H * 0.3;
      R = Math.min(W * (wide ? 0.09 : 0.14), H * 0.13);
      back = layer((c) => {
        // stars, pushed out a little near the hole
        for (let i = 0; i < 260; i++) {
          let x = Math.random() * W,
            y = Math.random() * H;
          const dx = x - cx,
            dy = y - cy,
            d = Math.hypot(dx, dy);
          if (d < R * 1.05) continue;
          const push = (R * R * 1.4) / d;
          x += (dx / d) * push * 0.6;
          y += (dy / d) * push * 0.6;
          c.fillStyle = `rgba(220,215,255,${0.25 + Math.random() * 0.5})`;
          const s = Math.random() * 1.2 + 0.2;
          c.fillRect(x, y, s, s);
        }
        const g = c.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 5);
        g.addColorStop(0, "rgba(139,108,255,0.35)");
        g.addColorStop(0.4, "rgba(109,124,255,0.08)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
        c.translate(cx, cy);
        c.rotate(ROT);
        c.globalCompositeOperation = "lighter";
        // the far side of the disk, bent up over the shadow (and a thin image under it)
        c.filter = "blur(3px)";
        for (let k = 0; k < 22; k++) {
          const f = k / 21;
          const r = 1.08 + f * 1.5;
          c.strokeStyle = grad(c, (1 - f) * (1 - f) * 0.75);
          c.lineWidth = 2 + (1 - f) * 3;
          c.beginPath();
          c.ellipse(0, 0, r * R, r * R * 0.92, 0, Math.PI * 1.02, Math.PI * 1.98);
          c.stroke();
        }
        for (let k = 0; k < 8; k++) {
          const r = 1.06 + (k / 7) * 0.35;
          c.strokeStyle = grad(c, 0.3 * (1 - k / 8));
          c.lineWidth = 1;
          c.beginPath();
          c.ellipse(0, 0, r * R, r * R * 0.9, 0, Math.PI * 0.1, Math.PI * 0.9);
          c.stroke();
        }
        c.filter = "none";
        band(c, false);
      });
      front = layer((c) => {
        c.translate(cx, cy);
        c.rotate(ROT);
        // the shadow and the photon ring, then the near side of the disk crossing in front of it
        c.beginPath();
        c.arc(0, 0, R, 0, 6.283);
        c.fillStyle = "#020106";
        c.fill();
        c.lineWidth = 1.6;
        c.strokeStyle = "rgba(240,232,255,0.95)";
        c.shadowColor = "rgba(196,178,255,1)";
        c.shadowBlur = 22;
        c.beginPath();
        c.arc(0, 0, R * 1.03, 0, 6.283);
        c.stroke();
        c.shadowBlur = 0;
        c.globalCompositeOperation = "lighter";
        band(c, true);
      });
    };

    const size = () => {
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const b = cv.getBoundingClientRect();
      if (!b.width || !b.height) return;
      W = b.width;
      H = b.height;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      build();
      if (still || !raf) frame();
    };

    const color = (x: number, isFront: boolean, h: number, alpha: number) => {
      // doppler: the side moving toward us (x < 0 here) is hotter
      const hot = Math.max(0, Math.min(1, 0.5 - x * 0.5));
      const r = Math.round(150 + hot * 105 * (isFront ? 1 : 0.8));
      const g = Math.round(120 + hot * 60 - h * 30);
      const b = Math.round(255 - hot * 150);
      return `rgba(${r},${g},${b},${alpha})`;
    };

    const sparks = (isFront: boolean) => {
      for (const p of disk) {
        const z = Math.sin(p.a);
        if (isFront !== z >= 0) continue;
        const fade = Math.min(1, (p.r - 1.2) * 3) * (1 - (p.r - 1.25) / 3.2);
        ctx.fillStyle = color(Math.cos(p.a), isFront, p.h, 0.7 * fade);
        ctx.fillRect(Math.cos(p.a) * p.r * R, z * p.r * R * TILT, p.s * 1.4, p.s * 0.6);
      }
    };

    function frame() {
      raf = 0;
      if (!back || !front) return;
      if (!still) for (const p of disk) p.a += p.w * 0.012;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(back, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(cx, cy);
      ctx.rotate(ROT);
      ctx.globalCompositeOperation = "lighter";
      sparks(false);
      ctx.globalCompositeOperation = "source-over";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(front, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(cx, cy);
      ctx.rotate(ROT);
      ctx.globalCompositeOperation = "lighter";
      sparks(true);
      ctx.globalCompositeOperation = "source-over";
      if (!still && visible && !document.hidden) raf = requestAnimationFrame(frame);
    }

    const resume = () => {
      if (!still && visible && !document.hidden && !raf) raf = requestAnimationFrame(frame);
    };
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    // only animate while the hero is on screen
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) resume();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
    io.observe(cv);
    document.addEventListener("visibilitychange", resume);
    size();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
