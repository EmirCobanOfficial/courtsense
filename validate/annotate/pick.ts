// Step 3: pick frames of the coach's session for hand-marking both players' feet and save them as JPEGs (local, free).
// The frames are spread evenly over the frames where the app tracked both players. Five of them come back at the end
// to measure how repeatable the hand marks are. Everything stays in data/ (git-ignored) on this machine.
// usage (from the repo root): node validate/annotate/pick.ts [--n 40]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { DIR, loadSystem, systemAt, type Manifest } from "./system.ts";

const nArg = process.argv.indexOf("--n");
const N = nArg > 0 ? Number(process.argv[nArg + 1]) : 40;
if (!(N >= 5 && N <= 200)) throw new Error("--n must be 5-200");

const sys = loadSystem();
const { fps, width, height } = sys.tracks;
const both = [...sys.players[0].raw.keys()].filter((f) => sys.players[1].raw.has(f) && systemAt(sys, 0, f) && systemAt(sys, 1, f)).sort((a, b) => a - b);
const picked = Array.from({ length: N }, (_, i) => both[Math.floor(((i + 0.5) * both.length) / N)]);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

fs.mkdirSync(DIR, { recursive: true });
const frames: Manifest["frames"] = picked.map((f) => {
  const file = `f${String(f).padStart(5, "0")}.jpg`;
  // -ss a quarter frame early: ffmpeg starts at the first frame at or after it, which is frame f
  if (!fs.existsSync(`${DIR}/${file}`)) execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, (f - 0.25) / fps)), "-i", sys.clip, "-frames:v", "1", "-q:v", "2", `${DIR}/${file}`]);
  const players = Object.fromEntries((["A", "B"] as const).map((p, i) => {
    const [l, t, r, b] = systemAt(sys, i as 0 | 1, f)!.box;
    return [p, { tag: [(l + r) / 2, t], view: [(l + r) / 2, (t + b) / 2, b - t] }]; // a name tag above the head, and where to zoom
  }));
  return { id: file.slice(0, -4), f, file, sourceTime: mmss(sys.job.startSec + f / fps), players };
});
const repeats = frames.filter((_, i) => i % 8 === 3).map((x) => ({ ...x, id: `${x.id}-again`, repeatOf: x.id }));
const manifest: Manifest = { job: sys.job.id, width, height, fps, frames: [...frames, ...repeats] };
fs.writeFileSync(`${DIR}/frames.json`, JSON.stringify(manifest, null, 1) + "\n");
console.log(`${frames.length} frames + ${repeats.length} repeats from ${both.length} frames with both players tracked -> ${DIR}`);
