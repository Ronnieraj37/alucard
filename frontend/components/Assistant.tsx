"use client";

// The strategy assistant, as a conversation. Say (or type) what should happen; when something it needs is missing it
// asks back with options to click, and when it has enough it fills in the cards below. The server asks Gemini,
// coerces the answer into the editor's types and checks it with the editor's own validation. Nothing is signed: the LP
// reads the cards and the plain-words summary, replays it, then saves as usual. Every build can be undone.
import { ArrowUp, Loader2, Mic, MicOff, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AssistantReply, Turn } from "@/lib/assistant";
import type { Pool } from "@/lib/pools";
import { type Rules, parkable } from "@/lib/rules";

type SpeechCtor = new () => {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
};

/** One message in the thread. `before` is the strategy a build replaced (for Undo). */
type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; kind: "ask"; text: string; options: string[] }
  | { role: "assistant"; kind: "build"; text: string; summary: string[]; note?: string; problems: string[]; before: Rules; undone?: boolean }
  | { role: "assistant"; kind: "error"; text: string };

const ideasFor = (p: Pool) => {
  const b = p.base.symbol.replace("WETH", "ETH");
  const stable = (q: Pool) => ["USDC", "USDT", "DAI"].includes(q.base.symbol) && ["USDC", "USDT", "DAI"].includes(q.quote.symbol);
  const q = parkable(p).find(stable) ?? parkable(p)[0];
  return [
    q ? `If ${b} drops out of my range, move it into ${q.base.symbol}/${q.quote.symbol} until it's back` : `If ${b} drops out of my range, hold ${p.quote.symbol} until it's back`,
    `Take profit in steps as ${b} rises`,
    `Protect me if ${b} crashes`,
    `Compound my fees`,
  ];
};

/** What the server sees of the thread: plain text turns. */
const turnsOf = (msgs: Msg[]): Turn[] =>
  msgs.map((m) =>
    m.role === "user"
      ? { role: "user", text: m.text }
      : { role: "assistant", text: m.kind === "ask" ? `${m.text} (options: ${m.options.join(" / ")})` : m.kind === "build" ? `Built: ${m.summary.join(" ")}` : m.text },
  );

export default function Assistant({
  pool,
  price,
  ticks,
  rules,
  onApply,
  onBacktest,
}: {
  pool: Pool;
  price: number;
  ticks?: [number, number];
  rules: Rules;
  onApply: (r: Rules) => void;
  onBacktest?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [listening, setListening] = useState(false);
  const [canSpeak, setCanSpeak] = useState(false);
  const rec = useRef<InstanceType<SpeechCtor> | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    setCanSpeak(!!(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);
  // the input grows with what is typed, up to a few lines
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  }, [text]);

  const empty = !rules.down.trigger && !rules.up.trigger;

  async function send(t = text) {
    const q = t.trim();
    if (!q || busy) return;
    const history = turnsOf(msgs);
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setText("");
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: q, poolIndex: pool.index, price, ticks, current: empty ? undefined : rules, history }),
      });
      const r = (await res.json()) as AssistantReply;
      if (!r.ok) setMsgs((m) => [...m, { role: "assistant", kind: "error", text: r.error }]);
      else if (r.kind === "ask") setMsgs((m) => [...m, { role: "assistant", kind: "ask", text: r.question, options: r.options }]);
      else {
        const before = rules;
        onApply(r.rules);
        setMsgs((m) => [
          ...m,
          {
            role: "assistant",
            kind: "build",
            text: r.problems.length ? "I filled in the cards, but one thing still needs a fix:" : "Done. I filled in the cards below:",
            summary: r.summary,
            note: r.note,
            problems: r.problems,
            before,
          },
        ]);
      }
    } catch {
      setMsgs((m) => [...m, { role: "assistant", kind: "error", text: "The assistant is unavailable right now. Try again, or build it with the cards." }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  function speak() {
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!C) return;
    if (listening) return rec.current?.stop();
    const r = new C();
    r.lang = "en-US";
    r.interimResults = true;
    r.onresult = (e) => setText(Array.from(e.results, (x) => x[0].transcript).join(" "));
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  }

  const last = msgs[msgs.length - 1];
  return (
    <section className="chat" aria-label="Strategy assistant">
      <header className="chat-head">
        <span className="chat-avatar">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="chat-title">Ask Alucard</div>
          <div className="chat-sub">Describe what should happen. It asks if something is missing, then fills in the cards. Nothing is signed until you save.</div>
        </div>
        {msgs.length > 0 && (
          <button className="chat-reset" onClick={() => setMsgs([])} disabled={busy} title="Start a new conversation">
            <RotateCcw className="h-3.5 w-3.5" /> New chat
          </button>
        )}
      </header>

      {msgs.length > 0 && (
        <div ref={thread} className="chat-thread" aria-live="polite">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="chat-msg user">
                {m.text}
              </div>
            ) : (
              <div key={i} className={`chat-msg bot ${m.kind === "error" ? "err" : ""}`}>
                <p>{m.text}</p>
                {m.kind === "ask" && m.options.length > 0 && (
                  <div className="chat-options">
                    {m.options.map((o) => (
                      <button key={o} className="chat-option" onClick={() => send(o)} disabled={busy || m !== last}>
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                {m.kind === "build" && (
                  <>
                    <ul className="chat-summary">
                      {m.summary.map((s, k) => (
                        <li key={k}>{s}</li>
                      ))}
                    </ul>
                    {m.problems.length > 0 && <p className="chat-warn">{m.problems.join(" ")}</p>}
                    {m.note && <p className="chat-note">{m.note}</p>}
                    <div className="chat-options">
                      {!m.undone && (
                        <button
                          className="chat-option"
                          onClick={() => {
                            onApply(m.before);
                            setMsgs((all) => all.map((x, k) => (k === i && x.role === "assistant" && x.kind === "build" ? { ...x, undone: true } : x)));
                          }}
                        >
                          <Undo2 className="h-3.5 w-3.5" /> Undo
                        </button>
                      )}
                      {m.undone && <span className="chat-note !mt-0">Undone.</span>}
                      {onBacktest && !m.undone && m.problems.length === 0 && m === last && (
                        <button className="chat-option strong" onClick={onBacktest}>
                          Replay it on real history
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ),
          )}
          {busy && (
            <div className="chat-msg bot typing" aria-label="Thinking">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      )}

      {msgs.length === 0 && (
        <div className="chat-ideas">
          {ideasFor(pool).map((i) => (
            <button key={i} className="chat-option" onClick={() => send(i)} disabled={busy}>
              {i}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat-bar"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          className="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            last?.role === "assistant" && last.kind === "ask"
              ? "Pick an option above, or answer in your own words"
              : empty
                ? `e.g. “if ${pool.base.symbol.replace("WETH", "ETH")} falls out of my range, move it to a stable pool until it's back”`
                : "Change it, e.g. “also take 25% profit above 2,000”"
          }
          maxLength={600}
          disabled={busy}
          aria-label="Message the strategy assistant"
        />
        {canSpeak && (
          <button type="button" className={`chat-icon ${listening ? "on" : ""}`} onClick={speak} disabled={busy} aria-label={listening ? "Stop listening" : "Speak"}>
            {listening ? <MicOff className="h-[18px] w-[18px]" /> : <Mic className="h-[18px] w-[18px]" />}
          </button>
        )}
        <button type="submit" className="chat-send" disabled={busy || !text.trim()} aria-label="Send">
          {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <ArrowUp className="h-[18px] w-[18px]" />}
        </button>
      </form>
    </section>
  );
}
