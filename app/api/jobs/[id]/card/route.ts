import { isJobId, readJob, readTracks } from "@/lib/jobs.ts";
import { analyze } from "@/lib/metrics.ts";
import { cardPrompt, drawCard } from "@/lib/card.ts";

// Draw a practice card with Muse Image ($0.01). Body: { player: "A" | "B", goal: string }.
export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/card">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const tracks = readTracks(job);
  if (!tracks || !job.calibration) return Response.json({ error: "Process and calibrate the video first." }, { status: 409 });
  const body = await req.json().catch(() => ({}));
  const goal = String(body.goal ?? "").trim().slice(0, 200);
  if (!goal) return Response.json({ error: "Write the goal first." }, { status: 400 });
  try {
    const m = analyze(tracks, job.calibration)[body.player === "B" ? 1 : 0];
    return Response.json({ image: await drawCard(cardPrompt(m, goal)) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
