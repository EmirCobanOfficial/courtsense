import fs from "node:fs";
import { Readable } from "node:stream";
import { isJobId, jobFile } from "@/lib/jobs.ts";

// The processed clip with HTTP Range support: Mediabunny's UrlSource reads the MP4 by byte ranges.
export async function GET(req: Request, ctx: RouteContext<"/api/jobs/[id]/video">) {
  const { id } = await ctx.params;
  const file = isJobId(id) ? jobFile(id, "clip.mp4") : "";
  const size = file && fs.statSync(file, { throwIfNoEntry: false })?.size;
  if (!size) return Response.json({ error: "not found" }, { status: 404 });
  // RFC 9110 lets a server ignore Range (and requires it for unknown units): anything but one byte range gets the whole file
  const header = req.headers.get("range")?.match(/^bytes=\d*-\d*$/i)?.[0] ?? null;
  const range = header === null ? [0, size - 1] : byteRange(header, size);
  if (!range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const [start, end] = range;
  const headers: Record<string, string> = { "accept-ranges": "bytes", "content-length": String(end - start + 1), "content-type": "video/mp4" };
  if (header !== null) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  const body = req.method === "HEAD" ? null : (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream);
  return new Response(body, { status: header === null ? 200 : 206, headers });
}

// One "bytes=a-b", "a-" or "-n" range as inclusive [start, end] inside the file; null when malformed or unsatisfiable.
function byteRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  const [start, end] = m[1] ? [+m[1], m[2] ? Math.min(+m[2], size - 1) : size - 1] : [Math.max(0, size - +m[2]), size - 1];
  return start <= end ? [start, end] : null;
}
