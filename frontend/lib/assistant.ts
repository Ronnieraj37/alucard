// The strategy assistant: a sentence in, a strategy for the editor out. The model only proposes a `Rules` object; it
// is coerced into the editor's own types here, checked with the same `validate` the editor uses, and shown in the
// cards for the LP to read, change and sign. The assistant never signs and never sees a wallet.

import { type Pool, POOLS, fmt, poolByIndex, priceAtTick } from "./pools";
import {
  type Action,
  type ActionKind,
  type Lane,
  type LaneId,
  type PlanB,
  type Rules,
  type Trigger,
  type TriggerKind,
  MAX_HOLD_MINUTES,
  MAX_RUNS,
  TEMPLATES,
  allErrors,
  defaultWidthPct,
  describeBack,
  describeLane,
  emptyLane,
  parkable,
  validate,
} from "./rules";

/** One turn of the conversation: what the user said, or what the assistant asked or built. */
export type Turn = { role: "user" | "assistant"; text: string };
export type AssistantRequest = { text: string; poolIndex: number; price: number; ticks?: [number, number]; current?: Rules; history?: Turn[] };
export type AssistantReply =
  | { ok: true; kind: "build"; rules: Rules; summary: string[]; note?: string; problems: string[] }
  | { ok: true; kind: "ask"; question: string; options: string[] }
  | { ok: false; error: string };

const TRIGGERS: TriggerKind[] = ["leave", "price", "otherPool", "timer", "trail", "fees", "apr"];
const ACTIONS: ActionKind[] = ["collect", "withdraw", "convert", "readd", "follow", "move"];

const num = (x: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof x === "string" ? Number(x.replace(/[, ]/g, "")) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

function trigger(x: unknown, own: Pool): Trigger | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const kind = o.kind as TriggerKind;
  if (!TRIGGERS.includes(kind)) return null;
  const t: Trigger = { kind };
  switch (kind) {
    case "leave":
      t.bufferPct = num(o.bufferPct, 0, 50) ?? 0;
      break;
    case "price":
      if (o.backIn === true) {
        t.backIn = true;
        const b = num(o.bufferPct, 0, 10);
        if (b) t.bufferPct = Math.round(b * 2) / 2;
      } else t.price = num(o.price, 0, 1e12);
      break;
    case "otherPool": {
      const q = poolByIndex(Number(o.poolIndex));
      t.poolIndex = q && q.index !== own.index ? q.index : undefined;
      t.price = num(o.price, 0, 1e12);
      break;
    }
    case "timer":
      t.hours = num(o.hours, 0.1, 24 * 365) ?? 24;
      break;
    case "trail":
      t.trailPct = num(o.trailPct, 0.1, 99) ?? 5;
      break;
    case "fees":
      t.feesPct = num(o.feesPct, 0.01, 100) ?? 0.5;
      break;
    case "apr":
      t.aprPct = num(o.aprPct, 0.1, 1000) ?? 5;
      break;
  }
  return t;
}

function action(x: unknown): Action | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const kind = o.kind as ActionKind;
  if (!ACTIONS.includes(kind)) return null;
  const a: Action = { kind };
  if (kind === "withdraw") a.pct = Math.round(num(o.pct, 1, 100) ?? 100);
  if (kind === "convert") a.to = o.to === "base" ? "base" : "quote";
  if (kind === "move" && (o.to === "base" || o.to === "quote")) a.to = o.to;
  if (kind === "follow") a.widthPct = num(o.widthPct, 0.1, 50) ?? 5;
  return a;
}

function lane(x: unknown, own: Pool, back = false): Lane {
  if (!x || typeof x !== "object") return emptyLane();
  const o = x as Record<string, unknown>;
  const t = trigger(o.trigger, own);
  if (!t) return emptyLane();
  const seen = new Set<ActionKind>();
  let actions = (Array.isArray(o.actions) ? o.actions : []).map(action).filter((a): a is Action => !!a && !seen.has(a.kind) && !!seen.add(a.kind));
  if (back) actions = [{ kind: "move" }]; // a way back only moves the money back
  const l: Lane = { trigger: t, actions, repeat: back ? true : o.repeat === true };
  const t2 = trigger(o.trigger2, own);
  if (t2 && !back) {
    l.trigger2 = t2;
    l.combine = o.combine === "or" ? "or" : "and";
  }
  const hold = num(o.holdMinutes, 0, MAX_HOLD_MINUTES);
  if (hold) l.holdMinutes = Math.round(hold);
  if (l.repeat && !back) {
    const step = num(o.stepPct, 0.1, 50);
    if (step) l.stepPct = step;
    const runs = num(o.maxRuns, 0, MAX_RUNS);
    if (runs) l.maxRuns = Math.round(runs);
  }
  return l;
}

