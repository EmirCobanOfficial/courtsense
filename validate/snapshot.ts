// Frozen baseline of the real session: what the app computes today (metrics, the assistant's moments), saved so every
// later change is measured against it. Compares by default; --save writes the baseline.
// usage (from the repo root): node validate/snapshot.ts [jobId] [--save]
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { isJobId, jobFile, readJob, readTracks } from "../lib/jobs.ts";
import { findMoments, loadSession } from "../lib/coach.ts";

const id = process.argv.slice(2).find(isJobId) ?? "d8650763e4d0";
const BASE = `validate/baseline/session-${id}.json`;
const job = readJob(id);
const tracks = job && readTracks(job);
if (!job?.calibration || !tracks) throw new Error(`job ${id} has no calibration or tracks on this machine`);

const s = loadSession(job, tracks, jobFile(id, "clip.mp4"));
const result = {
  metrics: s.metrics,
  segments: s.positions.map((p) => p.raw.length),
  moments: Object.fromEntries((["A", "B"] as const).flatMap((p) => ["fastest", "longest_run", "net_visits"].map((k) => [`${p}.${k}`, findMoments(s, p, k, 5)]))),
};
const meta = {
  jobId: id,
  window: { startSec: job.startSec, endSec: job.endSec, frames: tracks.frames, fps: tracks.fps },
  calibration: job.calibration,
  tracksSha256: crypto.createHash("sha256").update(fs.readFileSync(jobFile(id, "tracks.json"))).digest("hex"),
};

// leaf-by-leaf differences between two JSON values
function diff(a: unknown, b: unknown, at = ""): string[] {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) > 1e-9 ? [`${at}: ${a} -> ${b}`] : [];
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
}

const row = (m: (typeof s.metrics)[number]) =>
  `${m.player}: ${m.distanceM} m, avg ${m.avgSpeed} m/s, peak ${m.peakSpeed} m/s, behind ${Math.round(m.zones.behindBaseline * 100)}%, ` +
  `baseline ${Math.round(m.zones.baseline * 100)}%, mid ${Math.round(m.zones.midCourt * 100)}%, net ${Math.round(m.zones.net * 100)}%, ` +
  `depth noise ${m.depthNoiseM} m${m.reliable ? "" : " (rough)"}, coverage ${Math.round(m.coverage * 100)}%`;
console.log(s.metrics.map(row).join("\n"));

if (process.argv.includes("--save")) {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  fs.writeFileSync(BASE, JSON.stringify({ meta: { ...meta, commit, generatedAt: new Date().toISOString() }, result }, null, 1) + "\n");
  console.log(`saved ${BASE}`);
} else if (fs.existsSync(BASE)) {
  const base = JSON.parse(fs.readFileSync(BASE, "utf8"));
  if (base.meta.tracksSha256 !== meta.tracksSha256) console.log("note: tracks.json changed since the baseline (new SAM run?)");
  const changes = diff(base.result, JSON.parse(JSON.stringify(result)));
  console.log(changes.length ? `${changes.length} values differ from ${BASE}:\n${changes.slice(0, 60).join("\n")}${changes.length > 60 ? "\n..." : ""}` : `identical to ${BASE}`);
} else console.log(`no baseline yet: run with --save`);
