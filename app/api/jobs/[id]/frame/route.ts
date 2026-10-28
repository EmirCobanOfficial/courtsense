import fs from "node:fs";
import { isJobId, jobFile } from "@/lib/jobs.ts";

export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]/frame">) {
  const { id } = await ctx.params;
  const file = isJobId(id) ? jobFile(id, "frame.jpg") : "";
  if (!file || !fs.existsSync(file)) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { "content-type": "image/jpeg" } });
}
