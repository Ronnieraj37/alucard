"use client";

import { useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { conditionalOrdersAbi } from "@/lib/generated/abis";
import { CORE, poolByIndex } from "@/lib/pools";

// ---------------------------------------------------------------- range and sides (for users)

export function RangeSides() {
  return (
    <figure className="my-6 rounded-[14px] border border-[var(--line)] bg-white p-5">
      <svg viewBox="0 0 640 170" className="w-full" role="img" aria-label="A price range with a lower side that acts when the price falls below it and an upper side that acts when it rises above it">
        <defs>
          <linearGradient id="rng" x1="0" x2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0.16" />
          </linearGradient>
        </defs>
        {/* price axis */}
        <line x1="20" y1="120" x2="620" y2="120" stroke="var(--line)" strokeWidth="2" />
        <text x="20" y="150" fontSize="11" fill="var(--muted)">lower prices</text>
        <text x="620" y="150" fontSize="11" fill="var(--muted)" textAnchor="end">higher prices</text>
        {/* range */}
        <rect x="230" y="40" width="180" height="80" rx="8" fill="url(#rng)" stroke="var(--accent)" strokeOpacity="0.5" />
        <text x="320" y="70" fontSize="13" fontWeight="600" fill="var(--ink)" textAnchor="middle">Your range</text>
        <text x="320" y="88" fontSize="11" fill="var(--muted)" textAnchor="middle">earns fees while the price is here</text>
        <line x1="300" y1="30" x2="300" y2="126" stroke="var(--ink)" strokeWidth="1.5" />
        <text x="300" y="24" fontSize="11" fill="var(--ink)" textAnchor="middle">price now</text>
        {/* sides */}
        <g>
          <rect x="30" y="56" width="180" height="48" rx="10" fill="var(--rose-lt)" stroke="var(--rose)" strokeOpacity="0.35" />
          <text x="120" y="76" fontSize="12" fontWeight="600" fill="var(--rose)" textAnchor="middle">Lower side</text>
          <text x="120" y="93" fontSize="11" fill="var(--muted)" textAnchor="middle">“if the price falls…”</text>
        </g>
        <g>
          <rect x="430" y="56" width="180" height="48" rx="10" fill="var(--sage-lt)" stroke="var(--sage)" strokeOpacity="0.35" />
          <text x="520" y="76" fontSize="12" fontWeight="600" fill="var(--sage)" textAnchor="middle">Upper side</text>
          <text x="520" y="93" fontSize="11" fill="var(--muted)" textAnchor="middle">“if the price rises…”</text>
        </g>
      </svg>
      <figcaption className="mt-2 text-center text-[12px] text-[var(--muted)]">
        Each side holds one rule: a trigger, the steps to run, and whether to repeat. Either side can be left empty.
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- architecture (for developers)

export function Architecture() {
  const box = (x: number, y: number, w: number, title: string, sub: string, dark = false) => (
    <g>
      <rect x={x} y={y} width={w} height="56" rx="10" fill={dark ? "var(--ink)" : "white"} stroke={dark ? "var(--ink)" : "var(--line)"} />
      <text x={x + w / 2} y={y + 24} fontSize="13" fontWeight="600" fill={dark ? "white" : "var(--ink)"} textAnchor="middle">
        {title}
      </text>
      <text x={x + w / 2} y={y + 41} fontSize="10.5" fill={dark ? "rgba(255,255,255,0.65)" : "var(--muted)"} textAnchor="middle">
        {sub}
      </text>
    </g>
  );
  const arrow = (d: string, label: string, lx: number, ly: number) => (
    <g>
      <path d={d} fill="none" stroke="var(--muted2)" strokeWidth="1.5" markerEnd="url(#arr)" />
      <text x={lx} y={ly} fontSize="10.5" fill="var(--muted)" textAnchor="middle">
        {label}
      </text>
    </g>
  );
  return (
    <figure className="my-6 overflow-x-auto rounded-[14px] border border-[var(--line)] bg-[var(--paper)] p-4">
      <svg viewBox="0 0 720 330" className="min-w-[620px] w-full" role="img" aria-label="Architecture: LPs and keepers call ConditionalOrders, which asks Rules (and PriceFeeds) before acting; swappers call the router; both reach the Uniswap PoolManager, which calls RuleHook">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted2)" />
          </marker>
        </defs>
        {box(20, 20, 150, "LP (owner)", "create · update · cancel")}
        {box(20, 130, 150, "Keeper (anyone)", "execute when ready")}
        {box(20, 240, 150, "Swapper", "trades through a router")}
        {box(270, 60, 190, "ConditionalOrders", "holds positions with a strategy", true)}
        {box(270, 150, 190, "Rules", "conditions · checks · price math")}
        {box(540, 260, 160, "PriceFeeds", "Chainlink list · 2-day timelock")}
        {arrow("M365 116 L365 148", "asks", 382, 136)}
        {arrow("M460 190 C 500 200, 510 250, 538 280", "Chainlink", 486, 238)}
        {box(270, 240, 190, "Router / Quoter", "Uniswap periphery")}
        {box(540, 150, 160, "PoolManager", "Uniswap v4 core")}
        {box(540, 20, 160, "RuleHook", "pool table · limit orders", true)}
        {arrow("M170 48 C 220 48, 230 80, 268 84", "createOrder", 215, 56)}
        {arrow("M170 158 C 220 158, 230 110, 268 104", "execute", 213, 152)}
        {arrow("M170 268 L268 268", "swap", 220, 262)}
        {arrow("M460 96 C 500 96, 510 165, 538 172", "modifyLiquidity · swap", 500, 118)}
        {arrow("M460 268 C 500 268, 510 200, 538 192", "swap", 505, 250)}
        {arrow("M620 150 L620 78", "before/afterSwap", 668, 118)}
        {arrow("M540 48 C 500 48, 480 60, 462 72", "pool table, average price", 492, 34)}
      </svg>
      <figcaption className="mt-1 text-[12px] text-[var(--muted)]">
        The money stays in Uniswap v4 until the owner withdraws: ConditionalOrders holds the positions (and tokens held during a move) inside the PoolManager.
        RuleHook runs only inside swaps of the pools that use it: it keeps their average price and fills limit orders.
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- bit layout of the order word

type F = { name: string; from: number; bits: number; color: string; desc: string };

const SIDE: F[] = [
  { name: "edge", from: 0, bits: 24, color: "#0a9a8b", desc: "int24. The position's boundary: tickLower in the lower side's slot, tickUpper in the upper side's. Moves when the order re-ranges." },
  { name: "checker", from: 24, bits: 6, color: "#0b1f2a", desc: "Condition A: 0 off, 1 EDGE (price leaves the range), 2 TICK (a price level), 3 TIME (a timer), 4 TRAIL (trailing stop), 5 ORACLE (the pair's Chainlink price reaches a level), 6 FEES (fees earned), 7 APR (fee rate below). 6 bits leave room for 56 more." },
  { name: "value", from: 30, bits: 24, color: "#6d5bd0", desc: "int24, condition A's number. EDGE: ticks past the edge. TICK and ORACLE: the trigger tick. TIME: minutes. TRAIL: ticks back from the best price seen. FEES: bps of the position. APR: bps a year." },
  { name: "checkPool", from: 54, bits: 24, color: "#b5651d", desc: "uint24 pool condition A reads (TICK, TRAIL). 0 = the order's own pool." },
  { name: "checker2", from: 78, bits: 6, color: "#334155", desc: "Condition B, same kinds as A. 0 = no condition B." },
  { name: "value2", from: 84, bits: 24, color: "#8b7be0", desc: "int24, condition B's number." },
  { name: "checkPool2", from: 108, bits: 24, color: "#d08a4a", desc: "uint24 pool condition B reads." },
  { name: "combine", from: 132, bits: 2, color: "#0f766e", desc: "0 = A only, 1 = A and B, 2 = A or B." },
  { name: "holdMinutes", from: 134, bits: 16, color: "#9333ea", desc: "Pool price conditions read the average over this many minutes (1-60; 0 = the 2-minute minimum)." },
  { name: "lastRun", from: 150, bits: 24, color: "#a16207", desc: "Last run (or when the order started or entered this leg), minutes since 2026-01-01 (rounded up, valid until 2057). Timers count from here; a side runs at most once a minute after it." },
  { name: "best", from: 174, bits: 24, color: "#be185d", desc: "int24, the best average tick a trailing stop has seen. Moved by poke." },
  { name: "actions", from: 198, bits: 8, color: "#2563eb", desc: "Bit 0 keep fees in the order, bit 1 remove, bit 2 swap, bit 3 add, bit 4 move to the other leg. Run in that order. Bits 5-7 spare." },
  { name: "removeBps", from: 206, bits: 14, color: "#15803d", desc: "How much liquidity to remove, 0-10,000 (= 0-100%)." },
  { name: "swapToToken1", from: 220, bits: 1, color: "#c026d3", desc: "Swap direction: true sells token0 for token1." },
  { name: "addMode", from: 221, bits: 3, color: "#0891b2", desc: "0 = add back to the same range, 1 = one-sided range next to the price (follow the price)." },
  { name: "repeat", from: 224, bits: 1, color: "#dc2626", desc: "Run again next time. Without it, the side clears itself after running." },
  { name: "runsLeft", from: 225, bits: 7, color: "#ea580c", desc: "With repeat: runs left before the side switches off. 0 = no limit." },
  { name: "shape", from: 232, bits: 22, color: "#65a30d", desc: "With add: widthBelow (bits 0-10) and widthAbove (bits 11-21), in tick spacings. Without add: the step a repeating price level moves by." },
  { name: "spare", from: 254, bits: 2, color: "#cbd5e1", desc: "Unused, always zero." },
];

const SLOT0: F[] = [
  { name: "owner", from: 0, bits: 160, color: "#0b1f2a", desc: "address. Who can update and cancel, and who receives every payout." },
  { name: "poolIndex", from: 160, bits: 24, color: "#0a9a8b", desc: "uint24 index in RuleHook's pool table: the pool holding the position." },
  { name: "swapPoolIndex", from: 184, bits: 24, color: "#6d5bd0", desc: "uint24 pool used for instant swaps (same pair; may be a hookless pool)." },
  { name: "expiry", from: 208, bits: 32, color: "#b5651d", desc: "uint32 unix time. After it, rules stop and anyone may cancel (tokens go to the owner)." },
  { name: "maxKeeperFeeBps", from: 240, bits: 8, color: "#2563eb", desc: "uint8, at most 100 (1%). Ceiling on a keeper's pay per run, in bps of what the run removed." },
  { name: "maxSlippage", from: 248, bits: 8, color: "#dc2626", desc: "uint8, in steps of 10 ticks (~0.1%). Instant swaps stop this far past the trigger price." },
];

export function BitMap({ which }: { which: "side" | "slot0" }) {
  const fields = which === "side" ? SIDE : SLOT0;
  const total = 256;
  const [hover, setHover] = useState<F>(fields[1]);
  return (
    <figure className="my-6 rounded-[14px] border border-[var(--line)] bg-white p-4">
      <div className="mb-1 flex justify-between text-[11px] text-[var(--muted)]">
        <span>bit 0</span>
        <span>bit {total - 1}</span>
      </div>
      <div className="flex h-11 overflow-hidden rounded-[8px] ring-1 ring-[var(--line)]">
        {fields.map((f) => (
          <button
            key={f.name}
            onMouseEnter={() => setHover(f)}
            onFocus={() => setHover(f)}
            onClick={() => setHover(f)}
            title={`${f.name}: bits ${f.from}-${f.from + f.bits - 1}`}
            className="relative h-full border-r-2 border-white transition-[filter] last:border-r-0 hover:brightness-110"
            style={{ flexGrow: Math.max(f.bits, 3), flexBasis: 0, background: f.color, opacity: hover.name === f.name ? 1 : 0.55 }}
          >
            {f.bits >= 14 && <span className="text-[11px] font-semibold text-white">{f.name}</span>}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-start gap-3">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-sm" style={{ background: hover.color }} />
        <div className="text-[13px]">
          <span className="font-semibold">{hover.name}</span>
          <span className="ml-2 text-[var(--muted)]">
            bits {hover.from}–{hover.from + hover.bits - 1} · {hover.bits} bit{hover.bits > 1 ? "s" : ""}
          </span>
          <div className="mt-0.5 text-[var(--muted)]">{hover.desc}</div>
        </div>
      </div>
      <figcaption className="mt-2 text-[11px] text-[var(--muted2)]">Hover or tap a field. Widths are drawn to scale (tiny fields are widened so you can hit them).</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- decoder

const BASE_TIME = 1767225600; // 2026-01-01, OrderState.BASE_TIME
const CHECKERS = ["off", "EDGE · leaves range", "TICK · price level", "TIME · timer", "TRAIL · trailing stop", "ORACLE · Chainlink price level", "FEES · fees earned (bps)", "APR · fee rate below (bps a year)"];

function bits(w: bigint, from: number, n: number) {
  return (w >> BigInt(from)) & ((1n << BigInt(n)) - 1n);
}
function s24(x: bigint) {
  const v = Number(x);
  return v >= 0x800000 ? v - 0x1000000 : v;
}
const when = (m: number) => (m ? new Date((BASE_TIME + m * 60) * 1000).toLocaleString() : "never");

function condText(checker: number, value: number, pool: number) {
  const v = checker === 3 ? `${value} minutes` : checker === 1 ? `${value} ticks past the edge` : checker === 4 ? `${value} ticks back from the best` : String(value);
  const where = checker === 2 || checker === 4 ? (pool ? ` · pool #${pool} ${poolByIndex(pool)?.label ?? ""}` : " · own pool") : "";
  return `${checker} · ${CHECKERS[checker] ?? "unknown"} · ${v}${where}`;
}

function decodeSide(h: bigint) {
  const checker = Number(bits(h, 24, 6));
  const checker2 = Number(bits(h, 78, 6));
  const combine = Number(bits(h, 132, 2));
  const hold = Number(bits(h, 134, 16));
  const best = bits(h, 174, 24);
  const actions = Number(bits(h, 198, 8));
  const shape = Number(bits(h, 232, 22));
  const rows: [string, string][] = [
    ["edge", String(s24(bits(h, 0, 24)))],
    ["condition A", checker ? condText(checker, s24(bits(h, 30, 24)), Number(bits(h, 54, 24))) : "0 · off"],
  ];
  if (combine) rows.push(["combine", combine === 1 ? "1 · and" : "2 · or"], ["condition B", condText(checker2, s24(bits(h, 84, 24)), Number(bits(h, 108, 24)))]);
  rows.push(
    ["holdMinutes", hold ? `${hold} min average` : "0 · 2 min average"],
    ["lastRun", when(Number(bits(h, 150, 24)))],
    ["best", checker === 4 || checker2 === 4 ? `best tick ${s24(best)}` : String(best)],
    ["actions", `${actions} · ${["keep fees", "remove", "swap", "add", "move"].filter((_, i) => actions & (1 << i)).join(" + ") || "none"}`],
    ["removeBps", `${Number(bits(h, 206, 14))} (${Number(bits(h, 206, 14)) / 100}%)`],
    ["swapToToken1", bits(h, 220, 1) ? "true" : "false"],
    ["addMode", Number(bits(h, 221, 3)) === 1 ? "1 · one-sided (follow)" : "0 · same range"],
    ["repeat", bits(h, 224, 1) ? "true" : "false"],
    ["runsLeft", Number(bits(h, 225, 7)) ? String(Number(bits(h, 225, 7))) : "0 · no limit"],
    ["shape", actions & 8 ? `${shape} · below ${shape & 2047}, above ${(shape >> 11) & 2047} spacings` : `${shape}${shape ? " · step in ticks" : ""}`],
  );
  return rows;
}

export function Decoder() {
  const client = usePublicClient();
  const [texts, setTexts] = useState<{ lower: string; upper: string }>({ lower: "", upper: "" });
  const [orderId, setOrderId] = useState("1");
  const [note, setNote] = useState("Paste a side's state word, or load an order.");
  const parse = (t: string) => {
    try {
      if (!t.trim()) return null;
      const w = BigInt(t.trim());
      return w >= 0n && w < 1n << 256n ? w : null;
    } catch {
      return null;
    }
  };
  const words = useMemo(() => ({ lower: parse(texts.lower), upper: parse(texts.upper) }), [texts]);

  const load = async () => {
    if (!client) return;
    try {
      const order = await client.readContract({ address: CORE.conditionalOrders, abi: conditionalOrdersAbi, functionName: "getOrder", args: [BigInt(orderId)] });
      if (order.owner === "0x0000000000000000000000000000000000000000") {
        setNote(`Order #${orderId} is closed or does not exist.`);
        return;
      }
      setTexts({ lower: `0x${order.lowerState.toString(16)}`, upper: `0x${order.upperState.toString(16)}` });
      setNote(`Live: order #${orderId} in ${poolByIndex(Number(order.poolIndex))?.label ?? `pool #${order.poolIndex}`}.`);
    } catch (e) {
      setNote(`Could not read order #${orderId}: ${(e as Error).message.split("\n")[0]}`);
    }
  };

  return (
    <div className="my-6 rounded-[14px] border border-[var(--line)] bg-white p-4">
      <div className="flex flex-wrap items-end gap-2">
        {(["lower", "upper"] as const).map((side) => (
          <label key={side} className="min-w-[220px] flex-1">
            <span className="label">{side === "lower" ? "Lower side word (slot 1)" : "Upper side word (slot 2)"}</span>
            <input className="input mt-1 font-mono text-[12px]" value={texts[side]} onChange={(e) => setTexts({ ...texts, [side]: e.target.value })} spellCheck={false} />
          </label>
        ))}
        <label>
          <span className="label">or load order #</span>
          <div className="mt-1 flex gap-1.5">
            <input className="input !w-20" value={orderId} onChange={(e) => setOrderId(e.target.value.replace(/\D/g, ""))} />
            <button className="btn btn-dark" onClick={load}>
              Load
            </button>
          </div>
        </label>
      </div>
      <div className="mt-1.5 text-[12px] text-[var(--muted)]">{note}</div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {(["lower", "upper"] as const).map((side) => {
          const h = words[side];
          return (
            <div key={side} className="rounded-[10px] bg-[var(--line2)] p-3">
              <div className={`mb-1.5 text-[12px] font-semibold ${side === "upper" ? "text-[var(--sage)]" : "text-[var(--rose)]"}`}>
                {side === "lower" ? "Lower side · fires when the tick falls" : "Upper side · fires when the tick rises"}
              </div>
              {h === null ? (
                <div className="text-[12px] text-[var(--muted)]">{texts[side].trim() ? "Not a valid uint256." : "Empty."}</div>
              ) : (
                <table className="!my-0 w-full text-[12.5px]">
                  <tbody>
                    {decodeSide(h).map(([k, v]) => (
                      <tr key={k}>
                        <td className="!border-0 !py-0.5 !pl-0 font-mono text-[12px] text-[var(--muted)]">{k}</td>
                        <td className="!border-0 !py-0.5 text-right">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
