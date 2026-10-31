// Shared by the Step 3 tools: the coach's session, where its frames and hand marks live (data/, git-ignored, this
// machine only), and what the app computed for one player in one frame.
import { applyHomography, CALIBRATION_POINTS, solveHomography, type Pt } from "../../lib/court.ts";
import { jobFile, readJob, readTracks } from "../../lib/jobs.ts";
import { playerPositions, V2, type Box, type Method, type Sample } from "../../lib/metrics.ts";

export const JOB = "d8650763e4d0";
// --set <name>: a separate set of frames and marks, e.g. "test" for frames kept out of Step 2's design
const setArg = process.argv.indexOf("--set");
export const SET = setArg > 0 ? process.argv[setArg + 1] : "";
if (SET && !/^[a-z0-9-]{1,20}$/.test(SET)) throw new Error("--set must be 1-20 lowercase letters, digits or dashes");
export const DESIGN_DIR = `data/validation/annotate/${JOB}`;
export const DIR = SET ? `${DESIGN_DIR}-${SET}` : DESIGN_DIR;
export const LABELS = `data/validation/annotations-${JOB}${SET ? `-${SET}` : ""}.json`;
export type Mark = Pt | "hidden";
export type Labels = Record<string, Partial<Record<"A" | "B", Mark>>>;
export type Manifest = {
  job: string; width: number; height: number; fps: number;
  frames: { id: string; f: number; file: string; sourceTime: string; repeatOf?: string; players: Partial<Record<"A" | "B", { tag: Pt; view: [number, number, number] }>> }[];
};

export function loadSystem(method: Method = V2) {
  const job = readJob(JOB);
  const tracks = job && readTracks(job);
  if (!job?.calibration || !tracks) throw new Error(`job ${JOB} has no calibration or tracks on this machine`);
  const world = CALIBRATION_POINTS.map((p) => p.world);
  const byFrame = (segs: Sample[][]) => new Map(segs.flat().map((s) => [s.f, s]));
  return {
    job, tracks, clip: jobFile(JOB, "clip.mp4"),
    toCourt: solveHomography(job.calibration, world),
    toImage: solveHomography(world, job.calibration),
    boxes: new Map(Object.entries(tracks.objects).map(([id, boxes]) => [id, new Map(boxes.map((b) => [b[0], b]))])),
    players: playerPositions(tracks, job.calibration, method).map((p) => ({ objectFrames: p.objectFrames, raw: byFrame(p.raw), smoothed: byFrame(p.smoothed) })),
  };
}
export type System = ReturnType<typeof loadSystem>;

// What the app computed for player p (0 = A, 1 = B) in clip frame f: the SAM box it used, that box's bottom-center
// (before the far-side fix), the court point the metrics start from (after the fix), and the smoothed point.
export function systemAt(sys: System, p: 0 | 1, f: number) {
  const raw = sys.players[p].raw.get(f);
  if (!raw) return null;
  let best: { box: Box; d: number } | null = null;
  for (const [id, [first, last]] of Object.entries(sys.players[p].objectFrames)) {
    const box = f >= first && f <= last ? sys.boxes.get(id)?.get(f) : undefined;
    if (!box) continue;
    const [x, y] = applyHomography(sys.toCourt, [(box[1] + box[3]) / 2, box[4]]);
    const d = Math.hypot(x - raw.x, y - raw.y); // the far-side fix moves only the foot row, so the used box is the nearest
    if (!best || d < best.d) best = { box, d };
  }
  if (!best) return null;
  const [, l, t, r, b] = best.box;
  const bottomPx: Pt = [(l + r) / 2, b];
  const sm = sys.players[p].smoothed.get(f);
  return {
    box: [l, t, r, b],
    bottomPx,
    bottom: applyHomography(sys.toCourt, bottomPx),
    fixedPx: applyHomography(sys.toImage, [raw.x, raw.y]),
    fixed: [raw.x, raw.y] as Pt,
    smoothed: sm ? ([sm.x, sm.y] as Pt) : null,
  };
}
