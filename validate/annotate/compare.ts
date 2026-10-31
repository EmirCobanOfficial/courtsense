// Step 3: compare the hand marks with what the app computed for the same frames, once enough frames are marked.
// Per side of the court, in court meters (lateral = across the court, depth = along it, + = farther from the camera):
// the error of the SAM box's bottom-center, of the far-side-fixed point the metrics start from, and of the smoothed
// point they are measured on, with 95% intervals from resampling the frames. In pixels: how far the box bottom sits
// from the marked feet (what sim.ts's noise model should match). Frames shown twice measure how repeatable the hand
// marks are. What this does not measure is printed with every result.
// usage (from the repo root): node validate/annotate/compare.ts [--save] [--self-check]
//   --save: freeze this result as the before/after baseline, validate/baseline/annotation-compare.json (aggregate
//           numbers only; the marks themselves stay in data/)
//   --self-check: marks placed on the box bottoms (the repeats 1 px off) must give zero box error and a 1.41 px repeat
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { applyHomography, COURT, type Pt } from "../../lib/court.ts";
import { DIR, JOB, LABELS, loadSystem, systemAt, type Labels, type Manifest } from "./system.ts";

const MIN_MARKS = 10; // below this, no numbers at all
const MIN_SIDE = 10; // below this, a side's numbers are printed but flagged as too few to read
const BASE = "validate/baseline/annotation-compare.json";
const sys = loadSystem();
const M = JSON.parse(fs.readFileSync(`${DIR}/frames.json`, "utf8")) as Manifest;
const SELF = process.argv.includes("--self-check");
const L: Labels = SELF
  ? Object.fromEntries(M.frames.map((fr) => [fr.id, Object.fromEntries((["A", "B"] as const).map((p, i) => {
      const [x, y] = systemAt(sys, i as 0 | 1, fr.f)!.bottomPx;
      return [p, fr.repeatOf ? [x + 1, y + 1] : [x, y]];
    }))]))
  : fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, "utf8")).labels : {};
const sideOf = (court: Pt) => (court[1] < COURT.net ? "near" : "far");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const version = { commit: git("rev-parse", "--short", "HEAD"), uncommittedChanges: git("status", "--porcelain", "--", "lib").length > 0 };

type Row = { player: "A" | "B"; side: string; mark: Pt; markCourt: Pt; s: NonNullable<ReturnType<typeof systemAt>> };
const rows: Row[] = [];
const hidden = { A: 0, B: 0 };
const originals = M.frames.filter((x) => !x.repeatOf);
for (const fr of originals) {
  (["A", "B"] as const).forEach((p, i) => {
    const m = L[fr.id]?.[p];
    if (m === "hidden") hidden[p]++;
    const s = Array.isArray(m) ? systemAt(sys, i as 0 | 1, fr.f) : null;
    if (!s || !Array.isArray(m)) return;
    const markCourt = applyHomography(sys.toCourt, m);
    rows.push({ player: p, side: sideOf(markCourt), mark: m, markCourt, s });
  });
}
console.log(`${rows.length} marked positions in ${originals.length} frames; marked not visible: A ${hidden.A}, B ${hidden.B}. App version ${version.commit}${version.uncommittedChanges ? " + uncommitted changes in lib/" : ""}.`);
if (rows.length < MIN_MARKS) {
  console.log(`Mark at least ${MIN_MARKS} positions (ideally every frame) first: no accuracy numbers yet.`);
  process.exit(0);
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const rms = (v: number[]) => Math.sqrt(mean(v.map((x) => x * x)));
const sd = (v: number[]) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
const r2 = (x: number) => +x.toFixed(2);
// 95% interval by resampling the frames (fixed seed, so reruns agree)
function interval<T>(items: T[], stat: (v: T[]) => number): [number, number] {
  let seed = 12345;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const out = Array.from({ length: 2000 }, () => stat(items.map(() => items[Math.floor(rand() * items.length)]))).sort((a, b) => a - b);
  return [r2(out[49]), r2(out[1949])];
}
type Stat = { v: number; ci: [number, number] };
const stat = <T>(items: T[], f: (v: T[]) => number): Stat => ({ v: r2(f(items)), ci: interval(items, f) });
const show = (s: Stat) => `${s.v} [${s.ci[0]}, ${s.ci[1]}]`;

// system minus mark, in court meters
function meters(rs: Row[], pick: (r: Row) => Pt | null) {
  const e = rs.flatMap((r) => {
    const p = pick(r);
    return p ? [[p[0] - r.markCourt[0], p[1] - r.markCourt[1]] as Pt] : [];
  });
  if (!e.length) return null;
  return {
    n: e.length,
    biasLateral: stat(e, (v) => mean(v.map((d) => d[0]))),
    biasDepth: stat(e, (v) => mean(v.map((d) => d[1]))),
    rmseLateral: stat(e, (v) => rms(v.map((d) => d[0]))),
    rmseDepth: stat(e, (v) => rms(v.map((d) => d[1]))),
    rmse: stat(e, (v) => rms(v.map(([x, y]) => Math.hypot(x, y)))),
  };
}
// box bottom-center minus mark, in image pixels (+y = lower in the image); a box cut short by the net ends above the feet
function pixels(rs: Row[]) {
  const dx = rs.map((r) => r.s.bottomPx[0] - r.mark[0]), dy = rs.map((r) => r.s.bottomPx[1] - r.mark[1]);
  return { n: rs.length, biasX: r2(mean(dx)), sdX: r2(sd(dx)), biasBottom: r2(mean(dy)), sdBottom: r2(sd(dy)), bottomOver5pxAbove: dy.filter((d) => d < -5).length };
}

// the same frame marked twice: how far apart the two marks are; one mark's own noise is that spread / sqrt 2
const again = M.frames.filter((x) => x.repeatOf).flatMap((x) => (["A", "B"] as const).flatMap((p) => {
  const a = L[x.repeatOf!]?.[p], b = L[x.id]?.[p];
  if (!Array.isArray(a) || !Array.isArray(b)) return [];
  const ca = applyHomography(sys.toCourt, a), cb = applyHomography(sys.toCourt, b);
  return [{ side: sideOf(ca), px: Math.hypot(a[0] - b[0], a[1] - b[1]), m: Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) }];
}));
const repeat = Object.fromEntries(["near", "far"].map((side) => {
  const r = again.filter((x) => x.side === side);
  return [side, r.length ? { n: r.length, rmsPx: r2(rms(r.map((x) => x.px))), rmsM: r2(rms(r.map((x) => x.m))), markNoiseM: r2(rms(r.map((x) => x.m)) / Math.SQRT2) } : null];
}));

