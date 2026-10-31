// Accuracy of the current pipeline against a known ground truth (synthetic sessions, see sim.ts), with the Phase 0 noise
// model. validate/step2.ts adds a far-player noise model matched to the hand-marked frames and compares V1 with V2.
// The noise model is matched to the real session: box height vs. foot row is fitted on its tracks, and the jitter and
// net-occlusion levels are tuned until the simulated players show the depth noise the app measures on the real ones.
// usage (from the repo root): node validate/synthetic.ts [--save]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { readJob, readTracks } from "../lib/jobs.ts";
import { analyze, playerPositions, V1 } from "../lib/metrics.ts";
import { farFixShift, REAL_CALIBRATION, simulate, type BoxModel, type Errors, type Noise } from "./sim.ts";

const BASE = "validate/baseline/synthetic.json";
const JOB = "d8650763e4d0";
const SEEDS = [1, 2, 3, 4, 5];

// depth noise the app reports per player, and how far the far-side fix moves the far player while slow
type Targets = { model: BoxModel; depthNoiseM: [number, number]; coverage: [number, number]; farFixShiftM: number };
type Baseline = { generatedAt: string; commit: string; targets: Targets; noise: ReturnType<typeof tune>; results: Record<"A" | "B", Summary> };
type Summary = Record<string, { mean: number; sd: number }>;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const saved: Baseline | null = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, "utf8")) : null;

