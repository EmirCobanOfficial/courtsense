// Step 2 before/after: V1 (the hackathon version) vs V2 on synthetic sessions with a known truth, Player A and Player B
// separately, under two far-player noise models: Phase 0's (matched on the session's jitter, see synthetic.ts) and one
// matched to the hand-marked frames (how far above the feet SAM's far box ends, and V1's depth error there). Also how
// often a zone range contains the true share, and what changes on the real session. No API calls.
// usage (from the repo root): node validate/step2.ts [--save]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { applyHomography, CALIBRATION_POINTS, COURT, solveHomography, type Pt } from "../lib/court.ts";
import { readJob, readTracks } from "../lib/jobs.ts";
import { analyze, playerPositions, V1, V2, type Method, type PlayerMetrics } from "../lib/metrics.ts";
import { DIR, LABELS, loadSystem, systemAt, type Labels, type Manifest } from "./annotate/system.ts";
import { REAL_CALIBRATION, simulate, truthMetrics, type BoxModel, type Noise, type SimRun } from "./sim.ts";

const BASE = "validate/baseline/step2.json";
const SEEDS = [1, 2, 3, 4, 5];
const phase0 = JSON.parse(fs.readFileSync("validate/baseline/synthetic.json", "utf8")) as { targets: { model: BoxModel }; noise: { near: Noise; far: Noise } };
const model = phase0.targets.model;
type Targets = { shortPx: number; biasM: number; rmseM: number };
const saved = fs.existsSync(BASE) ? (JSON.parse(fs.readFileSync(BASE, "utf8")) as { targets: Targets; farMarks: Noise }) : null;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const rms = (v: number[]) => Math.sqrt(mean(v.map((x) => x * x)));
const median = (v: number[]) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
const r2 = (x: number) => +x.toFixed(2);

// V1 on the far player's hand-marked frames: how far above the marked feet the SAM box ends (px), and the depth error
// of V1's far-side fix (bias, and RMSE with the hand marks' own noise taken out)
function markTargets(): Targets {
  if (!fs.existsSync(LABELS)) {
    if (!saved) throw new Error(`no hand marks (${LABELS}) and no ${BASE} to take the targets from`);
    return saved.targets;
  }
  const sys = loadSystem(V1);
  const M = JSON.parse(fs.readFileSync(`${DIR}/frames.json`, "utf8")) as Manifest;
  const L = JSON.parse(fs.readFileSync(LABELS, "utf8")).labels as Labels;
  const short: number[] = [], err: number[] = [], again: number[] = [];
  for (const fr of M.frames) {
    const m = L[fr.id]?.B, s = Array.isArray(m) ? systemAt(sys, 1, fr.f) : null;
    if (!s || !Array.isArray(m)) continue;
    const mc = applyHomography(sys.toCourt, m);
    if (mc[1] < COURT.net) continue;
    if (fr.repeatOf) {
      const first = L[fr.repeatOf]?.B;
      if (Array.isArray(first)) again.push(Math.hypot(...(applyHomography(sys.toCourt, first).map((v, k) => v - mc[k]) as Pt)));
      continue;
    }
    short.push(m[1] - s.bottomPx[1]);
    err.push(s.fixed[1] - mc[1]);
  }
  const markNoise = again.length ? rms(again) / Math.SQRT2 : 0;
  return { shortPx: r2(median(short)), biasM: r2(mean(err)), rmseM: r2(Math.sqrt(Math.max(0, rms(err) ** 2 - markNoise ** 2))) };
}

// the same three numbers on a simulated far player, against its true positions
function farStats(runs: SimRun[]): Targets {
  const toImage = solveHomography(CALIBRATION_POINTS.map((p) => p.world), REAL_CALIBRATION);
  const short: number[] = [], err: number[] = [];
  for (const run of runs) {
    const truth = new Map(run.truth[1].map((s) => [s.f, s]));
    for (const b of run.tracks.objects["2"]) short.push(applyHomography(toImage, [truth.get(b[0])!.x, truth.get(b[0])!.y])[1] - b[4]);
    for (const s of playerPositions(run.tracks, REAL_CALIBRATION, V1)[1].raw.flat()) err.push(s.y - truth.get(s.f)!.y);
  }
  return { shortPx: r2(median(short)), biasM: r2(mean(err)), rmseM: r2(rms(err)) };
}

function tuneFar(t: Targets): Noise {
  let best: { score: number; noise: Noise } = { score: Infinity, noise: phase0.noise.far };
  for (const shortPx of [1, 1.5, 2, 2.5, 3]) for (const bottomPx of [1.5, 2.5, 3.5]) for (const rho of [0.6, 0.8, 0.9, 0.97]) {
    const noise = { ...phase0.noise.far, shortPx, bottomPx, xPx: bottomPx, rho };
    const got = farStats([11, 12].map((seed) => simulate({ seed, model, near: phase0.noise.near, far: noise, method: V1 })));
    const score = Math.abs(got.shortPx - t.shortPx) + Math.abs(got.biasM - t.biasM) / 0.3 + Math.abs(got.rmseM - t.rmseM) / 0.3;
    if (score < best.score) best = { score, noise };
  }
  return best.noise;
}

