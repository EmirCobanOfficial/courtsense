import { applyHomography, CALIBRATION_POINTS, COURT, solveHomography, type Pt } from "./court.ts";

// One SAM box: [frame, left, top, right, bottom, confidence]
export type Box = [number, number, number, number, number, number | null];
export type Tracks = { fps: number; width: number; height: number; frames: number; objects: Record<string, Box[]> };

export type Sample = { f: number; x: number; y: number }; // court meters at clip frame f
type Det = Sample & { id: string; conf: number };

const MAX_SPEED = 8; // m/s; faster steps are tracking jumps, not running
const MAX_GAP = 3; // frames; longer gaps split a track into segments
const RELIABLE_NOISE = 0.3; // m; above this frame-to-frame depth noise, distance/speed/zones are rough
const HEAT = { x0: -9, y0: -8, cols: 18, rows: 40 }; // 1 m cells covering the court plus run-off
// Position error in image pixels, measured against hand-marked feet on the coach's session (validate/annotate, 40
// frames): it turns into meters through the camera, so it grows with distance. Zone shares get a range from it.
const SIGMA_PX = { near: 24, far: 2.5 }; // near: mostly a constant offset (the box ends at the front foot); far: SAM's box-bottom wander

// How positions are computed. V1 is the hackathon version, kept to measure against; V2 follows the hand-marked frames.
// reliableSigmaM: also call distance, speeds and zones rough when the median expected depth error is above this; jitter
// alone can look low once the far track is smoothed, while the hand marks show ~1 m of depth error on the far side
export type Method = { farFix: "max" | "envelope"; quantile: number; farDepthSeconds: number; reliableSigmaM?: number };
export const V1: Method = { farFix: "max", quantile: 1, farDepthSeconds: 1 };
export const V2: Method = { farFix: "envelope", quantile: 0.9, farDepthSeconds: 2, reliableSigmaM: 0.6 };

export type PlayerMetrics = {
  player: "A" | "B";
  objectFrames: Record<string, [number, number]>; // SAM object id -> first and last frame it was this player; SAM reuses ids for other people
  seconds: number; // time the player was tracked
  coverage: number; // share of clip frames the player was tracked
  distanceM: number;
  avgSpeed: number; // m/s over tracked time
  peakSpeed: number; // m/s, 95th percentile of 0.5 s windows
  zones: { behindBaseline: number; baseline: number; midCourt: number; net: number }; // shares of tracked time
  zoneRanges: Record<keyof PlayerMetrics["zones"], [number, number]>; // clearly in the zone .. possibly in it, given the position error
  lateral: { left: number; center: number; right: number }; // thirds of the singles width, from the player's own view
  perMinuteM: number[];
  sideChangesAt: number[]; // seconds into the clip
  depthNoiseM: number; // frame-to-frame depth jitter left after the far-side fix
  reliable: boolean; // false: distance, speeds and zones are rough; lateral is still fine
  heatmap: typeof HEAT & { counts: number[] };
};

// One player's tracked frames, split into segments at gaps longer than MAX_GAP frames.
export type PlayerPositions = {
  objectFrames: PlayerMetrics["objectFrames"];
  raw: Sample[][];
  smoothed: Sample[][]; // the positions every metric is measured on
  depthSigma: number[][]; // m, expected depth error of each smoothed position
};

export function analyze(tracks: Tracks, imagePts: Pt[], method = V2): PlayerMetrics[] {
  return playerPositions(tracks, imagePts, method).map((p, i) => playerMetrics(i === 0 ? "A" : "B", p, tracks, method));
}

