"use client";

import { useEffect, useRef } from "react";

// The page's one living field: a night sky with a moon, slow mist and stars, drawn by a single fragment shader.
// The mouse tilts it slightly, scrolling lowers the moon. Reduced motion draws one still frame.

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse; uniform float uScroll;

float h(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0., a = .5; mat2 m = mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<5;i++){ v += a*n(p); p = m*p; a *= .5; } return v; }
float stars(vec2 uv, float s, float keep, float t){ vec2 g = uv*s, id = floor(g), f = fract(g)-.5; float r = h(id);
  if(r < keep) return 0.; vec2 o = vec2(h(id+3.1), h(id+7.7))-.5; float d = length(f - o*.7);
  float tw = .65 + .35*sin(t*(1.+r*3.) + r*40.); return smoothstep(.08, 0., d) * (r-keep)/(1.-keep) * tw; }

void main(){
  vec2 uv = (gl_FragCoord.xy - .5*uRes) / uRes.y;
  vec2 p = uv + uMouse*.02;
  float t = uTime;

  // sky: deep indigo at the top, a faint warm haze near the horizon
  vec3 top = vec3(.018,.022,.055), low = vec3(.055,.045,.09);
  vec3 col = mix(low, top, smoothstep(-.6, .7, uv.y));

  // moon: high on the right, sinking as you scroll
  vec2 mc = vec2(.74 + uScroll*.4, .3 - uScroll*2.4);
  float md = length(p - mc);
  float disc = smoothstep(.092, .086, md);
  float shade = fbm((p-mc)*14.) * .22;
  vec3 moon = vec3(.94,.91,.85) - shade;
  col += vec3(.95,.82,.72) * .22 * exp(-md*5.5);         // halo
  col += vec3(.75,.6,.6) * .07 * exp(-md*1.8);           // wide glow
  col = mix(col, moon, disc);

  // mist: slow drifting bands, tinted crimson where they pass the moon
  vec2 q = p*1.4 + vec2(t*.008, uScroll*.4);
  float m = fbm(q + fbm(q*1.7 + t*.01));
  float band = smoothstep(.45, .85, m) * smoothstep(.55, -.35, uv.y);
  col += mix(vec3(.10,.08,.20), vec3(.36,.06,.10), exp(-md*2.2)) * band * .55;

  // stars, hidden behind the moon and fading near the horizon
  float s = stars(p, 70., .965, t) + stars(p + 4.2, 140., .985, t*1.3)*.7;
  col += vec3(.9,.92,1.) * s * (1.-disc) * smoothstep(-.45, .2, uv.y);

  // vignette
  col *= 1. - .35*dot(uv*.75, uv*.75);
  gl_FragColor = vec4(col, 1.);
}`;

export default function NightSky() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uMouse = gl.getUniformLocation(prog, "uMouse");
    const uScroll = gl.getUniformLocation(prog, "uScroll");

    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    let raf = 0;
    let visible = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.floor(window.innerWidth * dpr * 0.9);
      canvas.height = Math.floor(window.innerHeight * dpr * 0.9);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const onMove = (e: PointerEvent) => {
      mouse.tx = e.clientX / window.innerWidth - 0.5;
      mouse.ty = 0.5 - e.clientY / window.innerHeight;
    };
    const t0 = performance.now();
    const frame = () => {
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      const scroll = Math.min(1, window.scrollY / Math.max(1, document.body.scrollHeight - window.innerHeight));
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - t0) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uScroll, scroll);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!calm && visible) raf = requestAnimationFrame(frame);
    };
    const onVis = () => {
      visible = document.visibilityState === "visible";
      cancelAnimationFrame(raf);
      if (visible) raf = requestAnimationFrame(frame);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove);
    document.addEventListener("visibilitychange", onVis);
    if (calm) window.addEventListener("scroll", frame, { passive: true });
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", frame);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 h-full w-full" />;
}
