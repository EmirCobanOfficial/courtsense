// Step 3: compare the hand marks with what the app computed for the same frames, once enough frames are marked.
// Per side of the court, in court meters (lateral = across the court, depth = along it, + = farther from the camera):
// the error of the SAM box's bottom-center, of the far-side-fixed point the metrics start from, and of the smoothed
// point they are measured on. In pixels: how far the box bottom sits from the marked feet (what sim.ts's noise model
// should match). Frames shown twice measure how repeatable the marks themselves are.
// usage (from the repo root): node validate/annotate/compare.ts [--self-check]
//   --self-check: marks placed on the box bottoms (the repeats 1 px off) must give zero box error and a 1.41 px repeat
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyHomography, COURT, type Pt } from "../../lib/court.ts";
import { DIR, JOB, LABELS, loadSystem, systemAt, type Labels, type Manifest } from "./system.ts";

const MIN_MARKS = 10;
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

type Row = { side: string; mark: Pt; markCourt: Pt; s: NonNullable<ReturnType<typeof systemAt>> };
const rows: Row[] = [];
let hidden = 0;
for (const fr of M.frames.filter((x) => !x.repeatOf)) {
  (["A", "B"] as const).forEach((p, i) => {
    const m = L[fr.id]?.[p];
    if (m === "hidden") hidden++;
    const s = Array.isArray(m) ? systemAt(sys, i as 0 | 1, fr.f) : null;
    if (!s || !Array.isArray(m)) return;
    const markCourt = applyHomography(sys.toCourt, m);
    rows.push({ side: sideOf(markCourt), mark: m, markCourt, s });
  });
}
console.log(`${rows.length} marked positions, ${hidden} marked not visible, in ${M.frames.filter((x) => !x.repeatOf).length} frames`);
if (rows.length < MIN_MARKS) {
  console.log(`Mark at least ${MIN_MARKS} positions (ideally every frame) first: no accuracy numbers yet.`);
  process.exit(0);
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const rms = (v: number[]) => Math.sqrt(mean(v.map((x) => x * x)));
const sd = (v: number[]) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
const r2 = (x: number) => +x.toFixed(2);

// system minus mark, in court meters
function meters(rs: Row[], pick: (r: Row) => Pt | null) {
  const e = rs.flatMap((r) => {
    const p = pick(r);
    return p ? [[p[0] - r.markCourt[0], p[1] - r.markCourt[1]]] : [];
  });
  if (!e.length) return null;
  const dx = e.map((d) => d[0]), dy = e.map((d) => d[1]);
  return { n: e.length, biasLateral: r2(mean(dx)), biasDepth: r2(mean(dy)), rmseLateral: r2(rms(dx)), rmseDepth: r2(rms(dy)), rmse: r2(rms(e.map(([x, y]) => Math.hypot(x, y)))) };
}
// box bottom-center minus mark, in image pixels (+y = lower in the image); a box cut short by the net ends above the feet
function pixels(rs: Row[]) {
  const dx = rs.map((r) => r.s.bottomPx[0] - r.mark[0]), dy = rs.map((r) => r.s.bottomPx[1] - r.mark[1]);
  return { n: rs.length, biasX: r2(mean(dx)), sdX: r2(sd(dx)), biasBottom: r2(mean(dy)), sdBottom: r2(sd(dy)), bottomOver5pxAbove: dy.filter((d) => d < -5).length };
}

const sides: Record<string, unknown> = {};
for (const side of ["near", "far"]) {
  const rs = rows.filter((r) => r.side === side);
  if (!rs.length) continue;
  const m = { boxBottom: meters(rs, (r) => r.s.bottom), metricsInput: meters(rs, (r) => r.s.fixed), smoothed: meters(rs, (r) => r.s.smoothed) };
  sides[side] = { meters: m, pixels: pixels(rs) };
  console.log(`\n${side} side: system minus hand mark`);
  console.table(m);
  console.table({ pixels: pixels(rs) });
}

// the same frame marked twice: how far apart the two marks are
const again = M.frames.filter((x) => x.repeatOf).flatMap((x) => (["A", "B"] as const).flatMap((p) => {
  const a = L[x.repeatOf!]?.[p], b = L[x.id]?.[p];
  if (!Array.isArray(a) || !Array.isArray(b)) return [];
  const ca = applyHomography(sys.toCourt, a), cb = applyHomography(sys.toCourt, b);
  return [{ side: sideOf(ca), px: Math.hypot(a[0] - b[0], a[1] - b[1]), m: Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) }];
}));
const repeat = Object.fromEntries(["near", "far"].map((side) => {
  const r = again.filter((x) => x.side === side);
  return [side, r.length ? { n: r.length, rmsPx: r2(rms(r.map((x) => x.px))), rmsM: r2(rms(r.map((x) => x.m))) } : null];
}));
console.log("\nhand marks repeated on the same frame");
console.table(repeat);

if (SELF) {
  for (const v of Object.values(sides) as { meters: { boxBottom: { rmse: number } } }[]) assert.equal(v.meters.boxBottom.rmse, 0);
  for (const v of Object.values(repeat)) assert.equal(v?.rmsPx, 1.41);
  console.log("self-check passed");
  process.exit(0);
}
const out = `data/validation/annotation-compare-${JOB}.json`;
fs.writeFileSync(out, JSON.stringify({ job: JOB, marked: rows.length, hidden, sides, repeat }, null, 1) + "\n");
console.log(`saved ${out} (git-ignored)`);
