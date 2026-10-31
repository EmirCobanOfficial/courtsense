import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { transcribe } from "@/lib/transcribe.ts";

const MAX_BYTES = 3_000_000; // about a minute of what browsers record

// A spoken question to text. Body: multipart form with `audio` (whatever the browser recorded) and `lang`. Returns { text }.
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return Response.json({ error: "send the recording as audio" }, { status: 400 });
  if (audio.size > MAX_BYTES) return Response.json({ error: "the recording is too long (about a minute at most)" }, { status: 413 });
  const lang = form?.get("lang") === "tr" ? "tr" : "en";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtsense-voice-"));
  try {
    fs.writeFileSync(path.join(dir, "in"), Buffer.from(await audio.arrayBuffer()));
    // the API takes WAV only: mono, 16-bit PCM, 24 kHz; at most 60 s of it
    await promisify(execFile)("ffmpeg", ["-v", "error", "-y", "-i", path.join(dir, "in"), "-t", "60", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-map_metadata", "-1", path.join(dir, "q.wav")]);
    const text = await transcribe(new Blob([fs.readFileSync(path.join(dir, "q.wav"))], { type: "audio/wav" }), lang);
    return Response.json({ text });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