/** Whatever the model sent, as the editor's types (unknown kinds dropped, numbers clamped). */
export function coerceRules(raw: unknown, own: Pool): Rules {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const r: Rules = { down: lane(o.down, own), up: lane(o.up, own) };
  const moves = r.down.actions.some((a) => a.kind === "move") || r.up.actions.some((a) => a.kind === "move");
  const p = o.plan as Record<string, unknown> | undefined;
  if (moves) {
    const back = (p?.back ?? {}) as Record<string, unknown>;
    const parkPool = poolByIndex(Number(p?.parkPool));
    const park = p?.where === "park" && parkPool && parkable(own).some((q) => q.index === parkPool.index);
    const plan: PlanB = {
      where: park ? "park" : "wait",
      returnTo: p?.returnTo === "recentre" ? "recentre" : "same",
      back: { down: lane(back.down, own, true), up: lane(back.up, own, true) },
    };
    if (park) {
      plan.parkPool = parkPool!.index;
      // two stablecoins sit at 1: a wide range there earns little, so a stable pool keeps its narrow default
      const dflt = defaultWidthPct(parkPool!);
      plan.parkWidthPct = dflt < 1 ? Math.min(num(p?.parkWidthPct, 0.01, 50) ?? dflt, dflt) : (num(p?.parkWidthPct, 0.01, 50) ?? dflt);
    }
    // "back in my range" after a fall can only be a rise (and the other way): put it on the lane that can see it
    const exitDown = r.down.actions.some((a) => a.kind === "move");
    const exitUp = r.up.actions.some((a) => a.kind === "move");
    if (exitDown !== exitUp) {
      const right: LaneId = exitDown ? "up" : "down";
      const wrong: LaneId = exitDown ? "down" : "up";
      if (plan.back[wrong].trigger?.backIn) {
        if (!plan.back[right].trigger) plan.back[right] = plan.back[wrong];
        plan.back[wrong] = emptyLane();
      }
    }
    // a move with no way back: come back once the price is back in the range
    if (!plan.back.down.trigger && !plan.back.up.trigger) {
      const exit: LaneId = r.down.actions.some((a) => a.kind === "move") ? "down" : "up";
      plan.back[exit === "down" ? "up" : "down"] = { trigger: { kind: "price", backIn: true }, actions: [{ kind: "move" }], repeat: true };
    }
    r.plan = plan;
  }
  return r;
}

const SCHEMA = `Rules JSON (TypeScript):
type Trigger =
  | { kind: "leave"; bufferPct?: number }            // the price leaves the position's range on this side (bufferPct further out)
  | { kind: "price"; price: number }                  // the base token's price (in quote) crosses this level
  | { kind: "price"; backIn: true; bufferPct?: number }  // ONLY inside plan.back: "the price is back in my range"
  | { kind: "otherPool"; poolIndex: number; price: number } // another pool's base price crosses a level
  | { kind: "timer"; hours: number }                  // every N hours / after N hours
  | { kind: "trail"; trailPct: number }               // falls (down side) or rises (up side) this % from its best price
  | { kind: "fees"; feesPct: number }                 // fees earned reach this % of the position
  | { kind: "apr"; aprPct: number };                  // fees earn less than this % a year
type Action =
  | { kind: "withdraw"; pct: number }                 // to the owner's wallet
  | { kind: "convert"; to: "base" | "quote" }         // swap what is withdrawn to one token (only after withdraw)
  | { kind: "collect" }                               // send the fees to the wallet
  | { kind: "readd" }                                 // compound: add the fees back in
  | { kind: "follow"; widthPct: number }              // re-centre the range ±widthPct around the price
  | { kind: "move"; to?: "base" | "quote" };          // move everything per "plan" (alone, no other actions)
type Lane = { trigger: Trigger | null; actions: Action[]; repeat: boolean; stepPct?: number; maxRuns?: number;
              trigger2?: Trigger; combine?: "and" | "or"; holdMinutes?: number /* only if it stays true this long, max 1440 */ };
type Plan = { where: "wait" | "park"; parkPool?: number; parkWidthPct?: number; returnTo: "same" | "recentre";
              back: { down: Lane; up: Lane } };   // back lanes: when the money comes back (trigger only; actions [{kind:"move"}])
type Rules = { down: Lane; up: Lane; plan?: Plan };  // down = if the base token falls, up = if it rises`;

