import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { after } from "next/server";
import { isJobId, jobFile, processJob, readJob } from "@/lib/jobs.ts";

// Raw video bytes in the body; streamed to disk so a multi-GB file never sits in memory.
export async function PUT(req: Request, ctx: RouteContext<"/api/jobs/[id]/upload">) {
  const { id } = await ctx.params;
  const job = isJobId(id) ? readJob(id) : null;
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  if (job.status !== "uploading" && job.status !== "error") return Response.json({ error: "already uploaded" }, { status: 409 });
  if (!req.body) return Response.json({ error: "empty body" }, { status: 400 });
  await pipeline(Readable.fromWeb(req.body as NodeWebStream), fs.createWriteStream(jobFile(id, "source")));
  after(() => processJob(id));
  return Response.json({ job: readJob(id) });
}
