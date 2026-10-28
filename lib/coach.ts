// Koç asistanı: a Muse Spark 1.3 agent that answers the coach from this session's data.
// Same shape as Meta's legal-agent-workshop loop: the model picks one tool per turn, our code runs it and
// sends the result back; the check that every number is grounded sits inside the answer tool, so the model cannot skip it.
// The answer lists each number as a claim (player, metric, value, unit); claims.ts checks them against the session's facts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { COURT } from "./court.ts";
import { METRICS, verify, type Fact, type Metric, type Player, type Problem } from "./claims.ts";
import { analyze, place, playerPositions, type PlayerMetrics, type PlayerPositions, type Sample, type Tracks } from "./metrics.ts";
import type { Lang } from "./i18n.ts";
import type { Job } from "./jobs.ts";

export type CoachEvent =
  | { type: "step"; tool: string; args: unknown; label: string }
  | { type: "seek"; sourceSec: number; label: string }
  | { type: "refused"; reason: string }
  | { type: "answer"; text: string; verified: boolean }
  | { type: "error"; message: string }
  | { type: "done"; turns: number; usage: { input: number; output: number }; costUsd: number };

export type Session = { job: Job; tracks: Tracks; metrics: PlayerMetrics[]; positions: PlayerPositions[]; clip: string; facts: Fact[] };
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
- Finish with answer(text, claims): ${lang === "tr" ? "Turkish" : "English"}, brief (at most ~120 words), times as m:ss of the video, players as ${lang === "tr" ? '"Oyuncu A" / "Oyuncu B"' : '"Player A" / "Player B"'}.
${CLAIM_RULES(lang)}
Rules: never claim shots, scores or technique; no medical or injury advice; if the data cannot answer the question, say so.`;

// How every number reaching the coach must be stated; shared with the report prompt.
export const CLAIM_RULES = (lang: Lang) => `Numbers: list every number you write in the text as a claim {player, metric, value, unit, at}.
- metric: ${Object.keys(METRICS).join(", ")}. unit: m (distance), m/s (speed), % (shares), s (durations), time (m:ss), count.
- player: A or B; leave it out for window_start, window_end and shown_time (a moment you showed or watched).
- value: the number as you wrote it, from the data, with the same or fewer decimals (0.92 may become 0.9); whole numbers stay as they are. Never repeat a number from the question that the data does not give.
- at: the moment's start (m:ss) for minute_distance, fastest_*, run_*, net_visit_*.
- Name the player before their numbers, in the same sentence (${lang === "tr" ? '"Oyuncu A 400 m koştu"' : '"Player A ran 400 m"'}). Write numbers that are not data in words (${lang === "tr" ? '"üç an", "ikinci dakika"' : '"three moments", "the second minute"'}).
- If a player's reliable is false, write ${lang === "tr" ? '"yaklaşık"' : '"about"'} in every sentence with their distance, speed, zone or net-visit numbers, and do not compare those as exact.`;

const PLAYER = { type: "string", enum: ["A", "B"] };
export const CLAIMS = { type: "array", items: { type: "object", properties: {
  player: PLAYER, metric: { type: "string", enum: Object.keys(METRICS) }, value: { type: ["number", "string"] },
  unit: { type: "string", enum: ["m", "m/s", "%", "s", "time", "count"] }, at: { type: "string" },
}, required: ["metric", "value", "unit"], additionalProperties: false } };
const TOOLS = [
  { name: "get_metrics", description: "Session metrics for one or both players: tracked time, distance, speeds, zone shares, left/center/right, reliability.",
    parameters: { type: "object", properties: { player: PLAYER }, required: [], additionalProperties: false } },
  { name: "find_moments", description: "Find moments in the session: fastest (top 1 s speeds, with where the player ran from and to: side, zone and left/center/right from the player's view; zone only when their depth is reliable), longest_run (longest continuous runs), net_visits (stays inside the service box).",
    parameters: { type: "object", properties: { player: PLAYER, kind: { type: "string", enum: ["fastest", "longest_run", "net_visits"] }, limit: { type: "integer", minimum: 1, maximum: 5 } }, required: ["player", "kind"], additionalProperties: false } },
  { name: "minute_breakdown", description: "Meters run in each full minute of the session.",
    parameters: { type: "object", properties: { player: PLAYER }, required: ["player"], additionalProperties: false } },
  { name: "show_moment", description: "Jump the coach's video (with SAM masks) to a moment.",
    parameters: { type: "object", properties: { sourceSec: { type: "number" }, label: { type: "string" } }, required: ["sourceSec", "label"], additionalProperties: false } },
  { name: "look_at_clip", description: "Watch 2-8 seconds of the video from a moment and answer a question about what is visible.",
    parameters: { type: "object", properties: { sourceSec: { type: "number" }, seconds: { type: "number", minimum: 2, maximum: 8 }, question: { type: "string" } }, required: ["sourceSec", "seconds", "question"], additionalProperties: false } },
  { name: "answer", description: "Give the final answer with every number in it listed as a claim. Refused when a claim does not match the session data, or the text has a number without a claim, next to the wrong player, in the wrong unit, or a rough value not marked as rough.",
    parameters: { type: "object", properties: {
      text: { type: "string" }, claims: CLAIMS,
    }, required: ["text", "claims"], additionalProperties: false } },
].map((t) => ({ type: "function" as const, strict: false, ...t }));

