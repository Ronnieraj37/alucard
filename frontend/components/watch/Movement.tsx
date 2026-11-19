"use client";

const rc = (a: number) => Math.round(Math.cos(a) * 1e6) / 1e6;
const rs = (a: number) => Math.round(Math.sin(a) * 1e6) / 1e6;

// The movement: an authored drawing of an automatic watch movement, seen through the caseback. Wheels turn at their
// gear ratios, the balance swings, the rotor winds. The bridges are engraved with the parts of a rule.

type Wheel = { x: number; y: number; teeth: number; r: number; period: number; dir: 1 | -1; spokes?: number };

const C = 300; // centre of a 600 x 600 drawing

function gearPath(teeth: number, r: number) {
  const depth = Math.max(5, r * 0.07);
  const rIn = r - depth;
  const pts: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const ang = [a0, a0 + step * 0.15, a0 + step * 0.35, a0 + step * 0.5, a0 + step * 0.65, a0 + step * 0.85];
    const rad = [rIn, r, r, r, rIn, rIn];
    ang.forEach((a, k) => {
      const rr = k === 3 ? r : rad[k];
      pts.push(`${(rc(a) * rr).toFixed(2)},${(rs(a) * rr).toFixed(2)}`);
    });
  }
  return `M${pts.join("L")}Z`;
}

function escapePath(r: number) {
  // club-tooth escape wheel, 15 teeth
  const pts: string[] = [];
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * Math.PI * 2;
    const s = (Math.PI * 2) / 15;
    const p = (rr: number, aa: number) => `${(rc(aa) * rr).toFixed(2)},${(rs(aa) * rr).toFixed(2)}`;
    pts.push(p(r * 0.72, a), p(r, a + s * 0.42), p(r * 0.94, a + s * 0.62), p(r * 0.72, a + s * 0.55));
  }
  return `M${pts.join("L")}Z`;
}

function WheelG({ w, children }: { w: Wheel; children?: React.ReactNode }) {
  const spokes = w.spokes ?? 5;
  return (
    <g transform={`translate(${w.x} ${w.y})`}>
      <g className="mv-spin" style={{ animationDuration: `${w.period}s`, animationDirection: w.dir === 1 ? "normal" : "reverse" }}>
        <path d={gearPath(w.teeth, w.r)} className="mv-wheel" />
        <circle r={w.r * 0.74} className="mv-rim" />
        {Array.from({ length: spokes }, (_, k) => {
          const a = (k / spokes) * Math.PI * 2;
          return <line key={k} x1={rc(a) * w.r * 0.2} y1={rs(a) * w.r * 0.2} x2={rc(a) * w.r * 0.74} y2={rs(a) * w.r * 0.74} className="mv-spoke" />;
        })}
        <circle r={w.r * 0.2} className="mv-hub" />
        {children}
      </g>
      <Jewel />
    </g>
  );
}

function Jewel({ x = 0, y = 0, r = 5.5 }: { x?: number; y?: number; r?: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r + 3} className="mv-chaton" />
      <circle r={r} className="mv-jewel" />
      <circle r={r * 0.35} cx={-r * 0.3} cy={-r * 0.3} className="mv-jewel-hi" />
    </g>
  );
}

function Screw({ x, y, a = 20 }: { x: number; y: number; a?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${a})`}>
      <circle r="7" className="mv-screw" />
      <line x1="-6" x2="6" className="mv-slot" />
    </g>
  );
}

// a bridge outline with Geneva stripes clipped inside it
function Bridge({ id, d, label, lx, ly, la = 0 }: { id: string; d: string; label: string; lx: number; ly: number; la?: number }) {
  return (
    <g>
      <clipPath id={`clip-${id}`}>
        <path d={d} />
      </clipPath>
      <path d={d} className="mv-bridge" />
      <g clipPath={`url(#clip-${id})`}>
        {Array.from({ length: 30 }, (_, k) => (
          <rect key={k} x={-40 + k * 26} y="-40" width="13" height="700" className="mv-stripe" transform="rotate(-28 300 300)" />
        ))}
      </g>
      <path d={d} className="mv-bridge-edge" />
      <text x={lx} y={ly} transform={`rotate(${la} ${lx} ${ly})`} className="mv-engrave">
        {label}
      </text>
    </g>
  );
}

const W: Record<string, Wheel> = {
  barrel: { x: 205, y: 215, teeth: 84, r: 92, period: 220, dir: 1, spokes: 0 },
  centre: { x: 300, y: 300, teeth: 64, r: 58, period: 60, dir: -1 },
  third: { x: 392, y: 245, teeth: 60, r: 44, period: 22, dir: 1 },
  fourth: { x: 418, y: 345, teeth: 56, r: 38, period: 8, dir: -1 },
};

