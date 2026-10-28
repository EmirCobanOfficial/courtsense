// Synthetic sessions with a known ground truth. Players follow scripted paths on the court; a camera built from a real
// calibration turns their feet into SAM-like boxes with noise matched to real footage (box-bottom jitter, the net cutting
// the far player's box short); the app's own analyze() measures them, and evaluate() compares that with the truth.
import { applyHomography, CALIBRATION_POINTS, COURT, solveHomography, type Pt } from "../lib/court.ts";
import { analyze, playerPositions, type Box, type PlayerMetrics, type Tracks } from "../lib/metrics.ts";

export const REAL_CALIBRATION: Pt[] = [[299, 739], [1683, 750], [1331, 583], [635, 582]]; // clicked on the coach's session
export type Sample = { f: number; x: number; y: number };
// rho: frame-to-frame correlation of the jitter (AR(1)); SAM's box edges wander over several frames rather than flicker
export type Noise = { bottomPx: number; xPx: number; rho: number; occludeP: number; occludeMaxPx: number; dropP: number };
export type BoxModel = { a: number; b: number }; // box height in px = a + b * foot row
export type Leg = { to: Pt; speed: number; pause?: number };

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// Moves along the legs at up to their speeds (m/s) with at most `accel` m/s^2, braking in time to stop at each
// waypoint, pausing there, looping until `frames` samples exist. Players speed up and turn; they do not teleport.
export function walk(start: Pt, legs: Leg[], fps: number, frames: number, accel = 4): Sample[] {
  const out: Sample[] = [];
  let [x, y] = start;
  let vx = 0, vy = 0;
  let leg = 0;
  let pause = 0;
  for (let f = 0; f < frames; f++) {
    out.push({ f, x, y });
    if (pause > 0) {
      pause--;
      continue;
    }
    const L = legs[leg % legs.length];
    const dx = L.to[0] - x, dy = L.to[1] - y;
    const d = Math.hypot(dx, dy);
    if (d < 0.05) {
      pause = Math.round((L.pause ?? 0) * fps);
      leg++;
      vx = vy = 0;
      continue;
    }
    const want = Math.min(L.speed, Math.sqrt(2 * accel * d));
    const ax = (dx / d) * want - vx, ay = (dy / d) * want - vy;
    const dv = Math.hypot(ax, ay), max = accel / fps;
    if (dv > max) {
      vx += (ax / dv) * max;
      vy += (ay / dv) * max;
    } else {
      vx += ax;
      vy += ay;
    }
    x += vx / fps;
    y += vy / fps;
  }
  return out;
}

// SAM-like boxes for one player: feet projected through the camera, then jitter, dropped frames and net occlusion.
export function render(truth: Sample[], imagePts: Pt[], model: BoxModel, noise: Noise, seed: number): Box[] {
  const toImage = solveHomography(CALIBRATION_POINTS.map((p) => p.world), imagePts);
  const r = rng(seed);
  const boxes: Box[] = [];
  const keep = noise.rho, fresh = Math.sqrt(1 - noise.rho ** 2);
  let eb = 0, ex = 0, et = 0;
  for (const s of truth) {
    // AR(1) jitter with the stated standard deviation, advanced every frame (dropped frames included)
    eb = keep * eb + fresh * gauss(r) * noise.bottomPx;
    ex = keep * ex + fresh * gauss(r) * noise.xPx;
    et = keep * et + fresh * gauss(r) * noise.bottomPx;
    if (r() < noise.dropP) continue;
    const [u, v] = applyHomography(toImage, [s.x, s.y]);
    const h = model.a + model.b * v;
    let bottom = v + eb;
    if (s.y > COURT.net && r() < noise.occludeP) bottom -= r() * noise.occludeMaxPx; // the net hides the feet: the box ends higher
    const cx = u + ex;
    boxes.push([s.f, cx - 0.2 * h, v - h + et, cx + 0.2 * h, bottom, 0.9]);
  }
  return boxes;
}

// The same definitions playerMetrics uses, applied to the true positions.
export function truthMetrics(truth: Sample[], fps: number) {
  let distanceM = 0;
  for (let i = 1; i < truth.length; i++) distanceM += Math.hypot(truth[i].x - truth[i - 1].x, truth[i].y - truth[i - 1].y);
  const half = Math.max(1, Math.round(fps / 2));
  const speeds: number[] = [];
  for (let i = 0; i + half < truth.length; i++) speeds.push(Math.hypot(truth[i + half].x - truth[i].x, truth[i + half].y - truth[i].y) / (half / fps));
  speeds.sort((a, b) => a - b);
  const zones = { behindBaseline: 0, baseline: 0, midCourt: 0, net: 0 };
  const lateral = { left: 0, center: 0, right: 0 };
  let side: "near" | "far" | null = null;
  for (const s of truth) {
    side = s.y < COURT.net - 2 ? "near" : s.y > COURT.net + 2 ? "far" : side;
    const d = side === "far" ? COURT.length - s.y : s.y;
    zones[d < 0 ? "behindBaseline" : d < 2 ? "baseline" : d < COURT.serviceFromBaseline ? "midCourt" : "net"]++;
    const lx = side === "far" ? -s.x : s.x;
    lateral[lx < -COURT.singlesHalf / 3 ? "left" : lx > COURT.singlesHalf / 3 ? "right" : "center"]++;
  }
  const n = truth.length;
  const share = <T extends Record<string, number>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / n])) as T;
  return { distanceM, avgSpeed: distanceM / (n / fps), peakSpeed: speeds[Math.floor(speeds.length * 0.95)] ?? 0, zones: share(zones), lateral: share(lateral) };
}

