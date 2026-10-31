import { isJobId, jobFile, readJob, readTracks } from "@/lib/jobs.ts";
import { ask, loadSession, type CoachEvent } from "@/lib/coach.ts";
import { modelClient, type ModelClient } from "@/lib/model.ts";

// Body: { question, history?: [{ question, answer }] (max 3), lang?: "en" | "tr" }. Streams one CoachEvent JSON per line.
export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/ask">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const tracks = job.status === "ready" && job.calibration ? readTracks(job) : null;
  if (!tracks) return Response.json({ error: "Process and calibrate the video first." }, { status: 409 });
  let client: ModelClient;
  try {
    client = modelClient();
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  const { question, history = [], lang } = await req.json().catch(() => ({}));
  const validHistory =
    Array.isArray(history) &&
    history.length <= 3 &&
    history.every((h) => typeof h?.question === "string" && typeof h?.answer === "string" && h.question.length <= 500 && h.answer.length <= 2000);
  if (typeof question !== "string" || !question.trim() || question.length > 500 || !validHistory) {
    return Response.json({ error: "question must be 1-500 characters; history at most 3 short items" }, { status: 400 });
  }

  const session = loadSession(job, tracks, jobFile(id, "clip.mp4"));
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: CoachEvent) => {
        if (!req.signal.aborted) controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      };
      try {
        await ask(session, question.trim(), history, emit, client, req.signal, lang === "tr" ? "tr" : "en");
      } catch (e) {
        if (!req.signal.aborted) emit({ type: "error", message: `Assistant failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
