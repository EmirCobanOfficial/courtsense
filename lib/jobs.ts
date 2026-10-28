// Job storage on disk plus the processing pipeline: ffmpeg preprocessing, then one SAM 3.1 video request.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { frameIndexOf, parseVideoStream, recordsOfKind } from "@meta-sam/parser";
import type { Box, Tracks } from "./metrics.ts";
import type { Pt } from "./court.ts";

export const DATA = path.join(process.cwd(), "data");
const FPS = 15; // enough for footwork; also keeps the per-frame SAM bill low
const WIDTH = 1920; // the far player is ~40 px tall at 1080p, still detected
const MAX_FRAMES = 15000; // SAM 3.1 limit per request
const PROMPT = "tennis player";

export type Job = {
  id: string;
  name: string;
  startSec: number;
  // Analysis stops here (seconds in the source video). Not part of the id, so moving it never re-runs SAM.
  // shortcut: a later end than the processed clip covers is cut to the clip; re-upload with a new start to extend.
  endSec?: number;
  createdAt: string;
  status: "uploading" | "preprocessing" | "segmenting" | "ready" | "error";
  progress: number; // 0..1 within the current status
  error?: string;
  frames?: number;
  width?: number;
  height?: number;
  truncated?: boolean;
  calibration?: Pt[];
};

export const isJobId = (id: string) => /^[a-f0-9]{12}$/.test(id);
export const jobDir = (id: string) => path.join(DATA, id);
export const jobFile = (id: string, f: string) => path.join(jobDir(id), f);

// Same file + same start time gives the same id, so a re-upload reuses paid SAM results.
export const jobIdFor = (name: string, size: number, startSec: number) =>
  crypto.createHash("sha1").update(`${name}|${size}|${startSec}`).digest("hex").slice(0, 12);

export function readJob(id: string): Job | null {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id, "job.json"), "utf8"));
  } catch {
    return null;
  }
}

