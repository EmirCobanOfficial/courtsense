// Koç asistanı: a Muse Spark 1.3 agent that answers the coach from this session's data.
// Same shape as Meta's legal-agent-workshop loop: the model picks one tool per turn, our code runs it and
// sends the result back; the check that every number is grounded sits inside the answer tool, so the model cannot skip it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { COURT } from "./court.ts";
import { analyze, playerPositions, type PlayerMetrics, type PlayerPositions, type Tracks } from "./metrics.ts";
import type { Lang } from "./i18n.ts";
import type { Job } from "./jobs.ts";

export type CoachEvent =
  | { type: "step"; tool: string; args: unknown; label: string }
  | { type: "seek"; sourceSec: number; label: string }
  | { type: "refused"; reason: string }
  | { type: "answer"; text: string; verified: boolean }
  | { type: "error"; message: string }
  | { type: "done"; turns: number; usage: { input: number; output: number }; costUsd: number };

export type Session = { job: Job; tracks: Tracks; metrics: PlayerMetrics[]; positions: PlayerPositions[]; clip: string };
type Client = Pick<OpenAI, "responses">;

const MODEL = "muse-spark-1.3";
const MAX_TURNS = 8;
const MAX_REFUSALS = 3;
const MAX_CLIP_LOOKS = 2;
const PRICE = { input: 1.25 / 1e6, output: 4.25 / 1e6 }; // USD per token, dev.meta.ai pricing

const instructions = (lang: Lang) => `You are "Coach assistant", the assistant of a tennis coach inside CourtSense.
Data: one training session filmed by a fixed camera behind the near baseline. SAM 3.1 tracked both players; their positions are in court meters.
Player A started on the near side (closer to the camera), Player B on the far side. There is no ball tracking.
Work with tools, exactly one call per turn:
- get_metrics, find_moments and minute_breakdown give you numbers. Every number in your answer must come from a tool result.
- When you talk about a specific moment, call show_moment for the most relevant one so the coach sees it in the video.
- look_at_clip lets you watch a few seconds (at most 2 times per question); only report what is visible.
- Finish with answer(text): ${lang === "tr" ? "Turkish" : "English"}, brief (at most ~120 words), times as m:ss of the video, players as ${lang === "tr" ? '"Oyuncu A" / "Oyuncu B"' : '"Player A" / "Player B"'}.
Rules: never claim shots, scores or technique; if a player's reliable is false, call their distance, speed and zones rough (${lang === "tr" ? "\"yaklaşık\"" : "\"about\", \"rough\""}) and do not compare them as exact; no medical or injury advice; if the data cannot answer the question, say so.`;

