"use client";

// The landing page's black hole: a fixed backdrop that the page scrolls over. As you scroll, the camera falls in: the
// accretion disk opens toward you, turns, the hole drifts across the page and dims behind the content, then comes back
// for the close.
//
// Built for speed. The disk is drawn face-on, once per resize, into four layers (the lensed far side, the back half,
// the shadow with its photon ring, the front half); scrolling only changes CSS transforms on those layers (rotate,
// scaleY for the tilt, translate and scale for the camera), which the GPU composites. Per frame, only the particles
// are redrawn, on two half-disk canvases at 1x. It pauses when the tab is hidden; with reduced motion it stays still.
import { useEffect, useRef } from "react";

type P = { r: number; a: number; w: number; s: number; h: number };
type Pose = { x: number; y: number; scale: number; rot: number; tilt: number; opacity: number };

const RINGS = 4.2; // the disk's outer edge, in shadow radii

/** Where the camera is at each point of the page (0 = top, 1 = bottom). x, y as fractions of the viewport. */
function poses(wide: boolean): [number, Pose][] {
  return wide
    ? [
        [0, { x: 0.66, y: 0.46, scale: 1, rot: -0.32, tilt: 0.21, opacity: 1 }],
        [0.16, { x: 0.52, y: 0.5, scale: 1.9, rot: -0.08, tilt: 0.42, opacity: 0.5 }],
        [0.42, { x: 0.24, y: 0.56, scale: 1.45, rot: 0.3, tilt: 0.78, opacity: 0.3 }],
        [0.72, { x: 0.78, y: 0.44, scale: 1.25, rot: -0.55, tilt: 0.3, opacity: 0.3 }],
        [1, { x: 0.5, y: 0.4, scale: 1.15, rot: -0.22, tilt: 0.19, opacity: 0.9 }],
      ]
    : [
        [0, { x: 0.5, y: 0.3, scale: 1, rot: -0.32, tilt: 0.21, opacity: 1 }],
        [0.2, { x: 0.5, y: 0.45, scale: 1.7, rot: 0, tilt: 0.5, opacity: 0.45 }],
        [0.7, { x: 0.5, y: 0.5, scale: 1.3, rot: 0.35, tilt: 0.7, opacity: 0.3 }],
        [1, { x: 0.5, y: 0.38, scale: 1.1, rot: -0.22, tilt: 0.19, opacity: 0.85 }],
      ];
}

const ease = (t: number) => t * t * (3 - 2 * t);
function poseAt(list: [number, Pose][], p: number): Pose {
  for (let i = 1; i < list.length; i++) {
    const [p1, b] = list[i];
    const [p0, a] = list[i - 1];
    if (p <= p1) {
      const t = ease(Math.max(0, Math.min(1, (p - p0) / (p1 - p0))));
      const mix = (k: keyof Pose) => a[k] + (b[k] - a[k]) * t;
      return { x: mix("x"), y: mix("y"), scale: mix("scale"), rot: mix("rot"), tilt: mix("tilt"), opacity: mix("opacity") };
    }
  }
  return list[list.length - 1][1];
}

