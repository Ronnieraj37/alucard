// POST /api/assistant  {text, poolIndex, price, ticks?, current?}  →  {ok, rules, summary, problems, note?}
//
// Turns a sentence into a strategy with Gemini. The keys stay on the server (GEMINI_API_KEYS, comma-separated: a key
// that is rate-limited is skipped for a minute and the next one is tried). The answer is coerced into the editor's
// types and checked with the editor's own validation; one retry feeds the refusal back. Nothing here signs anything.
import { NextResponse } from "next/server";
import { type AssistantReply, type AssistantRequest, buildPrompt, coerceRules, problemsOf, summarize } from "@/lib/assistant";
import { poolByIndex } from "@/lib/pools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEYS = (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "")
  .split(/[,\s]+/)
  .map((k) => k.trim())
  .filter(Boolean);
const MODELS = (process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest,gemini-3.1-flash-lite,gemini-3.5-flash-lite").split(",").map((m) => m.trim());
// a rate-limited key rests for a minute; an overloaded or timed-out model is skipped (it is the same for every key)
const resting = new Map<string, number>(); // key → until (ms)
const busyModel = new Map<string, number>(); // model → until (ms)
let next = 0;

// a few requests a minute per visitor is plenty for a builder
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  h.push(now);
  hits.set(ip, h);
  return h.length > 12;
}

async function gemini(prompt: string): Promise<string> {
  let last = "no Gemini key is set (GEMINI_API_KEYS)";
  for (const model of MODELS) {
    if ((busyModel.get(model) ?? 0) > Date.now()) continue;
    for (let i = 0; i < KEYS.length; i++) {
      const key = KEYS[(next + i) % KEYS.length];
      if ((resting.get(key) ?? 0) > Date.now()) continue;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as Response);
      if (res.ok) {
        next = (next + i + 1) % KEYS.length; // spread the load
        const j = await res.json();
        const text = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
        if (text) return text;
        last = "the model returned nothing";
        continue;
      }
      last = `Gemini ${model}: HTTP ${res.status}`;
      console.warn("assistant:", last);
      if (res.status === 429 || res.status === 403) {
        resting.set(key, Date.now() + 60_000);
        continue;
      }
      // overloaded, timed out, or not available: the next model, not the next key
      if (res.status !== 404) busyModel.set(model, Date.now() + 60_000);
      break;
    }
  }
  throw new Error(last);
}

type Out = { rules?: unknown; note?: string; ask?: { question?: unknown; options?: unknown } };
function parse(text: string): Out {
  const s = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const o = JSON.parse(s);
  return o && typeof o === "object" && ("rules" in o || "ask" in o) ? o : { rules: o };
}

export async function POST(req: Request) {
  const reply = (r: AssistantReply, status = 200) => NextResponse.json(r, { status });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return reply({ ok: false, error: "Too many requests. Try again in a minute." }, 429);
  if (!KEYS.length) return reply({ ok: false, error: "The assistant is not set up on this server." }, 503);

  let body: AssistantRequest;
  try {
    body = await req.json();
  } catch {
    return reply({ ok: false, error: "Bad request." }, 400);
  }
  const own = poolByIndex(Number(body.poolIndex));
  const text = String(body.text ?? "").trim();
  if (!own || !text || !(Number(body.price) > 0)) return reply({ ok: false, error: "Bad request." }, 400);
  if (text.length > 600) return reply({ ok: false, error: "Please keep it under 600 characters." }, 400);
  body.history = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
    .slice(-10)
    .map((t) => ({ role: t.role, text: t.text.slice(0, 600) }));

  try {
    let prompt = buildPrompt({ ...body, text }, own);
    let out = parse(await gemini(prompt));
    const asks = (body.history ?? []).filter((t) => t.role === "assistant").length;
    if (out.ask && typeof out.ask.question === "string" && asks < 3) {
      const options = (Array.isArray(out.ask.options) ? out.ask.options : []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 120)).slice(0, 4);
      return reply({ ok: true, kind: "ask", question: out.ask.question.slice(0, 300), options });
    }
    let rules = coerceRules(out.rules, own);
    let problems = problemsOf(own, rules, body.ticks);
    if (problems.length) {
      prompt = buildPrompt({ ...body, text }, own, problems, JSON.stringify(out.rules));
      const again = parse(await gemini(prompt));
      if (!again.rules) return reply({ ok: true, kind: "build", rules, summary: summarize(own, rules), problems, note: out.note || undefined });
      const r2 = coerceRules(again.rules, own);
      const p2 = problemsOf(own, r2, body.ticks);
      if (p2.length <= problems.length) [out, rules, problems] = [again, r2, p2];
    }
    // a change keeps what it was not asked to change: a side the answer left empty keeps its steps (and the move
    // they use), unless the user asked to remove or replace them
    if (body.current && !/\b(remove|clear|delete|replace|instead|only|start over|reset|drop)\b/i.test(text)) {
      for (const lane of ["down", "up"] as const) {
        if (!rules[lane].trigger && body.current[lane]?.trigger) {
          rules = { ...rules, [lane]: body.current[lane] };
          if (!rules.plan && body.current.plan && body.current[lane].actions?.some((x) => x.kind === "move")) rules = { ...rules, plan: body.current.plan };
        }
      }
      problems = problemsOf(own, rules, body.ticks);
    }
    if (!rules.down.trigger && !rules.up.trigger)
      return reply({ ok: false, error: out.note || "I could not turn that into a strategy. Try naming when (a price, leaving the range, a % drop) and what to do." });
    // the model's note is shown as is, so drop it if it slipped into internal words
    const note = out.note && !/\b(lanes?|park(ed|ing)?|plan|trigger2?|readd|downside|upside|checker)\b/i.test(out.note) ? out.note : undefined;
    return reply({ ok: true, kind: "build", rules, summary: summarize(own, rules), problems, note });
  } catch (e) {
    console.error("assistant:", (e as Error).message);
    return reply({ ok: false, error: "The assistant is unavailable right now. Build it with the cards, or try again." }, 502);
  }
}
