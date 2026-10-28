"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SegmentationRenderer } from "@meta-sam/graphics";
import { frameIndexOf, parseVideoStream, type ResponsesEvent, type VideoSegmentationResult } from "@meta-sam/parser";
import { Video, type VideoRef } from "@meta-sam/react";
import { useT } from "@/lib/i18n.ts";
import type { Job } from "@/lib/jobs.ts";
import type { PlayerMetrics } from "@/lib/metrics.ts";

const COLORS = { A: "#1677ff", B: "#d46b08" }; // blue / orange: distinct for colorblind viewers too
// The renderer defaults fit one image; a 12-minute session already has 42.5k boxes plus 42.5k masks.
const LIMITS = { maxRecords: 1_000_000, maxMasks: 500_000, maxBoxes: 500_000, maxRetainedComplexity: 100_000_000 };
const CHUNK = 8192; // ~15 ms of parsing, so playback keeps its frames while masks load

// SAM 3.1 video with each player's masks in their color; everyone else (bystanders, the next court) is hidden.
// jumpTo: seek to a source-video time; n changes on every request so the same time can be asked for twice.
export function MaskVideo({ job, metrics, jumpTo }: { job: Job; metrics: PlayerMetrics[]; jumpTo?: { sourceSec: number; n: number } }) {
  const { t } = useT();
  const ref = useRef<VideoRef>(null);
  const box = useRef<HTMLDivElement>(null);
  const colors = useRef(new Map<string, string>());
  const [sam, setSam] = useState<{ result: VideoSegmentationResult; renderer: SegmentationRenderer }>();
  const [err, setErr] = useState<{ key: "masksFailed" | "videoFailed"; e: string }>();
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  // layout effect: the map must be current before Video redraws for the new result
  useLayoutEffect(() => {
    colors.current = new Map(metrics.flatMap((m) => Object.keys(m.objectFrames).map((id): [string, string] => [id, COLORS[m.player]])));
  }, [metrics]);

  useEffect(() => {
    const ac = new AbortController();
    // Video never disposes a renderer it is given, so this effect owns it (StrictMode runs it twice in dev).
    const renderer = new SegmentationRenderer({ ...LIMITS, objectColor: (id) => colors.current.get(id) ?? "gray" });
    fetch(`/api/jobs/${job.id}/sam`, { signal: ac.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => parseVideoStream(samEvents(text, ac.signal)).finalResult)
      .then((result) => {
        if (result.outcome.status !== "completed") throw new Error(`SAM output incomplete: ${JSON.stringify(result.outcome)}`);
        if (result.diagnostics.length) console.warn(`${result.diagnostics.length} SAM parser diagnostics`, result.diagnostics);
        if (!ac.signal.aborted) setSam({ result, renderer });
      })
      .catch((e) => {
        if (!ac.signal.aborted) setErr({ key: "masksFailed", e: e.message });
      });
    return () => {
      ac.abort();
      renderer.dispose();
    };
  }, [job.id]);

  // waits for the duration, so a jump asked for while the video opens still happens
  useEffect(() => {
    if (!jumpTo || !duration) return;
    ref.current?.seek(Math.min(Math.max(0, jumpTo.sourceSec - job.startSec), duration - 0.001)).catch(() => {});
    box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [jumpTo, duration, job.startSec]);

  // per frame, not per id: SAM hands a player's id to someone else later, e.g. a person on the next court
  const shown = useMemo(() => {
    if (!sam) return undefined;
    const spans = new Map(metrics.flatMap((m) => Object.entries(m.objectFrames)));
    return {
      ...sam.result,
      records: sam.result.records.filter((r) => {
        const s = r.kind !== "text" && spans.get(r.objectId);
        const f = frameIndexOf(r);
        return !!s && f !== undefined && f >= s[0] && f <= s[1];
      }),
    };
  }, [sam, metrics]);

  const now = fmtTime(job.startSec + time);
  return (
    <div ref={box} className="space-y-2">
      <h3 className="font-medium">{t("masks")}</h3>
      <Video
        ref={ref}
        src={`/api/jobs/${job.id}/video`}
        result={shown}
        renderer={sam?.renderer}
        objectFit="contain"
        className="rounded bg-black"
        canvasProps={{ role: "img", "aria-label": t("masksAria") }}
        onDurationChange={setDuration}
        onTimeChange={setTime}
        onPlayingChange={setPlaying}
        onError={(e) => setErr({ key: "videoFailed", e: e.message })}
      />
      <div className="flex items-center gap-3">
        {/* failures also reach onError; a play or seek cancelled by a newer one is expected */}
        <button
          onClick={() => (playing ? ref.current?.pause() : ref.current?.play().catch(() => {}))}
          disabled={!duration}
          className="w-24 rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50"
        >
          {playing ? t("pause") : t("play")}
        </button>
        <input
          type="range"
          min={0}
          max={duration}
          step="any"
          value={time}
          disabled={!duration}
          onChange={(e) => {
            setTime(+e.target.value);
            // the last frame starts before `duration`; seeking to the very end is out of range
            ref.current?.seek(Math.min(+e.target.value, duration - 0.001)).catch(() => {});
          }}
          aria-label={t("position")}
          aria-valuetext={now}
          className="flex-1 accent-foreground"
        />
        <span className="text-sm tabular-nums">
          {now}
          {job.endSec ? ` · ${t("analysisEnd", { t: fmtTime(job.endSec) })}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {(["A", "B"] as const).map((p) => (
          <span key={p} className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-sm" style={{ background: COLORS[p] }} />
            {t("player", { p })}
          </span>
        ))}
        {!sam && !err && <span className="opacity-70">{t("masksLoading")}</span>}
      </div>
      {err && <p className="text-sm text-red-600">{t(err.key, { e: err.e })}</p>}
    </div>
  );
}

// The saved output text replayed as the Responses events the parser reads, shaped like its README example.
async function* samEvents(text: string, signal: AbortSignal): AsyncIterable<ResponsesEvent> {
  const lane = { item_id: "message-1", output_index: 0, content_index: 0 };
  // a message, unlike setTimeout, has no 4 ms clamp and is not throttled in a background tab
  const { port1, port2 } = new MessageChannel();
  try {
    for (let i = 0; i < text.length; i += CHUNK) {
      yield { type: "response.output_text.delta", ...lane, delta: text.slice(i, i + CHUNK) };
      // the parser validates every mask (~15 s for a 12-minute session): give the page a turn between chunks
      await new Promise((r) => {
        port1.onmessage = r;
        port2.postMessage(null);
      });
      signal.throwIfAborted();
    }
  } finally {
    port1.close();
  }
  yield { type: "response.output_text.done", ...lane, text };
  yield { type: "response.completed" };
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
