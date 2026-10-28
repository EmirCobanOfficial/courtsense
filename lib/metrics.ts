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

export type PlayerMetrics = {
  player: "A" | "B";
  objectFrames: Record<string, [number, number]>; // SAM object id -> first and last frame it was this player; SAM reuses ids for other people
  seconds: number; // time the player was tracked
  coverage: number; // share of clip frames the player was tracked
  distanceM: number;
  avgSpeed: number; // m/s over tracked time
  peakSpeed: number; // m/s, 95th percentile of 0.5 s windows
  zones: { behindBaseline: number; baseline: number; midCourt: number; net: number }; // shares of tracked time
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
};

export function analyze(tracks: Tracks, imagePts: Pt[]): PlayerMetrics[] {
  return playerPositions(tracks, imagePts).map((p, i) => playerMetrics(i === 0 ? "A" : "B", p, tracks));
}

// Both players' court positions per frame, [A, B]. Player A starts on the near side.
export function playerPositions(tracks: Tracks, imagePts: Pt[]): PlayerPositions[] {
  const H = solveHomography(imagePts, CALIBRATION_POINTS.map((p) => p.world));
  const half = Math.round(tracks.fps / 2);
  const byFrame = new Map<number, Det[]>();
  for (const [id, boxes] of Object.entries(tracks.objects)) {
    for (let i = 0; i < boxes.length; i++) {
      const [f, l, , r, b, c] = boxes[i];
      // cut off by a frame edge: the feet (bottom) or the body's center (sides) is not where the box says
      if (b >= tracks.height - 2 || l <= 1 || r >= tracks.width - 2) continue;
      let [x, y] = applyHomography(H, [(l + r) / 2, b]);
      if (y > COURT.net) {
        // Far side: the net hides the feet now and then, which only ever cuts the box short from below,
        // so the lowest box bottom within +-0.5 s is the real foot row. Cuts depth noise ~4x on real footage.
        let low = b;
        for (let j = i - 1; j >= 0 && f - boxes[j][0] <= half; j--) low = Math.max(low, boxes[j][4]);
        for (let j = i + 1; j < boxes.length && boxes[j][0] - f <= half; j++) low = Math.max(low, boxes[j][4]);
        [x, y] = applyHomography(H, [(l + r) / 2, low]);
      }
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
    return { objectFrames: Object.fromEntries([...spans].filter(([id]) => idToPlayer.get(id) === i)), raw, smoothed: smooth(raw, Math.max(1, half)) };
  });
}

function playerMetrics(player: "A" | "B", { objectFrames, raw: rawSegments, smoothed: segments }: PlayerPositions, { fps, frames }: Tracks): PlayerMetrics {
  const half = Math.max(1, Math.round(fps / 2));
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
    for (let i = 0; i + half < seg.length; i++) {
      const v = dist(seg[i], seg[i + half]) / ((seg[i + half].f - seg[i].f) / fps);
      if (v <= MAX_SPEED) speeds.push(v);
    }
  }

  const all = segments.flat();
  const zones = { behindBaseline: 0, baseline: 0, midCourt: 0, net: 0 };
  const lateral = { left: 0, center: 0, right: 0 };
  const counts = new Array(HEAT.cols * HEAT.rows).fill(0);
  const sideChangesAt: number[] = [];
  let side = null as "near" | "far" | null;
  for (const s of all) {
    // hysteresis around the net so jitter does not count as a side change
    const now: typeof side = s.y < COURT.net - 2 ? "near" : s.y > COURT.net + 2 ? "far" : side;
    if (side && now !== side) sideChangesAt.push(+(s.f / fps).toFixed(1));
    side = now;
    const d = side === "far" ? COURT.length - s.y : s.y; // distance in front of own baseline
    if (d < 0) zones.behindBaseline++;
    else if (d < 2) zones.baseline++;
    else if (d < COURT.serviceFromBaseline) zones.midCourt++;
    else zones.net++;
    const lx = side === "far" ? -s.x : s.x; // the far player faces the camera, so their left is camera right
    if (lx < -COURT.singlesHalf / 3) lateral.left++;
    else if (lx > COURT.singlesHalf / 3) lateral.right++;
    else lateral.center++;
    const cx = Math.floor(s.x - HEAT.x0);
    const cy = Math.floor(s.y - HEAT.y0);
    if (cx >= 0 && cx < HEAT.cols && cy >= 0 && cy < HEAT.rows) counts[cy * HEAT.cols + cx]++;
  }
  const n = all.length || 1;
  for (const k of Object.keys(zones) as (keyof typeof zones)[]) zones[k] = round(zones[k] / n, 3);
  for (const k of Object.keys(lateral) as (keyof typeof lateral)[]) lateral[k] = round(lateral[k] / n, 3);
  const seconds = all.length / fps;
  speeds.sort((a, b) => a - b);

  // Depth jitter = raw minus smoothed, interior samples only (edge windows are shrunk). Real footwork adds a
  // little too, but on real footage the near player sits at ~0.1 m and a net-occluded far player at ~0.5 m.
  let sq = 0;
  let cnt = 0;
  rawSegments.forEach((seg, si) => {
    for (let i = half; i < seg.length - half; i++) {
      sq += (seg[i].y - segments[si][i].y) ** 2;
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
    lateral,
    // full minutes only: a short last minute would read as a sudden drop
    perMinuteM: Array.from({ length: Math.floor(frames / fps / 60) }, (_, i) => round(perMinuteM[i] ?? 0, 1)),
    sideChangesAt,
    depthNoiseM: round(depthNoiseM, 2),
    reliable: cnt > 0 && depthNoiseM <= RELIABLE_NOISE,
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

// Centered ~1 s moving average. Box bottoms jitter a few pixels per frame, and on the far side one pixel
// is ~0.3 m, so shorter windows double the far player's distance. The window shrinks symmetrically at
// segment edges so steady motion keeps its full length.
function smooth(segs: Sample[][], half: number): Sample[][] {
  return segs.map((seg) =>
    seg.map((p, i) => {
      const k = Math.min(half, i, seg.length - 1 - i);
      const w = seg.slice(i - k, i + k + 1);
      return { f: p.f, x: w.reduce((a, q) => a + q.x, 0) / w.length, y: w.reduce((a, q) => a + q.y, 0) / w.length };
    }),
  );
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const round = (v: number, d: number) => +v.toFixed(d);