// Both players' court positions per frame, [A, B]. Player A starts on the near side.
export function playerPositions(tracks: Tracks, imagePts: Pt[], method = V2): PlayerPositions[] {
  const H = solveHomography(imagePts, CALIBRATION_POINTS.map((p) => p.world));
  const toImage = solveHomography(CALIBRATION_POINTS.map((p) => p.world), imagePts);
  const half = Math.round(tracks.fps / 2);
  const byFrame = new Map<number, Det[]>();
  for (const [id, boxes] of Object.entries(tracks.objects)) {
    for (let i = 0; i < boxes.length; i++) {
      const [f, l, , r, b, c] = boxes[i];
      // cut off by a frame edge: the feet (bottom) or the body's center (sides) is not where the box says
      if (b >= tracks.height - 2 || l <= 1 || r >= tracks.width - 2) continue;
      let [x, y] = applyHomography(H, [(l + r) / 2, b]);
      if (y > COURT.net) [x, y] = applyHomography(H, [(l + r) / 2, farBottom(boxes, i, half, method)]);
      // drop people outside the court and its run-off (e.g. on the next court)
      if (Math.abs(x) > COURT.doublesHalf + 3 || y < -8 || y > COURT.length + 8) continue;
      if (!byFrame.has(f)) byFrame.set(f, []);
      byFrame.get(f)!.push({ id, f, x, y, conf: c ?? 0 });
    }
  }

  // Assign SAM object ids to two players. Player A starts on the near side.
  const idToPlayer = new Map<string, 0 | 1>();
  const spans = new Map<string, [number, number]>();
  const last: (Sample | null)[] = [null, null];
  const series: Sample[][] = [[], []];
  const take = (p: 0 | 1, d: Det) => {
    series[p].push({ f: d.f, x: d.x, y: d.y });
    last[p] = d;
    spans.set(d.id, [spans.get(d.id)?.[0] ?? d.f, d.f]); // frames come in ascending order
  };
  for (const f of [...byFrame.keys()].sort((a, b) => a - b)) {
    const dets = byFrame.get(f)!.sort((a, b) => b.conf - a.conf);
    const used = new Set<number>();
    const unknown: Det[] = [];
    for (const d of dets) {
      const p = idToPlayer.get(d.id);
      if (p === undefined) unknown.push(d);
      else if (!used.has(p)) {
        used.add(p);
        take(p, d);
      }
    }
    for (const d of unknown) {
      const free = ([0, 1] as const).filter((p) => !used.has(p));
      if (free.length === 0) break;
      let p: 0 | 1;
      if (free.length === 1) p = free[0];
      else if (last[0] && last[1]) p = dist(last[0], d) <= dist(last[1], d) ? 0 : 1;
      else if (last[0] || last[1]) {
        // only one player seen so far: a new id close to them is the same person with a fresh id
        const k = last[0] ? 0 : 1;
        p = dist(last[k]!, d) < 4 ? k : k === 0 ? 1 : 0;
      } else p = d.y < COURT.net ? 0 : 1;
      idToPlayer.set(d.id, p);
      used.add(p);
      take(p, d);
    }
  }

  return series.map((s, i) => {
    const raw = split(s);
    const smoothed = smooth(raw, Math.max(1, half), Math.max(1, Math.round((method.farDepthSeconds * tracks.fps) / 2)));
    // a pixel of error at this spot, in meters of depth
    const perPx = (q: Sample) => {
      const [u, v] = applyHomography(toImage, [q.x, q.y]);
      return Math.abs(applyHomography(H, [u, v + 1])[1] - q.y);
    };
    const depthSigma = smoothed.map((seg) => seg.map((q) => SIGMA_PX[q.y > COURT.net ? "far" : "near"] * perPx(q)));
    return { objectFrames: Object.fromEntries([...spans].filter(([id]) => idToPlayer.get(id) === i)), raw, smoothed, depthSigma };
  });
}