// What the real session looks like; falls back to the values saved with the baseline when its data is not on this machine.
function realTargets(): Targets {
  const job = readJob(JOB);
  const tracks = job && readTracks(job);
  if (!job?.calibration || !tracks) {
    if (!saved) throw new Error(`no data for job ${JOB} and no ${BASE} to take the noise model from`);
    return saved.targets;
  }
  const metrics = analyze(tracks, job.calibration, V1);
  const players = playerPositions(tracks, job.calibration, V1).map((p) => Object.keys(p.objectFrames));
  const ids = players.flat();
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (const id of ids) {
    for (const [, , top, , bottom] of tracks.objects[id]) {
      sx += bottom;
      sy += bottom - top;
      sxx += bottom * bottom;
      sxy += bottom * (bottom - top);
      n++;
    }
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return {
    model: { a: (sy - b * sx) / n, b },
    depthNoiseM: [metrics[0].depthNoiseM, metrics[1].depthNoiseM],
    coverage: [metrics[0].coverage, metrics[1].coverage],
    farFixShiftM: farFixShift(tracks, job.calibration, players[1]),
  };
}

// Near: bottom jitter only. Far: jitter, how often the net cuts the box and by how much, matched on two numbers
// (the depth noise the app reports and the shift the far-side fix applies while the player is slow).
function tune(t: Targets): { near: Noise; far: Noise; farMatch: { depthNoiseM: number; farFixShiftM: number } } {
  const noise = (bottomPx: number, rho: number, occludeP: number, occludeMaxPx: number, coverage: number): Noise => ({ bottomPx, xPx: bottomPx, rho, occludeP, occludeMaxPx, dropP: 1 - coverage });
  const sims = (near: Noise, far: Noise) => [11, 12].map((seed) => simulate({ seed, model: t.model, near, far, method: V1 })); // the noise model was matched under V1
  let near = noise(1, 0.9, 0, 0, t.coverage[0]);
  let best = Infinity;
  for (const px of [0.5, 1, 2, 3, 4, 6]) {
    for (const rho of [0, 0.7, 0.9, 0.97]) {
      const cand = noise(px, rho, 0, 0, t.coverage[0]);
      const err = Math.abs(mean(sims(cand, near).map((r) => r.metrics[0].depthNoiseM)) - t.depthNoiseM[0]);
      if (err < best) [best, near] = [err, cand];
    }
  }
  let far = noise(1, 0.9, 0, 0, t.coverage[1]);
  let farMatch = { depthNoiseM: 0, farFixShiftM: 0 };
  best = Infinity;
  for (const px of [1, 2, 3, 4, 6]) {
    for (const rho of [0, 0.7, 0.9, 0.97]) {
      for (const [p, cut] of [[0, 0], [0.25, 4], [0.25, 8], [0.5, 4], [0.5, 8], [0.75, 8]]) {
        const cand = noise(px, rho, p, cut, t.coverage[1]);
        const runs = sims(near, cand);
        const dn = mean(runs.map((r) => r.metrics[1].depthNoiseM));
        const shift = mean(runs.map((r) => farFixShift(r.tracks, REAL_CALIBRATION, ["2"])));
        const err = Math.abs(dn - t.depthNoiseM[1]) / t.depthNoiseM[1] + Math.abs(shift - t.farFixShiftM) / Math.abs(t.farFixShiftM);
        if (err < best) [best, far, farMatch] = [err, cand, { depthNoiseM: +dn.toFixed(3), farFixShiftM: +shift.toFixed(3) }];
      }
    }
  }
  return { near, far, farMatch };
}

function summarize(errs: Errors[]): Summary {
  const flat = errs.map((e) => ({
    distancePct: e.distancePct, avgSpeedMs: e.avgSpeedMs, peakSpeedMs: e.peakSpeedMs, rmseXM: e.rmseXM, rmseYM: e.rmseYM, depthNoiseM: e.depthNoiseM,
    ...Object.fromEntries(Object.entries(e.zonesPp).map(([k, v]) => [`zone.${k}Pp`, v])),
    ...Object.fromEntries(Object.entries(e.lateralPp).map(([k, v]) => [`lateral.${k}Pp`, v])),
  })) as Record<string, number>[];
  return Object.fromEntries(Object.keys(flat[0]).map((k) => {
    const xs = flat.map((f) => f[k]);
    return [k, { mean: +mean(xs).toFixed(3), sd: +sd(xs).toFixed(3) }];
  }));
}

const targets = realTargets();
const noise = tune(targets);
const runs = SEEDS.map((seed) => simulate({ seed, model: targets.model, near: noise.near, far: noise.far }));
const results = { A: summarize(runs.map((r) => r.errors[0])), B: summarize(runs.map((r) => r.errors[1])) };

const fmt = (s: Summary, k: string, d = 2) => `${s[k].mean >= 0 ? "+" : ""}${s[k].mean.toFixed(d)} (sd ${s[k].sd.toFixed(d)})`;
console.log(`noise model: box height = ${targets.model.a.toFixed(1)} + ${targets.model.b.toFixed(3)} * foot row; near jitter ${noise.near.bottomPx} px (rho ${noise.near.rho}); far jitter ${noise.far.bottomPx} px (rho ${noise.far.rho}), net cuts the box up to ${noise.far.occludeMaxPx} px in ${noise.far.occludeP * 100}% of frames`);
console.log(`matched on the real session: depth noise A ${targets.depthNoiseM[0]} m (sim ${results.A.depthNoiseM.mean}), B ${targets.depthNoiseM[1]} m (sim ${noise.farMatch.depthNoiseM}); far-fix shift while slow ${targets.farFixShiftM.toFixed(2)} m (sim ${noise.farMatch.farFixShiftM})`);
for (const p of ["A", "B"] as const) {
  const s = results[p];
  console.log(`\nPlayer ${p} (${p === "A" ? "near" : "far"}), ${SEEDS.length} seeds x 300 s:`);
  console.log(`  distance error   ${fmt(s, "distancePct", 1)} %`);
  console.log(`  avg speed error  ${fmt(s, "avgSpeedMs")} m/s, peak (p95) error ${fmt(s, "peakSpeedMs")} m/s`);
  console.log(`  position RMSE    x ${s.rmseXM.mean.toFixed(2)} m, depth ${s.rmseYM.mean.toFixed(2)} m`);
  console.log(`  zone share error behind ${fmt(s, "zone.behindBaselinePp", 1)}, baseline ${fmt(s, "zone.baselinePp", 1)}, mid ${fmt(s, "zone.midCourtPp", 1)}, net ${fmt(s, "zone.netPp", 1)} pp`);
  if (saved) {
    const prev = saved.results[p];
    const changed = Object.keys(s).filter((k) => prev[k] && Math.abs(prev[k].mean - s[k].mean) > 1e-6);
    console.log(changed.length ? `  vs baseline: ${changed.map((k) => `${k} ${prev[k].mean} -> ${s[k].mean}`).join(", ")}` : "  vs baseline: unchanged");
  }
}

if (process.argv.includes("--save")) {
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  const out: Baseline = { generatedAt: new Date().toISOString(), commit, targets, noise, results };
  fs.writeFileSync(BASE, JSON.stringify(out, null, 1) + "\n");
  console.log(`\nsaved ${BASE}`);
}
