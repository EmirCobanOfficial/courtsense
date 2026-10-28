import fs from "node:fs";
import { connection } from "next/server";
import { jobFile, jobIdFor, listJobs, readJob, writeJob, type Job } from "@/lib/jobs.ts";

export async function GET() {
  await connection(); // reads disk; never prerender
  return Response.json(listJobs());
}

// Register an upload. Returns an existing job when the same file + start time was already uploaded,
// with its end time updated (no re-processing: the end only cuts the analysis).
export async function POST(req: Request) {
  const { name, size, startSec, endSec } = await req.json().catch(() => ({}));
  if (typeof name !== "string" || !name || name.length > 255 || !(size > 0) || !(startSec >= 0) || !Number.isFinite(startSec)) {
    return Response.json({ error: "invalid name, size or startSec" }, { status: 400 });
  }
  if (endSec !== undefined && endSec !== null && !(Number.isFinite(endSec) && endSec > startSec)) {
    return Response.json({ error: "endSec must be after startSec" }, { status: 400 });
  }
  const end = endSec ?? undefined;
  const id = jobIdFor(name, size, startSec);
  const existing = readJob(id);
  if (existing) {
    const needsUpload = existing.status === "uploading" || (existing.status === "error" && !fs.existsSync(jobFile(id, "clip.mp4")));
    if (existing.endSec !== end) writeJob({ ...existing, endSec: end });
    return Response.json({ job: readJob(id), needsUpload });
  }
  const job: Job = { id, name, startSec, endSec: end, createdAt: new Date().toISOString(), status: "uploading", progress: 0 };
  writeJob(job);
  return Response.json({ job, needsUpload: true });
}