export default function Horizon() {
  const root = useRef<HTMLDivElement>(null);
  const cam = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLCanvasElement>(null);
  const backBandEl = useRef<HTMLCanvasElement>(null);
  const back = useRef<HTMLCanvasElement>(null);
  const core = useRef<HTMLCanvasElement>(null);
  const front = useRef<HTMLCanvasElement>(null);
  const frontBandEl = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const disk: P[] = Array.from({ length: 600 }, () => {
      const r = 1.25 + Math.pow(Math.random(), 1.6) * 2.6;
      return { r, a: Math.random() * 6.283, w: 0.9 / Math.pow(r, 1.5), s: Math.random() * 1.4 + 0.8, h: Math.random() };
    });
    let R = 0,
      raf = 0,
      wide = true,
      list = poses(true);
    const cur: Pose = { ...list[0][1] };
    let lastY = window.scrollY,
      spin = 1;

    const grad = (c: CanvasRenderingContext2D, a: number) => {
      const g = c.createLinearGradient(-R * RINGS, 0, R * RINGS, 0);
      g.addColorStop(0, `rgba(255,190,120,${a})`);
      g.addColorStop(0.35, `rgba(255,236,220,${Math.min(1, a * 1.2)})`);
      g.addColorStop(0.6, `rgba(196,178,255,${a})`);
      g.addColorStop(1, `rgba(109,124,255,${a * 0.7})`);
      return g;
    };
    const fit = (cv: HTMLCanvasElement, w: number, h: number, dpr = 1) => {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      cv.style.marginLeft = `${-w / 2}px`;
      const c = cv.getContext("2d")!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      return c;
    };
    // a half of the disk, face-on: rings blurred into a glowing sheet (upper half = far side)
    // a half of the disk, face-on, drawn once at up to 2x so it stays sharp when the camera zooms in: many thin rings
    // blurred into one glowing sheet (upper half = the far side)
    const band = (cv: HTMLCanvasElement, isFront: boolean) => {
      const W = R * RINGS * 2;
      const c = fit(cv, W, R * RINGS, Math.min(2, (window.devicePixelRatio || 1) * 1.5));
      c.translate(W / 2, isFront ? 0 : R * RINGS);
      c.globalCompositeOperation = "lighter";
      c.filter = `blur(${Math.max(2, R / 40)}px)`;
      for (let k = 0; k < 90; k++) {
        const f = k / 89;
        const r = 1.32 + f * 2.9;
        c.strokeStyle = grad(c, (1 - f) * (1 - f) * (isFront ? 0.36 : 0.24) * (0.8 + 0.2 * Math.sin(k * 1.3)));
        c.lineWidth = (1.4 + (1 - f) * 2.2) / 0.45; // drawn face-on, then squashed by the tilt: thicker strokes keep their weight
        c.beginPath();
        c.arc(0, 0, r * R, isFront ? 0 : Math.PI, isFront ? Math.PI : 2 * Math.PI);
        c.stroke();
      }
      cv.style.marginTop = isFront ? "0px" : `${-R * RINGS}px`;
    };

    const build = () => {
      const vw = window.innerWidth,
        vh = window.innerHeight;
      wide = vw > 900;
      list = poses(wide);
      R = Math.min(vw * (wide ? 0.09 : 0.14), vh * 0.13);
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const W = R * RINGS * 2;
      // lensed far side: arcs bent up over the shadow (and a thin image under it), drawn in the disk's turned frame
      const lc = fit(lens.current!, W, W, dpr);
      lc.translate(W / 2, W / 2);
      lc.globalCompositeOperation = "lighter";
      lc.filter = "blur(3px)";
      for (let k = 0; k < 22; k++) {
        const f = k / 21;
        const r = 1.08 + f * 1.5;
        lc.strokeStyle = grad(lc, (1 - f) * (1 - f) * 0.75);
        lc.lineWidth = 2 + (1 - f) * 3;
        lc.beginPath();
        lc.ellipse(0, 0, r * R, r * R * 0.92, 0, Math.PI * 1.02, Math.PI * 1.98);
        lc.stroke();
      }
      for (let k = 0; k < 8; k++) {
        const r = 1.06 + (k / 7) * 0.35;
        lc.strokeStyle = grad(lc, 0.3 * (1 - k / 8));
        lc.lineWidth = 1;
        lc.beginPath();
        lc.ellipse(0, 0, r * R, r * R * 0.9, 0, Math.PI * 0.1, Math.PI * 0.9);
        lc.stroke();
      }
      lens.current!.style.marginTop = `${-W / 2}px`;
      // the shadow and the photon ring
      const S = R * 3;
      const cc = fit(core.current!, S, S, dpr);
      cc.translate(S / 2, S / 2);
      const glow = cc.createRadialGradient(0, 0, R * 0.9, 0, 0, R * 1.5);
      glow.addColorStop(0, "rgba(196,178,255,0.35)");
      glow.addColorStop(1, "rgba(196,178,255,0)");
      cc.fillStyle = glow;
      cc.fillRect(-S / 2, -S / 2, S, S);
      cc.beginPath();
      cc.arc(0, 0, R, 0, 6.283);
      cc.fillStyle = "#020106";
      cc.fill();
      cc.lineWidth = 1.6;
      cc.strokeStyle = "rgba(240,232,255,0.95)";
      cc.shadowColor = "rgba(196,178,255,1)";
      cc.shadowBlur = 22;
      cc.beginPath();
      cc.arc(0, 0, R * 1.03, 0, 6.283);
      cc.stroke();
      core.current!.style.marginTop = `${-S / 2}px`;
      // the two halves of the disk: bands drawn once, particles on their own layers, redrawn every frame
      band(backBandEl.current!, false);
      band(frontBandEl.current!, true);
      fit(back.current!, W, R * RINGS);
      fit(front.current!, W, R * RINGS);
      back.current!.style.marginTop = `${-R * RINGS}px`;
      front.current!.style.marginTop = "0px";
      draw();
    };

    const color = (x: number, isFront: boolean, h: number, alpha: number) => {
      const hot = Math.max(0, Math.min(1, 0.5 - x * 0.5));
      const r = Math.round(150 + hot * 105 * (isFront ? 1 : 0.8));
      const g = Math.round(120 + hot * 60 - h * 30);
      const b = Math.round(255 - hot * 150);
      return `rgba(${r},${g},${b},${alpha})`;
    };
    const half = (cv: HTMLCanvasElement, isFront: boolean) => {
      const c = cv.getContext("2d")!;
      const W = R * RINGS * 2;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      c.translate(W / 2, isFront ? 0 : R * RINGS);
      c.globalCompositeOperation = "lighter";
      for (const p of disk) {
        const z = Math.sin(p.a);
        if (isFront !== z >= 0) continue;
        const fade = Math.min(1, (p.r - 1.2) * 3) * (1 - (p.r - 1.25) / 3.2);
        c.fillStyle = color(Math.cos(p.a), isFront, p.h, 0.75 * fade);
        c.fillRect(Math.cos(p.a) * p.r * R, z * p.r * R, p.s * 1.4, p.s * 1.4);
      }
      c.globalCompositeOperation = "source-over";
    };
    const draw = () => {
      half(back.current!, false);
      half(front.current!, true);
    };

    // the camera: follow the scroll with a little lag, so it glides
    const place = (snap = false) => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const target = poseAt(list, still ? 0 : Math.min(1, window.scrollY / max));
      const k = snap ? 1 : 0.12;
      (Object.keys(cur) as (keyof Pose)[]).forEach((key) => (cur[key] += (target[key] - cur[key]) * k));
      const vw = window.innerWidth,
        vh = window.innerHeight;
      cam.current!.style.transform = `translate3d(${cur.x * vw}px, ${cur.y * vh}px, 0) scale(${cur.scale})`;
      root.current!.style.opacity = String(cur.opacity);
      const disk = `rotate(${cur.rot}rad) scaleY(${cur.tilt})`;
      for (const [el, origin] of [
        [backBandEl, "50% 100%"],
        [back, "50% 100%"],
        [front, "50% 0%"],
        [frontBandEl, "50% 0%"],
      ] as const) {
        el.current!.style.transform = disk;
        el.current!.style.transformOrigin = origin;
      }
      // the far side's lensed image turns with the disk and opens a little as the disk does
      lens.current!.style.transform = `rotate(${cur.rot}rad) scaleY(${0.75 + cur.tilt * 0.4})`;
      return Math.abs(target.scale - cur.scale) + Math.abs(target.rot - cur.rot) + Math.abs(target.tilt - cur.tilt) > 0.0005;
    };

    const frame = () => {
      raf = 0;
      if (document.hidden) return;
      const y = window.scrollY;
      // spin a little faster while scrolling
      spin += (1 + Math.min(4, Math.abs(y - lastY) / 30) - spin) * 0.1;
      lastY = y;
      const moving = place();
      if (!still) {
        for (const p of disk) p.a += p.w * 0.012 * spin;
        draw();
      }
      if (!still || moving) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    };

    build();
    place(true);
    kick();
    const onResize = () => (build(), place(true));
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", kick, { passive: true });
    document.addEventListener("visibilitychange", kick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", kick);
      document.removeEventListener("visibilitychange", kick);
    };
  }, []);

  return (
    <div ref={root} className="bh" aria-hidden="true">
      <div ref={cam} className="bh-cam">
        <canvas ref={lens} className="bh-layer" />
        <canvas ref={backBandEl} className="bh-layer" />
        <canvas ref={back} className="bh-layer" />
        <canvas ref={core} className="bh-layer" />
        <canvas ref={frontBandEl} className="bh-layer" />
        <canvas ref={front} className="bh-layer" />
      </div>
    </div>
  );
}
