"use client";

// The hero's black hole, drawn on a canvas: a starfield, a tilted accretion disk of particles (violet on the cool
// side, ember on the side coming toward us), the far side of the disk lensed over the top, a photon ring and the
// shadow. Pointer movement tilts it a little. With reduced motion it renders one still frame.
import { useEffect, useRef } from "react";

type P = { r: number; a: number; w: number; s: number; h: number };

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
      t = 0,
      tiltX = 0,
      tiltT = 0;
    const stars = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.2 + 0.2, p: Math.random() * 6.28 }));
    const disk: P[] = Array.from({ length: 1400 }, () => {
      const r = 1.25 + Math.pow(Math.random(), 1.6) * 2.6; // in shadow radii
      return { r, a: Math.random() * 6.283, w: 0.9 / Math.pow(r, 1.5), s: Math.random() * 1.4 + 0.4, h: Math.random() };
    });

    const size = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const b = cv.getBoundingClientRect();
      W = b.width;
      H = b.height;
      cv.width = W * dpr;
      cv.height = H * dpr;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    const move = (e: PointerEvent) => {
      tiltT = (e.clientY / window.innerHeight - 0.5) * 0.12;
    };
    window.addEventListener("pointermove", move);

    const color = (x: number, front: boolean, h: number, alpha: number) => {
      // doppler: the side moving toward us (x < 0 here) is hotter
      const hot = Math.max(0, Math.min(1, 0.5 - x * 0.5));
      const r = Math.round(150 + hot * 105 * (front ? 1 : 0.8));
      const g = Math.round(120 + hot * 60 - h * 30);
      const b = Math.round(255 - hot * 150);
      return `rgba(${r},${g},${b},${alpha})`;
    };

    const frame = () => {
      t += 1;
      tiltX += (tiltT - tiltX) * 0.04;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const wide = W > 900;
      const cx = wide ? W * 0.66 : W * 0.5,
        cy = wide ? H * 0.46 : H * 0.3,
        R = Math.min(W * (wide ? 0.09 : 0.14), H * 0.13); // shadow radius
      const tilt = 0.21 + tiltX; // how flat the disk looks
      const rot = -0.32; // the disk's angle on screen

      // stars, bent a little near the hole
      for (const s of stars) {
        let x = s.x * W,
          y = s.y * H;
        const dx = x - cx,
          dy = y - cy,
          d = Math.hypot(dx, dy);
        if (d < R * 1.05) continue;
        const push = (R * R * 1.4) / d;
        x += (dx / d) * push * 0.6;
        y += (dy / d) * push * 0.6;
        const a = 0.35 + 0.35 * Math.sin(s.p + t * 0.02);
        ctx.fillStyle = `rgba(220,215,255,${a})`;
        ctx.fillRect(x, y, s.r, s.r);
      }

      // glow
      const g = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 5);
      g.addColorStop(0, "rgba(139,108,255,0.35)");
      g.addColorStop(0.4, "rgba(109,124,255,0.08)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.globalCompositeOperation = "lighter";
      // the disk's colour across it: the side coming toward us (left) runs hot
      const grad = (a: number) => {
        const gr = ctx.createLinearGradient(-R * 4.2, 0, R * 4.2, 0);
        gr.addColorStop(0, `rgba(255,190,120,${a})`);
        gr.addColorStop(0.35, `rgba(255,236,220,${a * 1.2})`);
        gr.addColorStop(0.6, `rgba(196,178,255,${a})`);
        gr.addColorStop(1, `rgba(109,124,255,${a * 0.7})`);
        return gr;
      };
      const rings = 46;
      const band = (front: boolean) => {
        ctx.filter = "blur(2.5px)";
        for (let k = 0; k < rings; k++) {
          const f = k / (rings - 1);
          const r = 1.32 + f * 2.9;
          const a = (1 - f) * (1 - f) * (front ? 0.7 : 0.45) * (0.7 + 0.3 * Math.sin(k * 1.7 + t * 0.03));
          ctx.strokeStyle = grad(a);
          ctx.lineWidth = 1.6 + (1 - f) * 2.4;
          ctx.beginPath();
          // front: the half below the centre line (nearer to us); back: the half above
          if (front) ctx.ellipse(0, 0, r * R, r * R * tilt, 0, 0, Math.PI);
          else ctx.ellipse(0, 0, r * R, r * R * tilt, 0, Math.PI, 2 * Math.PI);
          ctx.stroke();
        }
        ctx.filter = "none";
      };
      const lensed = () => {
        ctx.filter = "blur(3px)";
        // the far side of the disk, bent up over the shadow (and a thin image under it)
        for (let k = 0; k < 26; k++) {
          const f = k / 25;
          const r = 1.08 + f * 1.5;
          ctx.strokeStyle = grad((1 - f) * (1 - f) * 0.75);
          ctx.lineWidth = 2 + (1 - f) * 3;
          ctx.beginPath();
          ctx.ellipse(0, 0, r * R, r * R * 0.92, 0, Math.PI * 1.02, Math.PI * 1.98);
          ctx.stroke();
        }
        for (let k = 0; k < 10; k++) {
          const r = 1.06 + (k / 9) * 0.35;
          ctx.strokeStyle = grad(0.3 * (1 - k / 10));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(0, 0, r * R, r * R * 0.9, 0, Math.PI * 0.1, Math.PI * 0.9);
          ctx.stroke();
        }
        ctx.filter = "none";
      };
      const sparks = (front: boolean) => {
        for (const p of disk) {
          if (!still) p.a += p.w * 0.012;
          const z = Math.sin(p.a);
          if (front !== z >= 0) continue;
          const x = Math.cos(p.a) * p.r * R,
            y = z * p.r * R * tilt;
          const fade = Math.min(1, (p.r - 1.2) * 3) * (1 - (p.r - 1.25) / 3.2);
          ctx.fillStyle = color(Math.cos(p.a), front, p.h, 0.7 * fade);
          ctx.fillRect(x, y, p.s * 1.4, p.s * 0.6);
        }
      };
      lensed();
      band(false);
      sparks(false);
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, 6.283);
      ctx.fillStyle = "#020106";
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "rgba(240,232,255,0.95)";
      ctx.shadowColor = "rgba(196,178,255,1)";
      ctx.shadowBlur = 22;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.03, 0, 6.283);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "lighter";
      band(true);
      sparks(true);
      ctx.restore();
      if (!still) raf = requestAnimationFrame(frame);
    };
    frame();
    const vis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", move);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
