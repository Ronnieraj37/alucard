"use client";

// The strategy assistant: a composer docked at the bottom of the editor. Say (or type) what should happen; when
// something it needs is missing it asks back with options to click, and when it has enough it fills in the cards. Only
// the last exchange shows above the composer (earlier ones fold away), so it never pushes the cards; ⌘K focuses it and
// it minimises to a button. The server asks Gemini,
// coerces the answer into the editor's types and checks it with the editor's own validation. Nothing is signed: the LP
// reads the cards and the plain-words summary, replays it, then saves as usual. Every build can be undone.
import { ArrowUp, ChevronDown, Loader2, Mic, MicOff, Minus, RotateCcw, Sparkles, Undo2 } from "lucide-react";
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
  const threadRef = useRef<HTMLDivElement>(null);
  const [thread, setThread] = useState(true); // the conversation above the composer
  const [all, setAll] = useState(false); // earlier messages unfolded
  const [minimized, setMinimized] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    setCanSpeak(!!(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy, all]);
  // clicking anywhere else folds the conversation away (the composer stays)
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!thread) return;
    const away = (e: MouseEvent) => !dock.current?.contains(e.target as Node) && setThread(false);
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [thread]);
  // ⌘K / Ctrl+K: straight into the composer
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMinimized(false);
        setTimeout(() => input.current?.focus(), 0);
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
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  }, [text]);

  const empty = !rules.down.trigger && !rules.up.trigger;

  async function send(t = text) {
    const q = t.trim();
    if (!q || busy) return;
    const history = turnsOf(msgs);
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setText("");
    setThread(true);
    setAll(false);
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
  // the last exchange shows above the composer; earlier messages fold away
  const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
  const recent = lastUser >= 0 ? msgs.slice(lastUser) : msgs;
  const shown = all ? msgs : recent;
  const earlier = msgs.length - recent.length;

  if (minimized)
    return (
      <button className="dock-fab" onClick={() => setMinimized(false)} aria-label="Open the strategy assistant" title="Ask Alucard (⌘K)">
        <Sparkles className="h-5 w-5" />
      </button>
    );

  return (
    <div ref={dock} className="dock" aria-label="Strategy assistant">
      {thread && (msgs.length > 0 || busy) && (
        <div className="dock-pop" role="log" aria-live="polite">
          <div className="dock-pop-head">
            {earlier > 0 && (
              <button className="dock-link" onClick={() => setAll((x) => !x)}>
                {all ? "Hide earlier messages" : `${earlier} earlier message${earlier > 1 ? "s" : ""}`}
              </button>
            )}
            <span className="ml-auto flex items-center gap-1">
              <button className="dock-icon-sm" onClick={() => (setMsgs([]), setAll(false))} disabled={busy} title="New conversation" aria-label="New conversation">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button className="dock-icon-sm" onClick={() => setThread(false)} title="Hide" aria-label="Hide the conversation">
                <ChevronDown className="h-4 w-4" />
              </button>
            </span>
          </div>
          <div ref={threadRef} className="dock-thread">
            {shown.map((m) => {
              const i = msgs.indexOf(m);
              return m.role === "user" ? (
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
                        {m.summary.map((x, k) => (
                          <li key={k}>{x}</li>
                        ))}
                      </ul>
                      {m.problems.length > 0 && <p className="chat-warn">{m.problems.join(" ")}</p>}
                      {m.note && <p className="chat-note">{m.note}</p>}
                      <div className="chat-options">
                        {!m.undone ? (
                          <button
                            className="chat-option"
                            onClick={() => {
                              onApply(m.before);
                              setMsgs((xs) => xs.map((x, k) => (k === i && x.role === "assistant" && x.kind === "build" ? { ...x, undone: true } : x)));
                            }}
                          >
                            <Undo2 className="h-3.5 w-3.5" /> Undo
                          </button>
                        ) : (
                          <span className="chat-note !mt-0">Undone.</span>
                        )}
                        {onBacktest && !m.undone && m.problems.length === 0 && m === last && (
                          <button className="chat-option strong" onClick={onBacktest}>
                            Replay it on real history
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
            {busy && (
              <div className="chat-msg bot typing" aria-label="Thinking">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        </div>
      )}

      <form
        className="dock-bar"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Sparkles className="h-4 w-4 shrink-0 text-[var(--glow)]" />
        <textarea
          ref={input}
          rows={1}
          className="chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => msgs.length && setThread(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") (e.currentTarget.blur(), setThread(false));
          }}
          placeholder={
            last?.role === "assistant" && last.kind === "ask"
              ? "Pick an option above, or answer in your own words"
              : empty
                ? "Describe your strategy, or pick a template above"
                : "Describe a change"
          }
          maxLength={600}
          disabled={busy}
          aria-label="Message the strategy assistant"
        />
        {!text && <kbd className="dock-kbd">⌘K</kbd>}
        {canSpeak && (
          <button type="button" className={`chat-icon ${listening ? "on" : ""}`} onClick={speak} disabled={busy} aria-label={listening ? "Stop listening" : "Speak"}>
            {listening ? <MicOff className="h-[18px] w-[18px]" /> : <Mic className="h-[18px] w-[18px]" />}
          </button>
        )}
        <button type="submit" className="chat-send" disabled={busy || !text.trim()} aria-label="Send">
          {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <ArrowUp className="h-[18px] w-[18px]" />}
        </button>
        <button type="button" className="dock-icon-sm" onClick={() => setMinimized(true)} title="Minimise" aria-label="Minimise the assistant">
          <Minus className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}