const sides: Record<string, { meters: Record<string, ReturnType<typeof meters>>; pixels: ReturnType<typeof pixels>; players: Record<string, number>; withoutMarkNoise: Record<string, number | null> }> = {};
for (const side of ["near", "far"]) {
  const rs = rows.filter((r) => r.side === side);
  if (!rs.length) continue;
  const m = { boxBottom: meters(rs, (r) => r.s.bottom), metricsInput: meters(rs, (r) => r.s.fixed), smoothed: meters(rs, (r) => r.s.smoothed) };
  const noise = repeat[side]?.markNoiseM;
  // the error left once the hand marks' own noise is taken out (rough: few repeats)
  const clean = (x: ReturnType<typeof meters>) => (x && noise !== undefined ? r2(Math.sqrt(Math.max(0, x.rmse.v ** 2 - noise ** 2))) : null);
  sides[side] = {
    meters: m,
    pixels: pixels(rs),
    players: { A: rs.filter((r) => r.player === "A").length, B: rs.filter((r) => r.player === "B").length },
    withoutMarkNoise: { metricsInput: clean(m.metricsInput), smoothed: clean(m.smoothed) },
  };
  console.log(`\n${side} side, ${rs.length} positions (Player A ${sides[side].players.A}, Player B ${sides[side].players.B})${rs.length < MIN_SIDE ? ": TOO FEW TO READ" : ""}`);
  console.log("system minus hand mark, meters; value [95% interval]:");
  console.table(Object.fromEntries(Object.entries(m).filter(([, v]) => v).map(([k, v]) => [k, {
    n: v!.n, "bias lateral": show(v!.biasLateral), "bias depth": show(v!.biasDepth), "RMSE lateral": show(v!.rmseLateral), "RMSE depth": show(v!.rmseDepth), RMSE: show(v!.rmse),
  }])));
  console.log("SAM box bottom-center minus hand mark, pixels:");
  console.table({ pixels: pixels(rs) });
}

console.log("\nthe same frame marked twice (hand-mark noise; few repeats, read as rough):");
console.table(repeat);
for (const [side, v] of Object.entries(sides)) {
  if (v.withoutMarkNoise.smoothed !== null) console.log(`${side}: RMSE with the hand marks' own noise taken out, smoothed ${v.withoutMarkNoise.smoothed} m, metrics input ${v.withoutMarkNoise.metricsInput} m (rough)`);
}

if (SELF) {
  for (const v of Object.values(sides)) assert.equal(v.meters.boxBottom!.rmse.v, 0);
  for (const v of Object.values(repeat)) assert.equal(v?.rmsPx, 1.41);
  console.log("self-check passed");
  process.exit(0);
}

// before/after: the frozen baseline against this run
if (fs.existsSync(BASE) && !process.argv.includes("--save")) {
  const base = JSON.parse(fs.readFileSync(BASE, "utf8")) as { version: { commit: string }; sides: typeof sides };
  console.log(`\nchange from the baseline (app ${base.version.commit}), RMSE and depth bias in meters:`);
  console.table(Object.fromEntries(Object.entries(sides).flatMap(([side, v]) => (["metricsInput", "smoothed"] as const).map((k) => {
    const b = base.sides[side]?.meters[k], n = v.meters[k];
    return [`${side} ${k}`, { "RMSE before": b?.rmse.v, "RMSE now": n?.rmse.v, "depth bias before": b?.biasDepth.v, "depth bias now": n?.biasDepth.v }];
  }))));
}

console.log(`
What these numbers do not show:
- The hand marks are a reference, not ground truth: they have their own noise (table above), and a frame shown twice
  may be remembered, so the repeats can understate it.
- The marks and the app use the same court calibration, so calibration error cancels out. These are foot-position
  errors only, not the absolute accuracy on the court.
- One session, one camera, ${originals.length} frames. The intervals resample frames as if independent; frames from the same
  part of the session share conditions, so the real uncertainty can be wider.
- Per-frame position error is not distance or speed error: those depend on how the error changes from frame to frame,
  which frames this far apart cannot show.
- Only frames where SAM tracked both players were picked, so tracking dropouts are not measured here.
- The hand mark (midway between the feet) and the app's point (bottom-center of the SAM box) are defined differently;
  part of a constant offset can be that definition rather than a tracking error.`);

const result = { job: JOB, version, marked: rows.length, hidden, sides, repeat };
const out = process.argv.includes("--save") ? BASE : `data/validation/annotation-compare-${JOB}.json`;
fs.writeFileSync(out, JSON.stringify(result, null, 1) + "\n");
console.log(`\nsaved ${out}${out === BASE ? " (the baseline for later before/after runs)" : " (git-ignored)"}`);