const PLAYER = { type: "string", enum: ["A", "B"] };
const TOOLS = [
  { name: "get_metrics", description: "Session metrics for one or both players: tracked time, distance, speeds, zone shares, left/center/right, reliability.",
    parameters: { type: "object", properties: { player: PLAYER }, required: [], additionalProperties: false } },
  { name: "find_moments", description: "Find moments in the session: fastest (top 1 s speeds), longest_run (longest continuous runs), net_visits (stays inside the service box).",
    parameters: { type: "object", properties: { player: PLAYER, kind: { type: "string", enum: ["fastest", "longest_run", "net_visits"] }, limit: { type: "integer", minimum: 1, maximum: 5 } }, required: ["player", "kind"], additionalProperties: false } },
  { name: "minute_breakdown", description: "Meters run in each full minute of the session.",
    parameters: { type: "object", properties: { player: PLAYER }, required: ["player"], additionalProperties: false } },
  { name: "show_moment", description: "Jump the coach's video (with SAM masks) to a moment.",
    parameters: { type: "object", properties: { sourceSec: { type: "number" }, label: { type: "string" } }, required: ["sourceSec", "label"], additionalProperties: false } },
  { name: "look_at_clip", description: "Watch 2-8 seconds of the video from a moment and answer a question about what is visible.",
    parameters: { type: "object", properties: { sourceSec: { type: "number" }, seconds: { type: "number", minimum: 2, maximum: 8 }, question: { type: "string" } }, required: ["sourceSec", "seconds", "question"], additionalProperties: false } },
  { name: "answer", description: "Give the final answer. Refused if it contains numbers that no tool returned.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
].map((t) => ({ type: "function" as const, strict: false, ...t }));

export function loadSession(job: Job, tracks: Tracks, clip: string): Session {
  return { job, tracks, clip, metrics: analyze(tracks, job.calibration!), positions: playerPositions(tracks, job.calibration!) };
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const r = (v: number, d: number) => +v.toFixed(d);
const pct = (v: number) => Math.round(v * 100);

// Numbers the coach reads must appear in tool results (or the question): "0,93", "%68", "578", "6:46".
// Small counts (0-10) are free; a value written with fewer decimals matches the tool value rounded that way.
export function ungrounded(text: string, evidence: string): string[] {
  const times = new Set(evidence.match(/\d+:\d\d/g) ?? []);
  const values = (evidence.replace(/\d+:\d\d/g, " ").match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((n) => +n.replace(",", "."));
  const bad: string[] = [];
  for (const t of text.match(/\d+:\d\d/g) ?? []) if (!times.has(t)) bad.push(t);
  for (const n of text.replace(/\d+:\d\d/g, " ").match(/\d+(?:[.,]\d+)*/g) ?? []) {
    // Turkish writes 10.688 for ten thousand six hundred eighty-eight, so a dot before 3 digits may be a thousands separator
    const readings = [n.replace(",", "."), ...(/^\d{1,3}(\.\d{3})+$/.test(n) ? [n.replace(/\./g, "")] : [])];
    const ok = readings.some((s) => {
      const v = +s;
      const d = s.includes(".") ? s.split(".")[1].length : 0;
      return (d === 0 && v <= 10) || values.some((e) => Math.abs(e - v) <= 0.5 * 10 ** -d + 1e-9);
    });
    if (!ok) bad.push(n);
  }
  return bad;
}

// --- tools ---
type Ctx = { s: Session; emit: (e: CoachEvent) => void; client: Client; signal?: AbortSignal; looks: number };
const src = (s: Session, clipSec: number) => s.job.startSec + clipSec;
const windowEnd = (s: Session) => s.job.startSec + s.tracks.frames / s.tracks.fps;

function playerMetricsView(s: Session, m: PlayerMetrics) {
  return {
    player: m.player,
    reliable: m.reliable,
    depthNoiseM: m.depthNoiseM,
    tracked: mmss(m.seconds),
    coveragePct: pct(m.coverage),
    distanceM: Math.round(m.distanceM),
    avgSpeedMs: m.avgSpeed,
    peakSpeedMs: m.peakSpeed,
    zonesPct: Object.fromEntries(Object.entries(m.zones).map(([k, v]) => [k, pct(v)])),
    lateralPct: Object.fromEntries(Object.entries(m.lateral).map(([k, v]) => [k, pct(v)])),
    sideChanges: m.sideChangesAt.map((t) => mmss(src(s, t))),
    ...(m.reliable ? {} : { note: "Depth is noisy for this player: distance, speeds and zones are rough; left/center/right is reliable." }),
  };
}

// Moments from the smoothed positions every metric uses. Times are source-video seconds.
export function findMoments(s: Session, player: "A" | "B", kind: string, limit = 3) {
  const { fps } = s.tracks;
  const segs = s.positions[player === "A" ? 0 : 1].smoothed;
  const found: { at: number; value: number; extra?: number }[] = [];
  for (const seg of segs) {
    if (kind === "fastest") {
      for (let i = 0, j = 0; i < seg.length; i++) {
        while (j < seg.length && seg[j].f - seg[i].f < fps) j++;
        if (j < seg.length) found.push({ at: seg[i].f / fps, value: Math.hypot(seg[j].x - seg[i].x, seg[j].y - seg[i].y) / ((seg[j].f - seg[i].f) / fps) });
      }
    } else {
      // a run: consecutive samples moving faster than 1 m/s; a net visit: samples inside the service box
      let start = -1, dist = 0;
      for (let i = 1; i <= seg.length; i++) {
        const p = seg[i], q = seg[i - 1];
        const own = (y: number) => (y < COURT.net ? y : COURT.length - y);
        const on = p && (kind === "longest_run"
          ? Math.hypot(p.x - q.x, p.y - q.y) / ((p.f - q.f) / fps) > 1
          : own(p.y) >= COURT.serviceFromBaseline && Math.abs(p.y - COURT.net) < COURT.net);
        if (on) {
          if (start < 0) [start, dist] = [i - 1, 0];
          dist += Math.hypot(p.x - q.x, p.y - q.y);
        } else if (start >= 0) {
          const dur = (seg[i - 1].f - seg[start].f) / fps;
          if (dur >= 1) found.push({ at: seg[start].f / fps, value: kind === "longest_run" ? dist : dur, extra: dur });
          start = -1;
        }
      }
    }
  }
  found.sort((a, b) => b.value - a.value);
  const picked: typeof found = [];
  for (const m of found) if (picked.length < limit && picked.every((p) => Math.abs(p.at - m.at) >= 3)) picked.push(m);
  const moments = picked.map((m) => ({
    sourceTime: mmss(src(s, m.at)),
    sourceSec: r(src(s, m.at), 1),
    ...(kind === "fastest" ? { speedMs: r(m.value, 2) } : kind === "longest_run" ? { distanceM: r(m.value, 1), durationS: r(m.extra!, 1) } : { durationS: r(m.value, 1) }),
  }));
  const reliable = s.metrics[player === "A" ? 0 : 1].reliable;
  return { player, kind, ...(kind === "net_visits" ? { count: found.length } : {}), moments, ...(reliable ? {} : { warning: "Depth-based, rough for this player." }) };
}

async function lookAtClip(c: Ctx, sourceSec: number, seconds: number, question: string) {
  const file = path.join(os.tmpdir(), `courtsense-${process.pid}-${Date.now()}.mp4`);
  try {
    await promisify(execFile)("ffmpeg", ["-v", "error", "-y", "-ss", String(sourceSec - c.s.job.startSec), "-t", String(seconds), "-i", c.s.clip,
      "-an", "-vf", "scale=1280:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
    const video = `data:video/mp4;base64,${fs.readFileSync(file).toString("base64")}`;
    const res = await c.client.responses.create({
      model: MODEL,
      instructions: "You watch a short clip of a tennis training session filmed from behind one baseline. Describe only what is visible (where each player is, how they move). No guesses about technique, the ball or the score. Answer in English, in at most 3 sentences.",
      input: [{ role: "user", content: [{ type: "input_text", text: question }, { type: "input_video", video_url: video }] }],
      reasoning: { effort: "low" },
      max_output_tokens: 4000,
    } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming, { signal: c.signal });
    return { seen: res.output_text, usage: res.usage };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const LABELS = {
  en: { metrics: "Reading the metrics", moments: "Looking for moments: ", minutes: "Checking the pace minute by minute", show: "Jumping the video to {t}", look: "Watching {s} s from {t}", answer: "Checking the answer", who: " (Player {p})",
    kinds: { fastest: "fastest moments", longest_run: "longest runs", net_visits: "visits to the net" } },
  tr: { metrics: "Metrikleri okuyor", moments: "Anları arıyor: ", minutes: "Dakika dakika tempoya bakıyor", show: "Videoyu {t} anına atlatıyor", look: "{t} anından {s} sn izliyor", answer: "Cevabı doğruluyor", who: " (Oyuncu {p})",
    kinds: { fastest: "en hızlı anlar", longest_run: "en uzun koşular", net_visits: "file önüne çıkışlar" } },
};
const label = (name: string, a: Record<string, unknown>, lang: Lang) => {
  const L = LABELS[lang];
  const who = a.player ? L.who.replace("{p}", String(a.player)) : "";
  const at = mmss(Number(a.sourceSec));
  return name === "get_metrics" ? L.metrics + who
    : name === "find_moments" ? L.moments + (L.kinds[a.kind as keyof typeof L.kinds] ?? a.kind) + who
    : name === "minute_breakdown" ? L.minutes + who
    : name === "show_moment" ? L.show.replace("{t}", at)
    : name === "look_at_clip" ? L.look.replace("{t}", at).replace("{s}", String(a.seconds))
    : L.answer;
};

async function runTool(c: Ctx, name: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
  const s = c.s;
  const player = a.player === "A" || a.player === "B" ? a.player : undefined;
  const inWindow = (t: unknown) => typeof t === "number" && t >= s.job.startSec && t <= windowEnd(s);
  switch (name) {
    case "get_metrics":
      return { window: { from: mmss(s.job.startSec), to: mmss(windowEnd(s)) }, players: s.metrics.filter((m) => !player || m.player === player).map((m) => playerMetricsView(s, m)) };
    case "find_moments":
      if (!player || !["fastest", "longest_run", "net_visits"].includes(String(a.kind))) return { error: "player must be A or B; kind must be fastest, longest_run or net_visits" };
      return findMoments(s, player, String(a.kind), Math.min(5, Math.max(1, Number(a.limit) || 3)));
    case "minute_breakdown": {
      if (!player) return { error: "player must be A or B" };
      const m = s.metrics[player === "A" ? 0 : 1];
      return { player, minutes: m.perMinuteM.map((meters, i) => ({ minute: i + 1, from: mmss(s.job.startSec + i * 60), to: mmss(s.job.startSec + (i + 1) * 60), meters })), ...(m.reliable ? {} : { warning: "Rough for this player." }) };
    }
    case "show_moment":
      if (!inWindow(a.sourceSec)) return { error: `sourceSec must be between ${s.job.startSec} and ${Math.floor(windowEnd(s))}` };
      c.emit({ type: "seek", sourceSec: Number(a.sourceSec), label: String(a.label ?? "").slice(0, 120) });
      return { shown: true, sourceTime: mmss(Number(a.sourceSec)) };
    case "look_at_clip": {
      const seconds = Number(a.seconds);
      if (!inWindow(a.sourceSec) || !(seconds >= 2 && seconds <= 8) || !inWindow(Number(a.sourceSec) + seconds)) return { error: "sourceSec must be inside the session and seconds 2-8" };
      if (c.looks >= MAX_CLIP_LOOKS) return { error: `at most ${MAX_CLIP_LOOKS} clip looks per question` };
      c.looks++;
      return lookAtClip(c, Number(a.sourceSec), seconds, String(a.question ?? "").slice(0, 300));
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// --- the loop ---
export async function ask(s: Session, question: string, history: { question: string; answer: string }[], emit: (e: CoachEvent) => void, client: Client, signal?: AbortSignal, lang: Lang = "en") {
  const input: ResponseInputItem[] = [
    ...history.flatMap((h): ResponseInputItem[] => [{ role: "user", content: h.question }, { role: "assistant", content: h.answer }]),
    { role: "user", content: question },
  ];
  const usage = { input: 0, output: 0 };
  const add = (u?: { input_tokens?: number; output_tokens?: number } | null) => {
    usage.input += u?.input_tokens ?? 0;
    usage.output += u?.output_tokens ?? 0;
  };
  const c: Ctx = { s, emit, client, signal, looks: 0 };
  let evidence = question; // numbers the coach said may be repeated
  let refusals = 0;
  let turn = 0;
  let finished = false;
  while (!finished && turn < MAX_TURNS) {
    turn++;
    if (turn === MAX_TURNS) input.push({ role: "user", content: "This is your last turn: call answer now." });
    const res = await client.responses.create({
      model: MODEL,
      instructions: instructions(lang),
      input,
      tools: TOOLS,
      parallel_tool_calls: false,
      store: false,
      include: ["reasoning.encrypted_content"], // stateless: reasoning comes back with the output and is replayed next turn
      reasoning: { effort: "low" },
      max_output_tokens: 8000,
    }, { signal });
    add(res.usage);
    input.push(...(res.output as ResponseInputItem[]));
    const call = res.output.find((o) => o.type === "function_call");
    if (!call) {
      input.push({ role: "user", content: "Plain text is not accepted. Call exactly one tool." });
      continue;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {}
    emit({ type: "step", tool: call.name, args, label: label(call.name, args, lang) });
    let result: Record<string, unknown>;
    if (call.name === "answer") {
      const text = String(args.text ?? "").trim();
      const bad = ungrounded(text, evidence);
      if (text && !bad.length) {
        emit({ type: "answer", text, verified: true });
        result = { accepted: true };
        finished = true;
      } else if (++refusals >= MAX_REFUSALS) {
        emit({ type: "answer", text, verified: false });
        result = { accepted: false };
        finished = true;
      } else {
        const reason = lang === "tr" ? (text ? `araç sonuçlarında olmayan sayılar: ${bad.join(", ")}` : "boş cevap") : text ? `numbers not in any tool result: ${bad.join(", ")}` : "empty answer";
        emit({ type: "refused", reason });
        result = { error: `${reason}. Take numbers only from tool results, or leave them out, then call answer again.` };
      }
    } else {
      try {
        result = await runTool(c, call.name, args);
      } catch (e) {
        if (signal?.aborted) throw e;
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      if ("usage" in result) {
        add(result.usage as Parameters<typeof add>[0]);
        delete result.usage;
      }
      evidence += JSON.stringify(result);
    }
    input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
  }
  if (!finished) emit({ type: "error", message: lang === "tr" ? "Ajan tur sınırında cevap veremedi." : "The agent ran out of turns before answering." });
  emit({ type: "done", turns: turn, usage, costUsd: +(usage.input * PRICE.input + usage.output * PRICE.output).toFixed(4) });
}