export default function Movement({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 600 600" className={`mv ${className}`} role="img" aria-label="A watch movement whose parts are engraved When, Then, Limits and Keeper">
      <defs>
        <radialGradient id="mv-plate" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#f0f2f4" />
          <stop offset="100%" stopColor="#d9dde2" />
        </radialGradient>
        <path id="mv-ring" d={`M ${C} ${C} m -258 0 a 258 258 0 1 1 516 0 a 258 258 0 1 1 -516 0`} />
      </defs>

      {/* case and main plate with perlage */}
      <circle cx={C} cy={C} r="296" className="mv-case" />
      <circle cx={C} cy={C} r="276" fill="url(#mv-plate)" className="mv-plate" />
      {Array.from({ length: 140 }, (_, k) => {
        const a = k * 2.399963;
        const rr = 34 * Math.sqrt(k + 1);
        if (rr > 262) return null;
        return <circle key={k} cx={C + rc(a) * rr} cy={C + rs(a) * rr} r="13" className="mv-perlage" />;
      })}
      <text className="mv-ring-text">
        <textPath href="#mv-ring" startOffset="2%">
          ALUCARD · AUTOMATIC · ADJUSTED TO 79,682 RULE SHAPES · FUNDS NEVER LEAVE UNISWAP ·
        </textPath>
      </text>

      {/* wheel train under the bridges */}
      <WheelG w={W.barrel} />
      <WheelG w={W.centre} />
      <WheelG w={W.third} />
      <WheelG w={W.fourth} />
      {/* escape wheel */}
      <g transform="translate(372 432)">
        <g className="mv-spin mv-tick" style={{ animationDuration: "3s" }}>
          <path d={escapePath(30)} className="mv-wheel" />
          <circle r="7" className="mv-hub" />
        </g>
        <Jewel />
      </g>

      {/* bridges, engraved with the parts of a rule */}
      <Bridge id="barrel" d="M110,150 C140,95 250,90 300,135 L320,190 C300,250 250,290 190,300 C140,300 100,260 100,215 Z" label="WHEN" lx={150} ly={178} la={-14} />
      <Bridge id="train" d="M330,190 C380,170 450,190 470,250 L470,360 C450,395 410,400 385,385 L330,300 Z" label="THEN" lx={398} ly={292} la={78} />
      <Bridge id="limits" d="M160,330 C200,320 250,345 268,385 L262,430 C240,452 190,452 165,430 C145,405 145,355 160,330 Z" label="LIMITS" lx={180} ly={392} la={-8} />
      <Screw x={128} y={170} a={35} />
      <Screw x={290} y={150} a={-10} />
      <Screw x={455} y={232} a={70} />
      <Screw x={452} y={350} a={15} />
      <Screw x={180} y={345} a={-40} />
      <Screw x={250} y={425} a={10} />
      <Jewel x={205} y={215} r={6.5} />
      <Jewel x={392} y={245} />
      <Jewel x={418} y={345} />
      <Jewel x={300} y={300} r={7} />
      <Jewel x={212} y={395} r={4.5} />

      {/* balance wheel and hairspring under its cock */}
      <g transform="translate(300 470)">
        <path d={Array.from({ length: 9 }, (_, k) => `M0,0 m${-(6 + k * 3.6)},0 a${6 + k * 3.6},${6 + k * 3.6} 0 1,0 ${2 * (6 + k * 3.6)},0`).join(" ")} className="mv-hairspring mv-breathe" />
        <g className="mv-balance">
          <circle r="54" className="mv-balance-rim" />
          {[0, 1, 2].map((k) => {
            const a = (k / 3) * Math.PI * 2 + 0.3;
            return <line key={k} x1="0" y1="0" x2={rc(a) * 54} y2={rs(a) * 54} className="mv-balance-arm" />;
          })}
          {Array.from({ length: 12 }, (_, k) => {
            const a = (k / 12) * Math.PI * 2;
            return <circle key={k} cx={rc(a) * 54} cy={rs(a) * 54} r="2.4" className="mv-screw-sm" />;
          })}
        </g>
        <path d="M-70,-36 C-40,-60 40,-60 70,-36 L28,6 C14,16 -14,16 -28,6 Z" className="mv-cock" />
        <text x="0" y="-30" textAnchor="middle" className="mv-engrave">KEEPER</text>
        <Jewel r={6} />
      </g>

      {/* the rotor: winds itself from movement */}
      <g className="mv-rotor-wrap">
        <g className="mv-rotor">
          <path d={`M${C - 250},${C} A250,250 0 0,1 ${C + 250},${C} L${C + 160},${C} A160,160 0 0,0 ${C - 160},${C} Z`} className="mv-rotor-body" />
          <text x={C} y={C - 196} textAnchor="middle" className="mv-rotor-text">ALUCARD</text>
          <text x={C} y={C - 178} textAnchor="middle" className="mv-engrave mv-engrave-sm">RULES FOR UNISWAP V4 POSITIONS</text>
        </g>
        <circle cx={C} cy={C} r="16" className="mv-hub" />
        <Jewel x={C} y={C} r={6} />
      </g>
    </svg>
  );
}
