// A real SAM 3.1 run at 7.5 fps against the 15 fps baseline, on the coach's session. SAM bills per frame, so half the
// frames is half the cost; this checks what that does to tracking and to the metrics.
// The 7.5 fps clip keeps every second frame of the 15 fps clip, so its frame k is the baseline's frame 2k: positions
// compare frame for frame, and so do the hand-marked frames with an even index.
// usage (from the repo root): node --env-file=.env.local validate/fps-test.ts [--run] [--save] [--job <id>]
//   --run   makes the 7.5 fps job and sends it to SAM 3.1 (one request, about $1.07 for this session)
//   --save  writes the comparison to validate/baseline/fps-7.5.json (fps-7.5-<id>.json with --job)
//   --job   compares another 7.5 fps job of this session instead, e.g. one uploaded in Economy mode through the app.
//           Its clip is cut from the source at 7.5 fps, so its frame k is again the baseline's frame 2k in time.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { applyHomography, CALIBRATION_POINTS, COURT, solveHomography, type Pt } from "../lib/court.ts";
import { jobDir, jobFile, processJob, readJob, readTracks, writeJob, type Job } from "../lib/jobs.ts";
import { analyze, playerPositions, type Sample, type Tracks } from "../lib/metrics.ts";

const BASE = "d8650763e4d0";
const jobArg = process.argv.indexOf("--job");
const TEST = jobArg > 0 ? process.argv[jobArg + 1] : crypto.createHash("sha1").update(`fps-7.5:${BASE}`).digest("hex").slice(0, 12);
const base = readJob(BASE);
if (!base?.calibration) throw new Error(`job ${BASE} with its calibration is needed on this machine`);

if (process.argv.includes("--run") && jobArg < 0 && !fs.existsSync(jobFile(TEST, "tracks.json"))) {
  fs.mkdirSync(jobDir(TEST), { recursive: true });
  if (!fs.existsSync(jobFile(TEST, "clip.mp4"))) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", jobFile(BASE, "clip.mp4"), "-vf", "select=not(mod(n\\,2)),setpts=N/7.5/TB", "-r", "7.5",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", jobFile(TEST, "clip.mp4")]);
    fs.copyFileSync(jobFile(BASE, "frame.jpg"), jobFile(TEST, "frame.jpg"));
  }
  const job: Job = { ...base, id: TEST, name: `${base.name} · 7.5 fps test`, fps: 7.5, status: "preprocessing", progress: 0, createdAt: new Date().toISOString(), error: undefined };
  writeJob(job);
  await processJob(TEST); // one SAM 3.1 request, billed per frame
  const done = readJob(TEST)!;
  if (done.status !== "ready") throw new Error(`7.5 fps job ended as ${done.status}: ${done.error}`);
}

const tracksOf = (id: string) => readTracks(readJob(id)!)!;
const t15 = tracksOf(BASE), t75 = fs.existsSync(jobFile(TEST, "tracks.json")) ? tracksOf(TEST) : null;
if (!t75) throw new Error("no 7.5 fps tracks yet: run with --run (one SAM request, about $1.07)");
const cal = base.calibration;
const H = solveHomography(cal, CALIBRATION_POINTS.map((p) => p.world));

// tracking: ids per player, track pieces, ids that ever switched court half or player, crowded frames
function tracking(t: Tracks) {
  const pos = playerPositions(t, cal);
  const sides = new Map<string, Set<string>>();
  let crowded = 0;
  const perFrame = new Map<number, number>();
  for (const [id, boxes] of Object.entries(t.objects)) for (const [f, l, , r, b] of boxes) {
    if (b >= t.height - 2 || l <= 1 || r >= t.width - 2) continue;
    const [x, y] = applyHomography(H, [(l + r) / 2, b]);
    if (Math.abs(x) > COURT.doublesHalf + 3 || y < -8 || y > COURT.length + 8) continue;
    perFrame.set(f, (perFrame.get(f) ?? 0) + 1);
    if (Math.abs(y - COURT.net) > 2) (sides.get(id) ?? sides.set(id, new Set()).get(id)!).add(y < COURT.net ? "near" : "far");
  }
  for (const n of perFrame.values()) if (n > 2) crowded++;
  const ids = pos.map((p) => Object.keys(p.objectFrames));
  // every object SAM tracked in the request (people off court too), and when the last new one first shows up
  const firsts = Object.values(t.objects).filter((b) => b.length).map((b) => b[0][0]);
  const at = base!.startSec + Math.max(...firsts) / t.fps;
  return {
    samObjects: firsts.length,
    lastNewObjectAt: `${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}`,
    idsPerPlayer: ids.map((x) => x.length),
    trackPieces: pos.map((p) => p.raw.length),
    idsOnBothSides: [...sides.values()].filter((s) => s.size === 2).length,
    idsTradedBetweenPlayers: ids[0].filter((id) => ids[1].includes(id)).length,
    framesWithMoreThanTwoPeople: crowded,
  };
}