const ZONES = ["behindBaseline", "baseline", "midCourt", "net"] as const;
function summary(method: Method, far: Noise) {
  const runs = SEEDS.map((seed) => simulate({ seed, model, near: phase0.noise.near, far, method }));
  return (["A", "B"] as const).map((_, i) => {
    const e = runs.map((r) => r.errors[i]);
    let inRange = 0;
    for (const r of runs) {
      const t = truthMetrics(r.truth[i], r.tracks.fps).zones, m = r.metrics[i];
      for (const k of ZONES) if (t[k] >= m.zoneRanges[k][0] - 1e-9 && t[k] <= m.zoneRanges[k][1] + 1e-9) inRange++;
    }
    return {
      "distance error %": r2(mean(e.map((x) => x.distancePct))),
      "avg speed error m/s": r2(mean(e.map((x) => x.avgSpeedMs))),
      "peak speed error m/s": r2(mean(e.map((x) => x.peakSpeedMs))),
      "depth RMSE m": r2(mean(e.map((x) => x.rmseYM))),
      "lateral RMSE m": r2(mean(e.map((x) => x.rmseXM))),
      ...Object.fromEntries(ZONES.map((k) => [`${k} share error pp`, r2(mean(e.map((x) => x.zonesPp[k])))])),
      "zone ranges holding the truth": `${inRange}/${runs.length * ZONES.length}`,
      "flagged reliable": `${e.filter((x) => x.reliable).length}/${runs.length}`,
    };
  });
}

const targets = markTargets();
const farMarks = tuneFar(targets);
const check = farStats([11, 12].map((seed) => simulate({ seed, model, near: phase0.noise.near, far: farMarks, method: V1 })));
console.log(`far noise matched to the hand marks: box ends ${farMarks.shortPx} px above the feet, wander ${farMarks.bottomPx} px (rho ${farMarks.rho})`);
console.log(`  targets (V1 on the marks): ${JSON.stringify(targets)}; this model gives ${JSON.stringify(check)}`);

const results: Record<string, unknown> = {};
for (const [label, far] of [["Phase 0 noise model", phase0.noise.far], ["far noise matched to the hand marks", farMarks]] as const) {
  const [a1, b1] = summary(V1, far), [a2, b2] = summary(V2, far);
  results[label] = { A: { V1: a1, V2: a2 }, B: { V1: b1, V2: b2 } };
  console.log(`\nsynthetic sessions, ${label} (${SEEDS.length} seeds x 300 s); errors are measured minus true:`);
  console.table(Object.fromEntries(Object.keys(a1).map((k) => [k, { "A V1": a1[k as keyof typeof a1], "A V2": a2[k as keyof typeof a2], "B V1": b1[k as keyof typeof b1], "B V2": b2[k as keyof typeof b2] }])));
}

// the coach's session: what the coach would see change
const job = readJob("d8650763e4d0");
const tracks = job && readTracks(job);
if (job?.calibration && tracks) {
  const show = (m: PlayerMetrics) => ({
    "distance m": m.distanceM, "avg speed m/s": m.avgSpeed, "peak speed m/s": m.peakSpeed, "depth noise m": m.depthNoiseM, reliable: m.reliable,
    ...Object.fromEntries(ZONES.map((k) => [`${k} %`, `${(m.zones[k] * 100).toFixed(1)} (${(m.zoneRanges[k][0] * 100).toFixed(0)}-${(m.zoneRanges[k][1] * 100).toFixed(0)})`])),
  });
  const [a1, b1] = analyze(tracks, job.calibration, V1).map(show), [a2, b2] = analyze(tracks, job.calibration, V2).map(show);
  results.session = { A: { V1: a1, V2: a2 }, B: { V1: b1, V2: b2 } };
  console.log("\nthe coach's session (no truth here; zone % with its range):");
  console.table(Object.fromEntries(Object.keys(a1).map((k) => [k, { "A V1": a1[k as keyof typeof a1], "A V2": a2[k as keyof typeof a2], "B V1": b1[k as keyof typeof b1], "B V2": b2[k as keyof typeof b2] }])));
}

if (process.argv.includes("--save")) {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  fs.writeFileSync(BASE, JSON.stringify({ generatedAt: new Date().toISOString(), commit, V1, V2, targets, farMarks, results }, null, 1) + "\n");
  console.log(`\nsaved ${BASE}`);
}
