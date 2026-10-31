// run: node --test lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHomography, CALIBRATION_POINTS, solveHomography, type Pt } from "./court.ts";
import { analyze, playerPositions, V1, V2, type Box, type Tracks } from "./metrics.ts";

// A plausible camera: world meters -> image pixels (perspective, behind the near baseline).
const imagePts: Pt[] = [[400, 900], [1500, 900], [1250, 600], [650, 600]];
const toImage = solveHomography(CALIBRATION_POINTS.map((p) => p.world), imagePts);

test("homography maps calibration points exactly and round-trips", () => {
  const toWorld = solveHomography(imagePts, CALIBRATION_POINTS.map((p) => p.world));
  CALIBRATION_POINTS.forEach((p, i) => {
    const [x, y] = applyHomography(toWorld, imagePts[i]);
    assert.ok(Math.abs(x - p.world[0]) < 1e-6 && Math.abs(y - p.world[1]) < 1e-6);
  });
  const [u, v] = applyHomography(toImage, [2, 15]);
  const [x, y] = applyHomography(toWorld, [u, v]);
  assert.ok(Math.abs(x - 2) < 1e-6 && Math.abs(y - 15) < 1e-6);
});

test("collinear calibration points are rejected", () => {
  assert.throws(() => solveHomography([[0, 0], [1, 1], [2, 2], [5, 9]], imagePts));
});

test("analyze: distance, fragmented ids, bystanders, side change", () => {
  const fps = 10;
  const box = (f: number, w: Pt): Box => {
    const [u, v] = applyHomography(toImage, w);
    return [f, u - 20, v - 100, u + 20, v, 0.9];
  };
  const objects: Record<string, Box[]> = { a1: [], a2: [], b: [], bystander: [] };
  for (let f = 0; f < 100; f++) {
    // A runs 0.8 m/s along the baseline; SAM loses the id halfway and gives a new one
    (f < 50 ? objects.a1 : objects.a2).push(box(f, [-4 + (0.8 * f) / fps, 1]));
    // B stands on the far side, then walks to the near side at the end
    objects.b.push(box(f, f < 90 ? [0, 22] : [0, 22 - (f - 89) * 1.5]));
    // someone on the next court, far outside the run-off
    objects.bystander.push(box(f, [-14, 3]));
  }
  const tracks: Tracks = { fps, width: 1920, height: 1080, frames: 100, objects };
  const [A, B] = analyze(tracks, imagePts);

  assert.deepEqual(A.objectFrames, { a1: [0, 49], a2: [50, 99] });
  assert.deepEqual(B.objectFrames, { b: [0, 99] });
  assert.equal(A.coverage, 1);
  assert.ok(Math.abs(A.distanceM - 7.92) < 0.2, `A distance ${A.distanceM}`);
  assert.ok(Math.abs(A.avgSpeed - 0.8) < 0.05, `A speed ${A.avgSpeed}`);
  assert.equal(A.zones.baseline, 1);
  assert.deepEqual(A.lateral, { left: 0.33, center: 0.35, right: 0.32 });
  assert.equal(B.lateral.center, 1);
  assert.equal(B.coverage, 1);
  assert.equal(B.sideChangesAt.length, 1);
  assert.equal(A.heatmap.counts.reduce((a, b) => a + b, 0), 100);
  assert.equal(A.reliable, true);
});

test("analyze: far player whose feet the net hides every other frame stays put", () => {
  const fps = 10;
  const [u, v] = applyHomography(toImage, [1.5, 23.5]); // mid-cell, so float error cannot flip the heatmap cell
  const boxes: Box[] = [];
  for (let f = 0; f < 60; f++) boxes.push([f, u - 5, v - 40, u + 5, f % 2 ? v - 15 : v, 0.9]); // odd frames: bottom cut by the net
  const [A, B] = analyze({ fps, width: 1920, height: 1080, frames: 60, objects: { far: boxes } }, imagePts);
  assert.equal(A.coverage, 0);
  assert.equal(B.coverage, 1);
  assert.ok(B.distanceM < 0.01, `B distance ${B.distanceM}`);
  assert.equal(B.depthNoiseM, 0);
  assert.equal(B.reliable, true);
  assert.equal(B.heatmap.counts[Math.floor(23.5 - B.heatmap.y0) * B.heatmap.cols + Math.floor(1.5 - B.heatmap.x0)], 60);
});

test("analyze: heavy depth jitter marks the player unreliable", () => {
  const fps = 10;
  const [u, v] = applyHomography(toImage, [0, 2]);
  const boxes: Box[] = [];
  for (let f = 0; f < 100; f++) boxes.push([f, u - 20, v - 100, u + 20, v + (f % 2 ? 30 : -30), 0.9]);
  const [A] = analyze({ fps, width: 1920, height: 1080, frames: 100, objects: { near: boxes } }, imagePts);
  assert.ok(A.depthNoiseM > 0.3, `noise ${A.depthNoiseM}`);
  assert.equal(A.reliable, false);
});

test("analyze: only one player visible, id switch stays with that player", () => {
  const fps = 10;
  const objects: Record<string, Box[]> = { a1: [], a2: [] };
  for (let f = 0; f < 100; f++) {
    const [u, v] = applyHomography(toImage, [-4 + (0.8 * f) / fps, 1]);
    (f < 50 ? objects.a1 : objects.a2).push([f, u - 20, v - 100, u + 20, v, 0.9]);
  }
  const [A, B] = analyze({ fps, width: 1920, height: 1080, frames: 100, objects }, imagePts);
  assert.equal(A.coverage, 1);
  assert.equal(B.coverage, 0);
});