export type Errors = {
  distancePct: number;
  avgSpeedMs: number;
  peakSpeedMs: number;
  rmseXM: number;
  rmseYM: number;
  zonesPp: Record<string, number>;
  lateralPp: Record<string, number>;
  depthNoiseM: number;
  reliable: boolean;
};

export function evaluate(truth: Sample[], m: PlayerMetrics, smoothed: Sample[][], fps: number): Errors {
  const t = truthMetrics(truth, fps);
  const at = new Map(truth.map((s) => [s.f, s]));
  let ex = 0, ey = 0, n = 0;
  for (const s of smoothed.flat()) {
    const q = at.get(s.f);
    if (!q) continue;
    ex += (s.x - q.x) ** 2;
    ey += (s.y - q.y) ** 2;
    n++;
  }
  const pp = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(b).map((k) => [k, 100 * (a[k] - b[k])]));
  return {
    distancePct: (100 * (m.distanceM - t.distanceM)) / t.distanceM,
    avgSpeedMs: m.avgSpeed - t.avgSpeed,
    peakSpeedMs: m.peakSpeed - t.peakSpeed,
    rmseXM: Math.sqrt(ex / Math.max(n, 1)),
    rmseYM: Math.sqrt(ey / Math.max(n, 1)),
    zonesPp: pp(m.zones, t.zones),
    lateralPp: pp(m.lateral, t.lateral),
    depthNoiseM: m.depthNoiseM,
    reliable: m.reliable,
  };
}

// A training-like drill: baseline rallies with lateral runs, a few sprints forward, pauses. The far player mirrors it.
const NEAR_LEGS: Leg[] = [
  { to: [-2.5, -1], speed: 2.5, pause: 0.6 },
  { to: [2.5, -0.8], speed: 3.2, pause: 0.4 },
  { to: [0, 1.5], speed: 2, pause: 1 },
  { to: [-3.5, -1.5], speed: 3.8, pause: 0.5 },
  { to: [3.5, -1], speed: 4.2, pause: 1.2 },
  { to: [0.5, 5.2], speed: 4, pause: 0.8 },
  { to: [0, -1.2], speed: 2.8, pause: 2 },
  { to: [-1, -0.5], speed: 1, pause: 0.5 },
];
const mirror = (legs: Leg[]): Leg[] => legs.map((l) => ({ ...l, to: [-l.to[0], COURT.length - l.to[1]] as Pt }));

// Mean depth shift the far-side fix applies while the player is slow (|vy| <= 1 m/s): lowest box bottom within +-0.5 s
// vs. the box's own bottom. Measured the same way on the real session, it separates how much of the far noise is
// two-sided jitter and how much is the net cutting boxes short.
export function farFixShift(tracks: Tracks, imagePts: Pt[], ids: string[]): number {
  const H = solveHomography(imagePts, CALIBRATION_POINTS.map((p) => p.world));
  const half = Math.round(tracks.fps / 2);
  const foot = (b: Box, bottom = b[4]) => applyHomography(H, [(b[1] + b[3]) / 2, bottom]);
  let sum = 0, n = 0;
  for (const id of ids) {
    const boxes = tracks.objects[id] ?? [];
    for (let i = 3; i < boxes.length - 3; i++) {
      const [f, , , , b] = boxes[i];
      const plain = foot(boxes[i]);
      if (plain[1] <= COURT.net) continue;
      const vy = (foot(boxes[i + 3])[1] - foot(boxes[i - 3])[1]) / ((boxes[i + 3][0] - boxes[i - 3][0]) / tracks.fps);
      if (Math.abs(vy) > 1) continue;
      let low = b;
      for (let j = i - 1; j >= 0 && f - boxes[j][0] <= half; j--) low = Math.max(low, boxes[j][4]);
      for (let j = i + 1; j < boxes.length && boxes[j][0] - f <= half; j++) low = Math.max(low, boxes[j][4]);
      sum += foot(boxes[i], low)[1] - plain[1];
      n++;
    }
  }
  return n ? sum / n : 0;
}

export type SimRun = { truth: [Sample[], Sample[]]; metrics: PlayerMetrics[]; errors: [Errors, Errors]; tracks: Tracks };

export function simulate(opts: { seed: number; fps?: number; seconds?: number; imagePts?: Pt[]; model: BoxModel; near: Noise; far: Noise }): SimRun {
  const fps = opts.fps ?? 15;
  const frames = Math.round((opts.seconds ?? 300) * fps);
  const imagePts = opts.imagePts ?? REAL_CALIBRATION;
  const near = walk([0, -1], NEAR_LEGS, fps, frames);
  const far = walk([0, COURT.length + 1], mirror(NEAR_LEGS), fps, frames);
  const tracks: Tracks = {
    fps, width: 1920, height: 1080, frames,
    objects: { "1": render(near, imagePts, opts.model, opts.near, opts.seed), "2": render(far, imagePts, opts.model, opts.far, opts.seed + 1000) },
  };
  const metrics = analyze(tracks, imagePts);
  const positions = playerPositions(tracks, imagePts);
  return { truth: [near, far], metrics, tracks, errors: [evaluate(near, metrics[0], positions[0].smoothed, fps), evaluate(far, metrics[1], positions[1].smoothed, fps)] };
}
