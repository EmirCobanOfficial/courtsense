import fs from "node:fs";
import { after } from "next/server";
import { isJobId, jobFile, processJob, readJob, readTracks } from "@/lib/jobs.ts";
import { analyze } from "@/lib/metrics.ts";

export async function GET(req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const tracks = job.status === "ready" && job.calibration ? readTracks(job) : null;
  const lang = new URL(req.url).searchParams.get("lang") === "tr" ? "tr" : "en";
  // report.md is the first, Turkish-only version
  const reportFile = [jobFile(id, `report.${lang}.md`), ...(lang === "tr" ? [jobFile(id, "report.md")] : [])].find((f) => fs.existsSync(f));
  const report = reportFile ? fs.readFileSync(reportFile, "utf8") : null;
  return Response.json({ job, metrics: tracks ? analyze(tracks, job.calibration!) : null, report });
}

// Retry processing; finished steps are skipped.
export async function POST(_req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  after(() => processJob(id));
  return Response.json({ job });
}