export function writeJob(job: Job) {
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  const tmp = jobFile(job.id, "job.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
  fs.renameSync(tmp, jobFile(job.id, "job.json"));
}

export function listJobs(): Job[] {
  if (!fs.existsSync(DATA)) return [];
  return fs
    .readdirSync(DATA)
    .filter(isJobId)
    .map(readJob)
    .filter((j): j is Job => j !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// SAM tracks for the job, cut at its end time.
export function readTracks(job: Job): Tracks | null {
  let tracks: Tracks;
  try {
    tracks = JSON.parse(fs.readFileSync(jobFile(job.id, "tracks.json"), "utf8"));
  } catch {
    return null;
  }
  if (job.endSec === undefined) return tracks;
  const frames = Math.min(tracks.frames, Math.round((job.endSec - job.startSec) * tracks.fps));
  const objects = Object.fromEntries(Object.entries(tracks.objects).map(([id, boxes]) => [id, boxes.filter((b) => b[0] < frames)]));
  return { ...tracks, frames, objects };
}

const running = new Set<string>();

// Idempotent: finished steps are skipped, so a retry after a crash never re-runs paid work that already succeeded.
export async function processJob(id: string) {
  if (running.has(id)) return;
  running.add(id);
  const update = (patch: Partial<Job>) => writeJob({ ...readJob(id)!, ...patch });
  try {
    const job = readJob(id)!;
    const clip = jobFile(id, "clip.mp4");
    if (!fs.existsSync(clip)) {
      update({ status: "preprocessing", progress: 0, error: undefined });
      await preprocess(jobFile(id, "source"), clip, job.startSec, job.endSec, (p) => update({ progress: p }));
      await run("ffmpeg", ["-v", "error", "-y", "-i", clip, "-frames:v", "1", jobFile(id, "frame.jpg")]);
      fs.rmSync(jobFile(id, "source"), { force: true }); // the 4K original is no longer needed
    }
    const info = await probe(clip);
    update({ ...info, truncated: info.frames >= MAX_FRAMES });
    if (!fs.existsSync(jobFile(id, "tracks.json"))) {
      update({ status: "segmenting", progress: 0, error: undefined });
      await segment(id, clip, info, (p) => update({ progress: p }));
    }
    update({ status: "ready", progress: 1, error: undefined });
  } catch (e) {
    update({ status: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    running.delete(id);
  }
}

async function preprocess(src: string, out: string, startSec: number, endSec: number | undefined, onProgress: (p: number) => void) {
  const { duration } = await probe(src, false);
  // shortcut: one SAM request caps at 15,000 frames (~16 min at 15 fps); chunk the clip to support full matches.
  const total = Math.min(Math.min(endSec ?? duration, duration) - startSec, MAX_FRAMES / FPS);
  if (total <= 0) throw new Error(`start ${startSec}s is past the end of the video (${duration.toFixed(0)}s)`);
  let last = 0;
  await run(
    "ffmpeg",
    [
      "-v", "error", "-y", "-hwaccel", "auto", "-ss", String(startSec), "-i", src,
      "-t", String(total), "-map", "0:v:0", "-an",
      "-vf", `scale=${WIDTH}:-2,fps=${FPS}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out,
    ],
    (line) => {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m && Date.now() - last > 2000) {
        last = Date.now();
        onProgress(Math.min(1, +m[1] / 1e6 / total));
      }
    },
  );
}

async function segment(id: string, clip: string, info: { frames: number; width: number; height: number }, onProgress: (p: number) => void) {
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not set in .env.local");
  const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
  const file = await client.files.create({ file: fs.createReadStream(clip), purpose: "user_data" });

  // input_video is a Meta extension the OpenAI SDK types do not know about
  const params = {
    model: "sam-3.1",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: PROMPT },
        { type: "input_video", file_id: file.id },
      ],
    }],
    stream: true,
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
  } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;
  const events = await client.responses.create(params);
  recordUsage(id, info.frames); // billed per input frame once the request is accepted

  // Keep the raw output (masks included) so later features never pay for the same video twice.
  const raw = fs.createWriteStream(jobFile(id, "sam_raw.txt"));
  async function* tee() {
    // finally: the parser stops at response.completed and return()s this generator, skipping code after the loop
    try {
      for await (const e of events) {
        if (e.type === "response.output_text.delta") raw.write(e.delta);
        yield e;
      }
    } finally {
      raw.end();
    }
  }

  const parsed = parseVideoStream(tee());
  let last = 0;
  for await (const snap of parsed) {
    const rec = snap.records.at(-1);
    const f = rec ? frameIndexOf(rec) : undefined;
    if (f !== undefined && Date.now() - last > 2000) {
      last = Date.now();
      onProgress(Math.min(1, f / info.frames));
    }
  }
  const result = await parsed.finalResult;
  if (result.outcome.status !== "completed") throw new Error(`SAM stopped early: ${JSON.stringify(result.outcome)}`);

  const objects: Record<string, Box[]> = {};
  for (const b of recordsOfKind(result.records, "box")) {
    (objects[b.objectId] ??= []).push([frameIndexOf(b) ?? -1, b.left, b.top, b.right, b.bottom, b.confidence ?? null]);
  }
  const tracks: Tracks = { fps: FPS, ...info, objects };
  fs.writeFileSync(jobFile(id, "tracks.json"), JSON.stringify(tracks));
}

function recordUsage(id: string, frames: number) {
  const file = path.join(DATA, "usage.json");
  let usage = { totalFrames: 0, runs: [] as { id: string; frames: number; at: string }[] };
  try {
    usage = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  usage.totalFrames += frames;
  usage.runs.push({ id, frames, at: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(usage, null, 2));
}

// Counting packets reads the whole file, so only do it for the small clip, not the 4K source.
async function probe(file: string, countFrames = true) {
  let out = "";
  await run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", ...(countFrames ? ["-count_packets"] : []), "-show_entries", "stream=width,height,nb_read_packets:format=duration", "-of", "json", file],
    (l) => (out += l),
  );
  const j = JSON.parse(out);
  const s = j.streams[0];
  return { width: s.width as number, height: s.height as number, frames: +s.nb_read_packets, duration: +j.format.duration };
}

function run(cmd: string, args: string[], onLine?: (line: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      lines.forEach((l) => onLine?.(l));
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (buf) onLine?.(buf);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`));
    });
  });
}