// frame by frame at the same instants: the 7.5 fps frame k against the 15 fps frame 2k
const byFrame = (segs: Sample[][]) => new Map(segs.flat().map((s) => [s.f, s]));
const p15 = playerPositions(t15, cal), p75 = playerPositions(t75, cal);
const rms = (v: number[]) => (v.length ? +Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length).toFixed(2) : null);
const frames75 = Math.min(t75.frames, Math.round(((base.endSec ?? Infinity) - base.startSec) * t75.fps));
const matched = [0, 1].map((i) => {
  const a = byFrame(p15[i].raw), b = byFrame(p75[i].raw), sa = byFrame(p15[i].smoothed), sb = byFrame(p75[i].smoothed);
  let both = 0, only15 = 0, only75 = 0;
  const raw: number[] = [], smooth: number[] = [];
  for (let k = 0; k < frames75; k++) {
    const x = a.get(2 * k), y = b.get(k);
    if (x && y) {
      both++;
      raw.push(Math.hypot(x.x - y.x, x.y - y.y));
      const u = sa.get(2 * k), w = sb.get(k);
      if (u && w) smooth.push(Math.hypot(u.x - w.x, u.y - w.y));
    } else if (x) only15++;
    else if (y) only75++;
  }
  return { framesBoth: both, missedAt75: only15, missedAt15: only75, rawDiffRmsM: rms(raw), smoothedDiffRmsM: rms(smooth) };
});

// hand-marked feet (data/validation, both sets) on even frames: the error of each run's smoothed position
type Manifest = { frames: { id: string; f: number; repeatOf?: string }[] };
const hand = [0, 1].map(() => ({ e15: [] as number[], e75: [] as number[] }));
for (const set of ["", "-test"]) {
  const manifest = `data/validation/annotate/${BASE}${set}/frames.json`, labels = `data/validation/annotations-${BASE}${set}.json`;
  if (!fs.existsSync(manifest) || !fs.existsSync(labels)) continue;
  const m: Manifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const l: Record<string, Partial<Record<"A" | "B", Pt | "hidden">>> = JSON.parse(fs.readFileSync(labels, "utf8")).labels;
  for (const fr of m.frames) {
    if (fr.repeatOf || fr.f % 2) continue;
    (["A", "B"] as const).forEach((p, i) => {
      const mark = l[fr.id]?.[p];
      if (!mark || mark === "hidden") return;
      const [x, y] = applyHomography(H, mark);
      const a = byFrame(p15[i].smoothed).get(fr.f), b = byFrame(p75[i].smoothed).get(fr.f / 2);
      if (a && b) { hand[i].e15.push(Math.hypot(a.x - x, a.y - y)); hand[i].e75.push(Math.hypot(b.x - x, b.y - y)); }
    });
  }
}

const metrics = (t: Tracks) => analyze(t, cal).map((m) => ({
  distanceM: m.distanceM, avgSpeed: m.avgSpeed, peakSpeed: m.peakSpeed, behindBaseline: m.zones.behindBaseline,
  coverage: m.coverage, depthNoiseM: m.depthNoiseM, reliable: m.reliable,
}));
const thinned: Tracks = { ...t15, fps: t15.fps / 2, frames: Math.ceil(t15.frames / 2),
  objects: Object.fromEntries(Object.entries(t15.objects).map(([id, bs]) => [id, bs.filter((b) => b[0] % 2 === 0).map((b) => [b[0] / 2, ...b.slice(1)] as typeof b)])) };
const out = {
  job: { base: BASE, test: TEST },
  // SAM bills the whole clip it was sent ($0.20 per 1,000 frames), not only the analysis window
  framesSentToSam: { fps15: base.frames, fps7_5: readJob(TEST)!.frames },
  costUsd: { fps15: +(base.frames! * 0.0002).toFixed(2), fps7_5: +(readJob(TEST)!.frames! * 0.0002).toFixed(2) },
  metrics: { fps15: metrics(t15), fps7_5: metrics(t75), fps7_5Simulated: metrics(thinned) },
  tracking: { fps15: tracking(t15), fps7_5: tracking(t75) },
  sameInstants: { A: matched[0], B: matched[1] },
  handMarkedEvenFrames: { A: { n: hand[0].e15.length, rmse15: rms(hand[0].e15), rmse7_5: rms(hand[0].e75) }, B: { n: hand[1].e15.length, rmse15: rms(hand[1].e15), rmse7_5: rms(hand[1].e75) } },
};
console.log(JSON.stringify(out, null, 1));
if (process.argv.includes("--save")) fs.writeFileSync(`validate/baseline/fps-7.5${jobArg > 0 ? `-${TEST}` : ""}.json`, JSON.stringify(out, null, 1) + "\n");
