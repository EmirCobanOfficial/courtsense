import { isJobId, readJob, readTracks, writeJob } from "@/lib/jobs.ts";
import { analyze } from "@/lib/metrics.ts";
import type { Pt } from "@/lib/court.ts";

// Body: { points: [[x, y] x 4] } in clip pixels, in CALIBRATION_POINTS order.
export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/calibration">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const { points } = await req.json().catch(() => ({}));
  const valid =
    Array.isArray(points) &&
    points.length === 4 &&
    points.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v) && v >= 0 && v <= 10000));
  if (!valid) return Response.json({ error: "points must be 4 [x, y] pairs" }, { status: 400 });

  const tracks = readTracks(job);
  let metrics = null;
  try {
    metrics = tracks ? analyze(tracks, points as Pt[]) : null;
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "bad calibration" }, { status: 400 });
  }
  writeJob({ ...job, calibration: points });
  return Response.json({ job: readJob(id), metrics });
}