function playerMetrics(player: "A" | "B", { objectFrames, raw: rawSegments, smoothed: segments, depthSigma }: PlayerPositions, { fps, frames }: Tracks, method: Method): PlayerMetrics {
  const half = Math.max(1, Math.round(fps / 2));
  // speeds over 0.5 s come from the ~1 s average: the longer far-side depth window would flatten real bursts
  const second = smooth(rawSegments, half, half);
  let distanceM = 0;
  const perMinuteM: number[] = [];
  const speeds: number[] = [];
  for (const seg of segments) {
    for (let i = 1; i < seg.length; i++) {
      const step = dist(seg[i - 1], seg[i]);
      if (step / ((seg[i].f - seg[i - 1].f) / fps) > MAX_SPEED) continue;
      distanceM += step;
      const m = Math.floor(seg[i].f / fps / 60);
      perMinuteM[m] = (perMinuteM[m] ?? 0) + step;
    }
  }
  for (const seg of second) {
    for (let i = 0; i + half < seg.length; i++) {
      const v = dist(seg[i], seg[i + half]) / ((seg[i + half].f - seg[i].f) / fps);
      if (v <= MAX_SPEED) speeds.push(v);
    }
  }

  const all = segments.flat();
  const sigmas = depthSigma.flat();
  const zones = { behindBaseline: 0, baseline: 0, midCourt: 0, net: 0 };
  // a zone's range: the time the whole +-sigma depth interval lay inside it .. the time the interval touched it
  const bounds = { behindBaseline: [-Infinity, 0], baseline: [0, 2], midCourt: [2, COURT.serviceFromBaseline], net: [COURT.serviceFromBaseline, Infinity] };
  const clearly = { behindBaseline: 0, baseline: 0, midCourt: 0, net: 0 };
  const possibly = { behindBaseline: 0, baseline: 0, midCourt: 0, net: 0 };
  const lateral = { left: 0, center: 0, right: 0 };
  const counts = new Array(HEAT.cols * HEAT.rows).fill(0);
  const sideChangesAt: number[] = [];
  let side = null as "near" | "far" | null;
  all.forEach((s, si) => {
    // hysteresis around the net so jitter does not count as a side change
    const now: typeof side = s.y < COURT.net - 2 ? "near" : s.y > COURT.net + 2 ? "far" : side;
    if (side && now !== side) sideChangesAt.push(+(s.f / fps).toFixed(1));
    side = now;
    const p = place(s, side);
    zones[p.zone]++;
    lateral[p.lateral]++;
    const d = side === "far" ? COURT.length - s.y : s.y, e = sigmas[si];
    for (const [k, [lo, hi]] of Object.entries(bounds) as [keyof typeof zones, number[]][]) {
      if (d - e >= lo && d + e < hi) clearly[k]++;
      if (d + e >= lo && d - e < hi) possibly[k]++;
    }
    const cx = Math.floor(s.x - HEAT.x0);
    const cy = Math.floor(s.y - HEAT.y0);
    if (cx >= 0 && cx < HEAT.cols && cy >= 0 && cy < HEAT.rows) counts[cy * HEAT.cols + cx]++;
  });
  const n = all.length || 1;
  for (const k of Object.keys(zones) as (keyof typeof zones)[]) zones[k] = round(zones[k] / n, 3);
  for (const k of Object.keys(lateral) as (keyof typeof lateral)[]) lateral[k] = round(lateral[k] / n, 3);
  const zoneRanges = Object.fromEntries(Object.keys(zones).map((k) => [k, [round(clearly[k as keyof typeof zones] / n, 3), round(possibly[k as keyof typeof zones] / n, 3)]])) as PlayerMetrics["zoneRanges"];
  const seconds = all.length / fps;
  speeds.sort((a, b) => a - b);

  // Depth jitter = raw minus a ~1 s average, interior samples only (edge windows are shrunk). Real footwork adds a
  // little too, but on real footage the near player sits at ~0.1 m and a net-occluded far player at ~0.5 m.
  let sq = 0;
  let cnt = 0;
  rawSegments.forEach((seg, si) => {
    for (let i = half; i < seg.length - half; i++) {
      sq += (seg[i].y - second[si][i].y) ** 2;
      cnt++;
    }
  });
  const depthNoiseM = cnt ? Math.sqrt(sq / cnt) : 0;

  return {
    player,
    objectFrames,
    seconds: round(seconds, 1),
    coverage: round(all.length / Math.max(frames, 1), 3),
    distanceM: round(distanceM, 1),
    avgSpeed: round(seconds ? distanceM / seconds : 0, 2),
    peakSpeed: round(speeds[Math.floor(speeds.length * 0.95)] ?? 0, 2),
    zones,
    zoneRanges,
    lateral,
    // full minutes only: a short last minute would read as a sudden drop
    perMinuteM: Array.from({ length: Math.floor(frames / fps / 60) }, (_, i) => round(perMinuteM[i] ?? 0, 1)),
    sideChangesAt,
    depthNoiseM: round(depthNoiseM, 2),
    reliable: cnt > 0 && depthNoiseM <= RELIABLE_NOISE && !(sigmas.slice().sort((a, b) => a - b)[Math.floor(sigmas.length / 2)] > (method.reliableSigmaM ?? Infinity)),
    heatmap: { ...HEAT, counts },
  };
}

