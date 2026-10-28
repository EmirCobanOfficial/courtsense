import fs from "node:fs";
import { Readable } from "node:stream";
import { isJobId, jobFile } from "@/lib/jobs.ts";

// Raw SAM 3.1 output, masks included, for the mask overlay on the video.
export async function GET(req: Request, ctx: RouteContext<"/api/jobs/[id]/sam">) {
  const { id } = await ctx.params;
  const file = isJobId(id) ? jobFile(id, "sam_raw.txt") : "";
  if (!file || !fs.existsSync(file)) return Response.json({ error: "not found" }, { status: 404 });
  // Next also runs GET for HEAD and never reads or cancels that body, so an opened stream would keep its fd forever
  const body = req.method === "HEAD" ? null : (Readable.toWeb(fs.createReadStream(file)) as ReadableStream);
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
