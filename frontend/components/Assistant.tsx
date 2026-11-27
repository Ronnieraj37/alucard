"use client";

// The strategy assistant, as a panel beside the steps (the pattern of Zapier Copilot and n8n's assistant). Say or type
// what should happen; when something it needs is missing it asks one question with options to click, and when it has
// enough it fills in the steps. The server asks Gemini, coerces the answer into the editor's types and checks it with
// the editor's own validation. Nothing is signed: the LP reads the steps and the plain-words summary, replays it, then
// saves as usual. Every build can be undone.
import { ArrowUp, Check, Loader2, Mic, MicOff, PanelRightClose, RotateCcw, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AssistantReply, Turn } from "@/lib/assistant";
import type { Pool } from "@/lib/pools";
import type { Rules } from "@/lib/rules";

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
  onClose,
}: {
  pool: Pool;
  price: number;
  ticks?: [number, number];
  rules: Rules;
  onApply: (r: Rules) => void;
  onBacktest?: () => void;
  onClose: () => void;
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
    input.current?.focus();
  }, []);
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);
  // ⌘K / Ctrl+K: straight into the composer
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  // the input grows with what is typed, up to a few lines
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  const empty = !rules.down.trigger && !rules.up.trigger;
  const last = msgs[msgs.length - 1];

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
            text: r.problems.length ? "I filled in the steps, but one thing still needs a fix." : "I filled in the steps.",
            summary: r.summary,
            note: r.note,
            problems: r.problems,
            before,
          },
        ]);
      }
    } catch {
      setMsgs((m) => [...m, { role: "assistant", kind: "error", text: "The assistant is unavailable right now. Try again, or build it step by step." }]);
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

  return (
    <div className="ai">
      <header className="ai-head">
        <Sparkles className="h-4 w-4 text-[var(--glow)]" />
        <span className="text-[13.5px] font-semibold">Assistant</span>
        <span className="flex-1" />
        {msgs.length > 0 && (
          <button className="ed-icon" onClick={() => setMsgs([])} disabled={busy} title="New conversation" aria-label="New conversation">
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
        <button className="ed-icon" onClick={onClose} title="Close" aria-label="Close the assistant">
          <PanelRightClose className="h-4 w-4" />
        </button>
      </header>

      <div ref={thread} className="ai-thread" role="log" aria-live="polite">
        {msgs.length === 0 && (
          <div className="ai-empty">
            <p className="text-[14px] font-medium text-[var(--ink)]">Describe what should happen</p>
            <p>
              For example when to leave the range, where the money should wait, when it comes back, or when to take profit. If something is missing, it
              will ask. It fills in the steps; nothing is signed until you save.
            </p>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ai-user">
              {m.text}
            </div>
          ) : (
            <div key={i} className={`ai-bot ${m.kind === "error" ? "err" : ""}`}>
              <p>{m.text}</p>
              {m.kind === "ask" && m.options.length > 0 && (
                <div className="ai-options">
                  {m.options.map((o) => (
                    <button key={o} className="ai-option" onClick={() => send(o)} disabled={busy || m !== last}>
                      {o}
                    </button>
                  ))}
                </div>
              )}
              {m.kind === "build" && (
                <>
                  <ul className="ai-summary">
                    {m.summary.map((x, k) => (
                      <li key={k}>
                        <Check className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[var(--sage)]" />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                  {m.problems.length > 0 && <p className="mt-2 text-[12.5px] text-[var(--amber)]">{m.problems.join(" ")}</p>}
                  {m.note && <p className="mt-2 text-[12.5px] text-[var(--muted)]">{m.note}</p>}
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {!m.undone ? (
                      <button
                        className="ai-chip"
                        onClick={() => {
                          onApply(m.before);
                          setMsgs((xs) => xs.map((x, k) => (k === i && x.role === "assistant" && x.kind === "build" ? { ...x, undone: true } : x)));
                        }}
                      >
                        <Undo2 className="h-3.5 w-3.5" /> Undo
                      </button>
                    ) : (
                      <span className="text-[12.5px] text-[var(--muted)]">Undone.</span>
                    )}
                    {onBacktest && !m.undone && m.problems.length === 0 && m === last && (
                      <button className="ai-chip" onClick={onBacktest}>
                        Replay on real history
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="ai-typing" aria-label="Thinking">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <form
        className="ai-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          className="ai-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={last?.role === "assistant" && last.kind === "ask" ? "Pick an option, or answer in your own words" : empty ? "Describe your strategy…" : "Describe a change…"}
          maxLength={600}
          disabled={busy}
          aria-label="Message the assistant"
        />
        <div className="flex items-center gap-1">
          <span className="ai-hint">Enter to send · Shift+Enter for a new line</span>
          <span className="flex-1" />
          {canSpeak && (
            <button type="button" className={`ed-icon ${listening ? "!bg-[var(--rose)] !text-white" : ""}`} onClick={speak} disabled={busy} aria-label={listening ? "Stop listening" : "Speak"}>
              {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
          )}
          <button type="submit" className="ai-send" disabled={busy || !text.trim()} aria-label="Send">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}
