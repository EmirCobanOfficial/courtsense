import fs from "node:fs";
import { isJobId, jobFile, readJob, readTracks } from "@/lib/jobs.ts";
import { analyze } from "@/lib/metrics.ts";
import { writeReport } from "@/lib/report.ts";

// (Re)generate the coach report with Muse Spark and keep it next to the job.
// Body: { lang?: "en" | "tr" }.
export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/report">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const tracks = readTracks(job);
  if (!tracks || !job.calibration) return Response.json({ error: "Process and calibrate the video first." }, { status: 409 });
  const lang = (await req.json().catch(() => ({}))).lang === "tr" ? "tr" : "en";
  try {
    const report = await writeReport(analyze(tracks, job.calibration), {
      video: job.name,
      analyzedFromSec: job.startSec,
      durationSec: Math.round(tracks.frames / tracks.fps),
    }, lang);
    fs.writeFileSync(jobFile(id, `report.${lang}.md`), report);
    return Response.json({ report });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