test("analyze: an id SAM later gives to someone on the next court keeps only its player frames", () => {
  const fps = 10;
  const boxes: Box[] = [];
  for (let f = 0; f < 100; f++) {
    const [u, v] = applyHomography(toImage, f < 40 ? [0, 1] : [-14, 3]);
    boxes.push([f, u - 20, v - 100, u + 20, v, 0.9]);
  }
  const [A] = analyze({ fps, width: 1920, height: 1080, frames: 100, objects: { a: boxes } }, imagePts);
  assert.deepEqual(A.objectFrames, { a: [0, 39] });
});

test("playerPositions: the smoothed positions the metrics measure, split where tracking pauses", () => {
  const fps = 10;
  const box = (f: number, w: Pt): Box => {
    const [u, v] = applyHomography(toImage, w);
    return [f, u - 20, v - 100, u + 20, v, 0.9];
  };
  const ax = (f: number) => -2 + (0.5 * f) / fps; // A walks 0.5 m/s along the baseline
  const objects: Record<string, Box[]> = { a: [], b: [] };
  for (let f = 0; f < 60; f++) {
    if (f < 20 || f >= 30) objects.a.push(box(f, [ax(f), 1])); // SAM loses A for 1 s
    objects.b.push(box(f, [1, 22]));
  }
  const tracks: Tracks = { fps, width: 1920, height: 1080, frames: 60, objects };
  const [A, B] = playerPositions(tracks, imagePts);

  assert.deepEqual(A.objectFrames, { a: [0, 59] });
  assert.deepEqual(A.smoothed.map((s) => [s[0].f, s.at(-1)!.f, s.length]), [[0, 19, 20], [30, 59, 30]]);
  // a centered average leaves steady motion in place, segment edges included
  for (const p of A.smoothed.flat()) assert.ok(Math.abs(p.x - ax(p.f)) < 1e-6 && Math.abs(p.y - 1) < 1e-6, `A at frame ${p.f}`);
  assert.equal(B.smoothed.flat().length, 60);
  const steps = A.smoothed.reduce((d, s) => d + s.slice(1).reduce((e, p, i) => e + Math.hypot(p.x - s[i].x, p.y - s[i].y), 0), 0);
  assert.equal(analyze(tracks, imagePts)[0].distanceM, +steps.toFixed(1));
});

// --- Step 2: the far-side foot row and the zone ranges ---
// A stands on the near baseline; B walks away from the net on the far side at 1 m/s, with clean boxes
const farBox = (f: number, w: Pt, cutPx = 0): Box => {
  const [u, v] = applyHomography(toImage, w);
  return [f, u - 10, v - 60, u + 10, v - cutPx, 0.9];
};
const fps15 = 15;
// A stands on the near baseline; B walks away from the net on the far side at 1 m/s, with clean boxes
const farY = (f: number) => 18 + f / fps15;
const walkingAway = (cut: (f: number) => number = () => 0): Tracks => {
  const objects: Record<string, Box[]> = { a: [], b: [] };
  for (let f = 0; f < 60; f++) {
    objects.a.push(farBox(f, [0, 1]));
    objects.b.push(farBox(f, [0, farY(f)], cut(f)));
  }
  return { fps: fps15, width: 1920, height: 1080, frames: 60, objects };
};

test("far-side foot row: V2 follows a moving player, V1's lowest-bottom rule pulls it toward the camera", () => {
  const err = (m: typeof V1) => playerPositions(walkingAway(), imagePts, m)[1].raw.flat().filter((s) => s.f >= 10 && s.f < 50).map((s) => s.y - farY(s.f));
  assert.ok(Math.max(...err(V2).map(Math.abs)) < 0.05, `V2 ${Math.max(...err(V2).map(Math.abs))}`);
  assert.ok(err(V1).every((e) => e < -0.3), `V1 ${err(V1)[0]}`);
});

test("far-side foot row: a box the net cuts short is put back on the trend", () => {
  const cutAt = 30;
  const raw = playerPositions(walkingAway((f) => (f === cutAt ? 8 : 0)), imagePts, V2)[1].raw.flat();
  const at = raw.find((s) => s.f === cutAt)!;
  assert.ok(Math.abs(at.y - farY(cutAt)) < 0.3, `cut frame off by ${at.y - farY(cutAt)} m`);
});

test("near player is the same under V1 and V2; zone ranges hold the zone shares", () => {
  const [a1, b1] = analyze(walkingAway(), imagePts, V1), [a2, b2] = analyze(walkingAway(), imagePts, V2);
  assert.deepEqual([a2.distanceM, a2.zones, a2.peakSpeed], [a1.distanceM, a1.zones, a1.peakSpeed]);
  for (const m of [a2, b2, b1]) {
    for (const [k, [lo, hi]] of Object.entries(m.zoneRanges)) assert.ok(lo <= m.zones[k as keyof typeof m.zones] && m.zones[k as keyof typeof m.zones] <= hi, `${m.player} ${k}`);
    const sum = (i: 0 | 1) => Object.values(m.zoneRanges).reduce((s, r) => s + r[i], 0);
    assert.ok(sum(0) <= 1 + 1e-9 && sum(1) >= 1 - 1e-9);
  }
});