export function loadSession(job: Job, tracks: Tracks, clip: string): Session {
  const s: Session = { job, tracks, clip, metrics: analyze(tracks, job.calibration!), positions: playerPositions(tracks, job.calibration!), facts: [] };
  s.facts = sessionFacts(s);
  return s;
}

const ZONE_METRIC = { behindBaseline: "zone_behind_baseline", baseline: "zone_baseline", midCourt: "zone_mid_court", net: "zone_net" } as const;

// Every value the tools can show, rounded the way they show it: what the claims of answers and reports are checked against.
export function sessionFacts(s: Session): Fact[] {
  const facts: Fact[] = [];
  const add = (player: Player | null, metric: Metric, value: number | string, decimals = 0, at?: string) => facts.push({ player, metric, value, decimals, at });
  add(null, "window_start", mmss(s.job.startSec));
  add(null, "window_end", mmss(windowEnd(s)));
  for (const m of s.metrics) {
    const p = m.player, v = playerMetricsView(s, m);
    add(p, "tracked_time", v.tracked);
    add(p, "coverage", v.coveragePct);
    add(p, "distance", v.distanceM);
    add(p, "avg_speed", v.avgSpeedMs, 2);
    add(p, "peak_speed", v.peakSpeedMs, 2);
    add(p, "depth_noise", v.depthNoiseM, 2);
    for (const [k, metric] of Object.entries(ZONE_METRIC)) add(p, metric, v.zonesPct[k]);
    for (const k of ["left", "center", "right"]) add(p, `lateral_${k}` as Metric, v.lateralPct[k]);
    v.sideChanges.forEach((t) => add(p, "side_change_time", t));
    m.perMinuteM.forEach((meters, i) => add(p, "minute_distance", meters, 1, mmss(s.job.startSec + i * 60)));
    for (const x of findMoments(s, p, "fastest", 5).moments) {
      add(p, "fastest_speed", x.speedMs!, 2, x.sourceTime);
      add(p, "fastest_time", x.sourceTime);
    }
    for (const x of findMoments(s, p, "longest_run", 5).moments) {
      add(p, "run_distance", x.distanceM!, 1, x.sourceTime);
      add(p, "run_duration", x.durationS!, 1, x.sourceTime);
      add(p, "run_time", x.sourceTime);
    }
    const net = findMoments(s, p, "net_visits", 5);
    add(p, "net_visit_count", net.count!);
    for (const x of net.moments) {
      add(p, "net_visit_duration", x.durationS!, 1, x.sourceTime);
      add(p, "net_visit_time", x.sourceTime);
    }
  }
  return facts;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const r = (v: number, d: number) => +v.toFixed(d);
const pct = (v: number) => Math.round(v * 100);

// --- tools ---
type Ctx = { s: Session; emit: (e: CoachEvent) => void; client: Client; signal?: AbortSignal; looks: number; facts: Fact[] };
const shown = (sec: number): Fact => ({ player: null, metric: "shown_time", value: mmss(sec), decimals: 0 });
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

type Place = { side: "near" | "far"; zone?: string; lateral: string };
type Moment = { sourceTime: string; sourceSec: number; speedMs?: number; from?: Place; to?: Place; distanceM?: number; durationS?: number };

// What the report is written from: the views the assistant's tools return, so its claims check against the same facts.
export function reportData(s: Session) {
  return {
    video: s.job.name,
    window: { from: mmss(s.job.startSec), to: mmss(windowEnd(s)) },
    players: s.metrics.map((m) => ({ ...playerMetricsView(s, m), minutes: m.perMinuteM.map((meters, i) => ({ from: mmss(s.job.startSec + i * 60), meters })) })),
  };
}

// Moments from the smoothed positions every metric uses. Times are source-video seconds.
export function findMoments(s: Session, player: "A" | "B", kind: string, limit = 3) {
  const { fps } = s.tracks;
  const segs = s.positions[player === "A" ? 0 : 1].smoothed;
  const reliable = s.metrics[player === "A" ? 0 : 1].reliable;
  const found: { at: number; value: number; extra?: number; from?: Sample; to?: Sample }[] = [];
  for (const seg of segs) {
    if (kind === "fastest") {
      for (let i = 0, j = 0; i < seg.length; i++) {
        while (j < seg.length && seg[j].f - seg[i].f < fps) j++;
        if (j < seg.length) found.push({ at: seg[i].f / fps, value: Math.hypot(seg[j].x - seg[i].x, seg[j].y - seg[i].y) / ((seg[j].f - seg[i].f) / fps), from: seg[i], to: seg[j] });
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
  // where the player ran from and to; the zone rests on depth, so only when it is reliable
  const where = (p: Sample): Place => {
    const side = p.y < COURT.net ? "near" : "far";
    const { zone, lateral } = place(p, side);
    return reliable ? { side, zone, lateral } : { side, lateral };
  };
  const moments: Moment[] = picked.map((m) => ({
    sourceTime: mmss(src(s, m.at)),
    sourceSec: r(src(s, m.at), 1),
    ...(kind === "fastest" ? { speedMs: r(m.value, 2), from: where(m.from!), to: where(m.to!) } : kind === "longest_run" ? { distanceM: r(m.value, 1), durationS: r(m.extra!, 1) } : { durationS: r(m.value, 1) }),
  }));
  return { player, kind, count: kind === "net_visits" ? found.length : undefined, moments, ...(reliable ? {} : { warning: "Depth-based, rough for this player." }) };
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
      c.facts.push(shown(Number(a.sourceSec)));
      return { shown: true, sourceTime: mmss(Number(a.sourceSec)) };
    case "look_at_clip": {
      const seconds = Number(a.seconds);
      if (!inWindow(a.sourceSec) || !(seconds >= 2 && seconds <= 8) || !inWindow(Number(a.sourceSec) + seconds)) return { error: "sourceSec must be inside the session and seconds 2-8" };
      if (c.looks >= MAX_CLIP_LOOKS) return { error: `at most ${MAX_CLIP_LOOKS} clip looks per question` };
      c.looks++;
      const seen = await lookAtClip(c, Number(a.sourceSec), seconds, String(a.question ?? "").slice(0, 300));
      c.facts.push(shown(Number(a.sourceSec)), shown(Number(a.sourceSec) + seconds));
      return seen;
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
  const c: Ctx = { s, emit, client, signal, looks: 0, facts: [...s.facts] };
  const rough = Object.fromEntries(s.metrics.map((m) => [m.player, !m.reliable])) as Record<Player, boolean>;
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
      const problems: Problem[] = text ? verify(text, Array.isArray(args.claims) ? args.claims : [], c.facts, { lang, rough }) : [{ subject: "text", why: "empty answer" }];
      if (!problems.length) {
        emit({ type: "answer", text, verified: true });
        result = { accepted: true };
        finished = true;
      } else if (++refusals >= MAX_REFUSALS) {
        emit({ type: "answer", text, verified: false });
        result = { accepted: false };
        finished = true;
      } else {
        const subjects = problems.map((p) => p.subject).join(", ");
        emit({ type: "refused", reason: lang === "tr" ? (text ? `veriyle uyuşmayan sayılar: ${subjects}` : "boş cevap") : text ? `numbers that do not match the data: ${subjects}` : "empty answer" });
        result = { error: `Refused. ${problems.map((p) => `${p.subject}: ${p.why}`).join("; ")}. Fix these, then call answer again with every number in the text listed as a claim.` };
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
    }
    input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
  }
  if (!finished) emit({ type: "error", message: lang === "tr" ? "Ajan tur sınırında cevap veremedi." : "The agent ran out of turns before answering." });
  emit({ type: "done", turns: turn, usage, costUsd: +(usage.input * PRICE.input + usage.output * PRICE.output).toFixed(4) });
}