function split(s: Sample[]): Sample[][] {
  const out: Sample[][] = [];
  for (const p of s) {
    const seg = out.at(-1);
    if (seg && p.f - seg.at(-1)!.f <= MAX_GAP) seg.push(p);
    else out.push([p]);
  }
  return out;
}

// Centered moving average, ~1 s (half frames each side). Box bottoms jitter a few pixels per frame, and on the far
// side one pixel is ~0.5 m of depth, so there depth gets farHalf instead; across the court and on the near side a
// longer window only lags. The window shrinks symmetrically at segment edges so steady motion keeps its full length.
function smooth(segs: Sample[][], half: number, farHalf: number): Sample[][] {
  const avg = (seg: Sample[], i: number, h: number, k: "x" | "y") => {
    const w = Math.min(h, i, seg.length - 1 - i);
    let sum = 0;
    for (let j = i - w; j <= i + w; j++) sum += seg[j][k];
    return sum / (2 * w + 1);
  };
  return segs.map((seg) => seg.map((p, i) => ({ f: p.f, x: avg(seg, i, half, "x"), y: avg(seg, i, p.y > COURT.net ? farHalf : half, "y") })));
}

// Far side: SAM's box usually ends a little above the feet (median ~2 px on the hand-marked frames) and the net
// sometimes cuts it shorter, never lower, so the foot row is the lower envelope of the bottoms nearby (+-0.5 s).
// V1 took the lowest bottom in the window, which also pulls a player moving in depth toward the camera; V2 takes a
// line fitted to the window's bottoms (the motion) plus the given quantile of the bottoms' distance from it.
function farBottom(boxes: Box[], i: number, half: number, m: Method): number {
  const f = boxes[i][0];
  const win: [number, number][] = [];
  for (let j = i; j >= 0 && f - boxes[j][0] <= half; j--) win.push([boxes[j][0] - f, boxes[j][4]]);
  for (let j = i + 1; j < boxes.length && boxes[j][0] - f <= half; j++) win.push([boxes[j][0] - f, boxes[j][4]]);
  if (m.farFix === "max") return Math.max(...win.map((w) => w[1]));
  // as wide on both sides, so the line is read at its middle and its slope cannot tip the estimate; right at a track's
  // ends there is no such window, so there the envelope is taken flat over the one-sided window
  const k = Math.min(-Math.min(...win.map((w) => w[0])), Math.max(...win.map((w) => w[0])));
  const even = k >= 2 ? win.filter(([t]) => Math.abs(t) <= k) : win;
  const trend = k >= 2 ? fitLine(even) : fitLine(even.map(([, r]) => [0, r]));
  const res = even.map(([t, r]) => r - trend(t)).sort((a, b) => a - b);
  return trend(0) + res[Math.min(res.length - 1, Math.floor(m.quantile * res.length))];
}

function fitLine(pts: [number, number][]): (t: number) => number {
  const mt = pts.reduce((a, p) => a + p[0], 0) / pts.length, mr = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const vt = pts.reduce((a, p) => a + (p[0] - mt) ** 2, 0);
  const slope = vt ? pts.reduce((a, p) => a + (p[0] - mt) * (p[1] - mr), 0) / vt : 0;
  return (t) => mr + slope * (t - mt);
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const round = (v: number, d: number) => +v.toFixed(d);

// Where a position is from the player's own view: zone in front of their own baseline, and third of the singles width.
export function place(s: { x: number; y: number }, side: "near" | "far" | null) {
  const d = side === "far" ? COURT.length - s.y : s.y; // distance in front of own baseline
  const lx = side === "far" ? -s.x : s.x; // the far player faces the camera, so their left is camera right
  return {
    zone: d < 0 ? "behindBaseline" : d < 2 ? "baseline" : d < COURT.serviceFromBaseline ? "midCourt" : "net",
    lateral: lx < -COURT.singlesHalf / 3 ? "left" : lx > COURT.singlesHalf / 3 ? "right" : "center",
  } as const;
}
