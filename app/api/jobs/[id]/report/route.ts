import fs from "node:fs";
import { isJobId, jobFile, readJob, readTracks } from "@/lib/jobs.ts";
import { loadSession } from "@/lib/coach.ts";
import { writeReport } from "@/lib/report.ts";

// (Re)generate the coach report with Muse Spark and keep it next to the job, with whether its numbers checked out.
// Body: { lang?: "en" | "tr" }.
export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[id]/report">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const tracks = readTracks(job);
  if (!tracks || !job.calibration) return Response.json({ error: "Process and calibrate the video first." }, { status: 409 });
  const lang = (await req.json().catch(() => ({}))).lang === "tr" ? "tr" : "en";
  try {
    const { text, verified, problems } = await writeReport(loadSession(job, tracks, jobFile(id, "clip.mp4")), lang);
    fs.writeFileSync(jobFile(id, `report.${lang}.md`), text);
    fs.writeFileSync(jobFile(id, `report.${lang}.json`), JSON.stringify({ verified, problems }, null, 1));
    return Response.json({ report: text, verified });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