const RULES_OF_THUMB = `Rules of thumb:
- An empty side is {"trigger": null, "actions": [], "repeat": false}.
- "move" goes alone in its side's actions and needs "plan". where "wait" = hold one token (move.to says which); "park" = a range in another pool (parkPool must be one of the pools listed).
- A fall out of the range comes back on the "up" back lane, and the other way round. "Back in my range" = {"kind":"price","backIn":true}.
- Price levels for "down" must be below the range, for "up" above it (a level inside the range fires at once).
- repeat with a price level steps the level stepPct further each run; set maxRuns for ladders. Do not repeat a full withdraw.
- "apr" can only be used on one side. "convert" needs a "withdraw" before it.
- Stop loss = withdraw 100 + convert to quote. Take profit = withdraw (+ convert to quote if they want stablecoins).
- Only use what the user asked for. Never invent extra steps.
- "note" and "question" are read by the user: plain words only. Say "if ETH falls" / "if ETH rises", "move into USDT/USDC",
  "come back"; never "lane", "down/up side", "park", "plan", "trigger", "readd" or field names.`;

export function buildPrompt(req: AssistantRequest, own: Pool, problems?: string[], previous?: string): string {
  const range = req.ticks && req.ticks[0] !== req.ticks[1] ? [priceAtTick(own, req.ticks[0]), priceAtTick(own, req.ticks[1])].sort((a, b) => a - b) : null;
  const others = parkable(own).map((q) => `${q.index}: ${q.label}`);
  const watch = POOLS.filter((q) => q.index !== own.index).map((q) => `${q.index}: ${q.label}`);
  const ticks = req.ticks ?? [0, 0];
  const examples = TEMPLATES.map((t) => {
    const r = t.build(own, req.price, ticks);
    return r ? `"${t.name}" (${t.hint}):\n${JSON.stringify(r)}` : null;
  })
    .filter(Boolean)
    .slice(0, 8)
    .join("\n\n");
  return [
    `You turn a liquidity provider's request into a strategy for their Uniswap v4 position, as JSON only.`,
    `FIRST decide: build, or ask. Build only if the user has said both WHEN (leaves my range, a price, a % drop or rise
from the high/low, a timer, fees earned) and WHAT TO DO (exit to a token, withdraw some, move to another pool and come
back, re-centre, compound), directly or through the conversation. Otherwise ask ONE short question with 2 to 4 options
the user can click, each a complete answer in their words. Examples:
- "Take profit as ETH rises" says what but not when or how much: ask {"ask": {"question": "How should it take profit?",
  "options": ["Withdraw 25% every 5% up, 4 times", "Withdraw everything when ETH leaves my range above", "Withdraw everything above a price I set"]}}
- "Protect me if ETH crashes" says neither: ask {"ask": {"question": "What should happen if ETH falls?",
  "options": ["Exit to USDC when it leaves my range", "Move into USDT/USDC and come back when it recovers", "Trailing stop: exit if it falls 8% from its high"]}}
Never ask about keeper fee, slippage, expiry, range widths or margins (they have defaults). After two questions, build
with sensible defaults and say what you assumed in "note". Profit taken in the base token is sold for the quote token.`,
    `Position: ${own.label}. Base token ${own.base.symbol}, quote ${own.quote.symbol}. Now 1 ${own.base.symbol} = ${fmt(req.price)} ${own.quote.symbol}.` +
      (range ? ` Range ${fmt(range[0])} – ${fmt(range[1])} ${own.quote.symbol}.` : ""),
    `Pools the money can move into (share a token): ${others.join("; ") || "none (use where: \"wait\")"}.`,
    `Pools a condition can watch: ${watch.join("; ")}.`,
    SCHEMA,
    RULES_OF_THUMB,
    `Examples for this pool:\n${examples}`,
    req.current ? `The current strategy (change it only as asked; keep the rest):\n${JSON.stringify(req.current)}` : "",
    previous && problems?.length ? `Your previous answer:\n${previous}\nThe editor refused it: ${problems.join(" ")} Fix that.` : "",
    `Answer with one JSON object, either {"rules": Rules, "note": "one short sentence on what you assumed or could not do, or empty"}
or {"ask": {"question": "...", "options": ["...", "..."]}}.`,
    (req.history ?? []).length
      ? `The conversation so far:\n${(req.history ?? [])
          .slice(-10)
          .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text.slice(0, 600)}`)
          .join("\n")}`
      : "",
    `The user now says: """${req.text.slice(0, 600)}"""`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function summarize(own: Pool, r: Rules): string[] {
  const out = (["down", "up"] as LaneId[]).map((l) => describeLane(own, l, r[l], r.plan)).filter((x): x is string => !!x);
  if (r.plan) out.push(...describeBack(own, r.plan));
  return out;
}

export function problemsOf(own: Pool, r: Rules, ticks?: [number, number]) {
  return allErrors(validate(own, r, ticks));
}
