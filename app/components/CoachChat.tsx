"use client";

import { Fragment, useRef, useState } from "react";
import { useT } from "@/lib/i18n.ts";
import type { Job } from "@/lib/jobs.ts";
import type { CoachEvent } from "@/lib/coach.ts";

type Turn = { question: string; events: CoachEvent[]; answer?: string; verified?: boolean; error?: string; cost?: number; turns?: number };

// Koç asistanı: the coach asks, the Muse Spark agent works with tools (shown live) and jumps the video to what it talks about.
export function CoachChat({ job, onSeek }: { job: Job; onSeek: (sourceSec: number) => void }) {
  const { t: tx, lang } = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  async function send(q: string) {
    q = q.trim();
    if (!q || busy) return;
    const history = turns.filter((t) => t.answer).slice(-3).map((t) => ({ question: t.question, answer: t.answer! }));
    const update = (f: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), f(ts.at(-1)!)]);
    setTurns((ts) => [...ts, { question: q, events: [] }]);
    setQuestion("");
    setBusy(true);
    const ac = (abort.current = new AbortController());
    try {
      const res = await fetch(`/api/jobs/${job.id}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q, history, lang }), signal: ac.signal });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let seeked = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const lines = (buf + value).split("\n");
        buf = lines.pop()!; // a line can arrive in pieces
        for (const line of lines.filter((l) => l.trim())) {
          const e = JSON.parse(line) as CoachEvent;
          if (e.type === "seek" && !seeked) {
            seeked = true;
            onSeek(e.sourceSec);
          }
          update((t) =>
            e.type === "answer" ? { ...t, answer: e.text, verified: e.verified }
            : e.type === "error" ? { ...t, error: e.message }
            : e.type === "done" ? { ...t, cost: e.costUsd, turns: e.turns }
            : { ...t, events: [...t.events, e] },
          );
        }
      }
    } catch (e) {
      update((t) => ({ ...t, error: ac.signal.aborted ? tx("stopped") : tx("unreachable", { e: e instanceof Error ? e.message : String(e) }) }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="font-medium">
        {tx("assistant")} <span className="text-sm font-normal opacity-60">· {tx("assistantSub")}</span>
      </h3>
      {turns.map((t, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
          <p className="font-medium">{t.question}</p>
          <ol className="space-y-1 opacity-80" aria-live="polite">
            {t.events.map((e, j) =>
              e.type === "seek" ? (
                <li key={j}>
                  <button onClick={() => onSeek(e.sourceSec)} className="underline underline-offset-2">
                    ▶ {fmtTime(e.sourceSec)} · {e.label}
                  </button>
                </li>
              ) : e.type === "refused" ? (
                <li key={j} className="text-amber-600 dark:text-amber-400">{tx("refused", { r: e.reason })}</li>
              ) : e.type === "step" ? (
                <li key={j}>· {e.label}</li>
              ) : null,
            )}
            {busy && i === turns.length - 1 && !t.answer && <li className="animate-pulse">· {tx("thinking")}</li>}
          </ol>
          {t.answer && (
            <div className="space-y-1 leading-6">
              {t.answer.split("\n").filter((l) => l.trim()).map((l, j) => (
                <p key={j} className={/^[-*] /.test(l) ? "pl-4 -indent-3" : ""}>
                  {/^[-*] /.test(l) ? "• " : ""}
                  <Inline text={l.replace(/^(#+|[-*]) /, "")} onSeek={onSeek} />
                </p>
              ))}
              <p className="text-xs opacity-60">
                <span className={t.verified ? "text-green-700 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
                  {t.verified ? tx("verified") : tx("unverified")}
                </span>
                {t.cost !== undefined && ` · ${tx("steps", { n: t.turns ?? 0 })} · ~$${t.cost.toFixed(3)}`}
              </p>
            </div>
          )}
          {t.error && <p className="text-red-600">{t.error}</p>}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {[tx("ex_1"), tx("ex_2"), tx("ex_3")].map((q) => (
          <button key={q} onClick={() => send(q)} disabled={busy} className="rounded-full border border-black/15 px-3 py-1 text-xs disabled:opacity-50 dark:border-white/20">
            {q}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(question);
        }}
        className="flex gap-2"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder={tx("askPlaceholder")}
          aria-label={tx("askAria")}
          className="flex-1 rounded border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/25"
        />
        {busy ? (
          <button type="button" onClick={() => abort.current?.abort()} className="rounded border border-black/20 px-3 py-1 text-sm dark:border-white/25">
            {tx("stop")}
          </button>
        ) : (
          <button type="submit" disabled={!question.trim()} className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50">
            {tx("ask")}
          </button>
        )}
      </form>
    </div>
  );
}

// **bold** and clickable m:ss times (source-video clock, like the player)
function Inline({ text, onSeek }: { text: string; onSeek: (sourceSec: number) => void }) {
  return text.split(/(\*\*[^*]+\*\*|\b\d{1,2}:\d{2}\b)/).map((part, i) => {
    const time = /^(\d{1,2}):(\d{2})$/.exec(part);
    if (time) {
      return (
        <button key={i} onClick={() => onSeek(+time[1] * 60 + +time[2])} className="font-medium text-[#1677ff] underline underline-offset-2">
          {part}
        </button>
      );
    }
    return part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>;
  });
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
