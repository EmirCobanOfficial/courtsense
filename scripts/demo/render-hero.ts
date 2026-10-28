// Renders the demo video's two hero clips from a processed job: the footage with both players' SAM 3.1 masks (the
// same records MaskVideo shows) and a bird's-eye minimap of the positions every metric is measured on.
// Run from the repo root, since jobs.ts reads ./data: node scripts/demo/render-hero.ts <outDir>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { decodeMaskToRaster, frameIndexOf, parseVideoStream, recordsOfKind, type ResponsesEvent, type SegmentationMaskRecord } from "@meta-sam/parser";
import { COURT, COURT_LINES, type Pt } from "../../lib/court.ts";
import { jobFile, readJob, readTracks } from "../../lib/jobs.ts";
import { playerPositions, type Sample } from "../../lib/metrics.ts";

const JOB = "d8650763e4d0";
// Rally windows (clip frames) where both players are tracked and masked in every frame and A covers the most ground:
// open: A runs 11.7 m in the 6 masked seconds; minimap: A runs 23.1 m in 24 s and stays left of the panel (x < 1406 px).
const CLIPS = [
  { name: "hero_open", start: 3140, frames: 120, maskFadeIn: 2, minimap: false },
  { name: "hero_minimap", start: 5570, frames: 360, maskFadeIn: 0, minimap: true },
];
const W = 1920;
const H = 1080;
const COLORS = [[0x16, 0x77, 0xff], [0xd4, 0x6b, 0x08]]; // A, B: MaskVideo's colors
const TRAIL_S = 3;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Minimap: world meters shown (the court plus the run-off these windows use), near baseline at the bottom, +x right as the camera sees it.
const MAP = { x0: -7.5, x1: 7.5, y0: -4, y1: COURT.length + 4.5, scale: 23.5 }; // px per m; 758 px tall
const PANEL = { x: 1468, y: 90, w: 412, h: 900, r: 20 };
const ORIGIN = { x: PANEL.x + 30, y: PANEL.y + 72 }; // top-left of the court drawing
const toPanel = ([x, y]: Pt): Pt => [ORIGIN.x + (x - MAP.x0) * MAP.scale, ORIGIN.y + (MAP.y1 - y) * MAP.scale];

const FONT = `-apple-system, 'Helvetica Neue', Arial, sans-serif`; // goes inside style="" attributes
const legend = (rgb: number[], text: string) =>
  `<div style="display:flex;align-items:center;gap:10px;height:34px;font:500 22px ${FONT}"><span style="width:14px;height:14px;border-radius:50%;background:rgb(${rgb});box-shadow:0 0 0 2px #fff"></span>${text}</div>`;
const LABELS = {
  sam: { x: 40, y: 40, w: 320, h: 52, html: `<div style="display:inline-flex;align-items:center;height:52px;padding:0 22px;border-radius:26px;background:rgba(10,14,22,.78);font:600 24px ${FONT}">SAM 3.1 masks</div>` },
  title: { x: ORIGIN.x, y: PANEL.y + 22, w: 352, h: 40, html: `<div style="font:600 26px/40px ${FONT}">Bird’s-eye view</div>` },
  a: { x: ORIGIN.x, y: PANEL.y + PANEL.h - 56, w: 170, h: 34, html: legend(COLORS[0], "Player A") },
  b: { x: ORIGIN.x + 180, y: PANEL.y + PANEL.h - 56, w: 170, h: 34, html: legend(COLORS[1], "Player B") },
};

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/demo/render-hero.ts <outDir>");
const job = readJob(JOB);
const tracks = job && readTracks(job);
if (!job?.calibration || !tracks) throw new Error(`job ${JOB} is missing, unprocessed or uncalibrated`);
const { fps } = tracks;
const players = playerPositions(tracks, job.calibration);
const at = players.map((p) => new Map(p.smoothed.flat().map((s): [number, Sample] => [s.f, s])));
const masks = await playerMasks();
fs.mkdirSync(path.join(out, "labels"), { recursive: true });
renderLabels(path.join(out, "labels"));
const panel = staticPanel();
for (const clip of CLIPS) await render(clip);

async function render(clip: (typeof CLIPS)[number]) {
  const overlays = clip.minimap ? Object.entries(LABELS) : [];
  let graph = "[0:v]";
  overlays.forEach(([name, l], i) => (graph += `[${i + 1}:v]overlay=${l.x}:${l.y}:format=rgb[l${name}];[l${name}]`));
  graph += "fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]";
  const file = path.join(out, `${clip.name}.mp4`);
  const enc = spawn("ffmpeg", [
    "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-framerate", String(fps), "-i", "pipe:0",
    ...overlays.flatMap(([name]) => ["-i", path.join(out, "labels", `${name}.png`)]),
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-filter_complex", graph, "-map", "[v]", "-map", `${overlays.length + 1}:a`,
    "-t", String(clip.frames / fps), "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", file,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const encoded = exited(enc, "ffmpeg encoder");
  // half a frame early: a seek exactly on a frame's time can round past it
  const dec = spawn("ffmpeg", [
    "-v", "error", "-ss", String((clip.start - 0.5) / fps), "-i", jobFile(JOB, "clip.mp4"), "-frames:v", String(clip.frames),
    "-vf", "scale=in_color_matrix=bt709:in_range=tv,format=rgba", "-f", "rawvideo", "pipe:1",
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const decoded = exited(dec, "ffmpeg decoder");

  let i = 0;
  for await (const px of rawFrames(dec.stdout!, W * H * 4)) {
    const f = clip.start + i++;
    const t = Math.min(1, Math.max(0, (f - clip.start) / fps - clip.maskFadeIn)); // masks fade in over 1 s
    const k = clip.maskFadeIn ? t * t * (3 - 2 * t) : 1;
    for (const { player, rec } of masks.get(f) ?? []) drawMask(px, rec, COLORS[player], k);
    if (clip.minimap) drawMinimap(px, f);
    if (!enc.stdin!.write(px)) await once(enc.stdin!, "drain");
  }
  enc.stdin!.end();
  await Promise.all([decoded, encoded]);
  if (i !== clip.frames) throw new Error(`${clip.name}: decoded ${i} of ${clip.frames} frames`);
  console.log(`${file}: clip frames ${clip.start}-${clip.start + clip.frames - 1}`);
}

// MaskVideo's records: the saved SAM output replayed as Responses events, then only masks whose id is a player's at
// that frame (SAM hands a player's id to someone else later).
async function playerMasks() {
  const lane = { item_id: "message-1", output_index: 0, content_index: 0 };
  const text = fs.readFileSync(jobFile(JOB, "sam_raw.txt"), "utf8");
  async function* events(): AsyncIterable<ResponsesEvent> {
    yield { type: "response.output_text.delta", ...lane, delta: text };
    yield { type: "response.output_text.done", ...lane, text };
    yield { type: "response.completed" };
  }
  const result = await parseVideoStream(events()).finalResult;
  if (result.outcome.status !== "completed") throw new Error(`SAM output incomplete: ${JSON.stringify(result.outcome)}`);
  const spans = new Map(players.flatMap((p, player) => Object.entries(p.objectFrames).map(([id, s]): [string, { player: number; s: [number, number] }] => [id, { player, s }])));
  const byFrame = new Map<number, { player: number; rec: SegmentationMaskRecord }[]>();
  for (const rec of recordsOfKind(result.records, "mask")) {
    const span = spans.get(rec.objectId);
    const f = frameIndexOf(rec);
    if (!span || f === undefined || f < span.s[0] || f > span.s[1]) continue;
    if (!byFrame.has(f)) byFrame.set(f, []);
    byFrame.get(f)!.push({ player: span.player, rec });
  }
  return byFrame;
}

// The raster covers the record's box 1:1. A light fill keeps the player visible; a 2 px inner outline keeps the edge crisp.
function drawMask(px: Buffer, rec: SegmentationMaskRecord, rgb: number[], k: number) {
  const { left, top, right, bottom } = rec.bounds;
  const { width: w, height: h } = rec.mask;
  if (w !== right - left || h !== bottom - top) throw new Error(`mask ${rec.identity} is ${w}x${h}, its box ${right - left}x${bottom - top}`);
  const m = decodeMaskToRaster(rec.mask);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      const inner = on(x - 2, y) && on(x - 1, y) && on(x + 1, y) && on(x + 2, y) && on(x, y - 2) && on(x, y - 1) && on(x, y + 1) && on(x, y + 2);
      blend(px, left + x, top + y, rgb, (inner ? 0.35 : 0.8) * k);
    }
  }
}

function drawMinimap(px: Buffer, f: number) {
  for (let y = 0; y < PANEL.h; y++) {
    for (let x = 0; x < PANEL.w; x++) {
      const j = (y * PANEL.w + x) * 4;
      const i = ((PANEL.y + y) * W + PANEL.x + x) * 4;
      const k = 1 - panel[j + 3];
      for (let c = 0; c < 3; c++) px[i + c] = panel[j + c] + px[i + c] * k + 0.5;
    }
  }
  const n = TRAIL_S * fps;
  at.forEach((byFrame, p) => {
    // fading trail; per-pixel max alpha so overlapping segment ends do not stack into beads
    const alpha = new Map<number, number>();
    let prev: Sample | undefined;
    for (let g = f - n; g <= f; g++) {
      const s = byFrame.get(g);
      if (!s) continue;
      if (prev && s.f - prev.f <= 3) {
        const age = (f - s.f) / n;
        capsule(toPanel([prev.x, prev.y]), toPanel([s.x, s.y]), 1.5 + 1.5 * (1 - age), (x, y, c) => {
          const key = y * W + x;
          alpha.set(key, Math.max(alpha.get(key) ?? 0, c * 0.85 * (1 - age)));
        });
      }
      prev = s;
    }
    for (const [key, a] of alpha) blend(px, key % W, Math.floor(key / W), COLORS[p], a);
    const now = byFrame.get(f);
    if (!now) return;
    const c = toPanel([now.x, now.y]);
    capsule(c, c, 11, (x, y, a) => blend(px, x, y, [255, 255, 255], a));
    capsule(c, c, 8.5, (x, y, a) => blend(px, x, y, COLORS[p], a));
  });
}

// Premultiplied RGBA of everything on the minimap that never moves: the panel, the court and its lines.
function staticPanel() {
  const layer = new Float32Array(PANEL.w * PANEL.h * 4);
  const paint = (x: number, y: number, rgb: number[], a: number) => {
    x -= PANEL.x;
    y -= PANEL.y;
    if (x < 0 || y < 0 || x >= PANEL.w || y >= PANEL.h) return;
    const j = (y * PANEL.w + x) * 4;
    for (let c = 0; c < 3; c++) layer[j + c] = rgb[c] * a + layer[j + c] * (1 - a);
    layer[j + 3] = a + layer[j + 3] * (1 - a);
  };
  // rounded rectangle: signed distance to the corner arcs, antialiased
  for (let y = 0; y < PANEL.h; y++) {
    for (let x = 0; x < PANEL.w; x++) {
      const dx = Math.max(Math.abs(x + 0.5 - PANEL.w / 2) - (PANEL.w / 2 - PANEL.r), 0);
      const dy = Math.max(Math.abs(y + 0.5 - PANEL.h / 2) - (PANEL.h / 2 - PANEL.r), 0);
      const cover = Math.min(1, Math.max(0, PANEL.r + 0.5 - Math.hypot(dx, dy)));
      if (cover) paint(PANEL.x + x, PANEL.y + y, [10, 14, 22], 0.78 * cover);
    }
  }
  const [cx0, cy0] = toPanel([-COURT.doublesHalf, COURT.length]).map(Math.round);
  const [cx1, cy1] = toPanel([COURT.doublesHalf, 0]).map(Math.round);
  for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) paint(x, y, [255, 255, 255], 0.07);
  COURT_LINES.forEach(([a, b], i) => {
    const net = i === COURT_LINES.length - 1;
    // 2 px lines centered on a pixel edge, the 3 px net on a pixel center: crisp without antialiasing blur
    const snap = (p: Pt): Pt => toPanel(p).map((v) => (net ? Math.floor(v) + 0.5 : Math.round(v))) as Pt;
    capsule(snap(a), snap(b), net ? 1.5 : 1, (x, y, c) => paint(x, y, net ? [200, 210, 225] : [255, 255, 255], c * 0.9));
  });
  return layer;
}

// Antialiased capsule (a disc when a = b): calls plot with each touched pixel's coverage.
function capsule([ax, ay]: Pt, [bx, by]: Pt, r: number, plot: (x: number, y: number, cover: number) => void) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = Math.floor(Math.min(ay, by) - r - 1); y <= Math.ceil(Math.max(ay, by) + r + 1); y++) {
    for (let x = Math.floor(Math.min(ax, bx) - r - 1); x <= Math.ceil(Math.max(ax, bx) + r + 1); x++) {
      const t = Math.min(1, Math.max(0, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / len2));
      const cover = Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - ax - t * dx, y + 0.5 - ay - t * dy));
      if (cover > 0) plot(x, y, cover);
    }
  }
}

function blend(px: Buffer, x: number, y: number, rgb: number[], a: number) {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 4;
  for (let c = 0; c < 3; c++) px[i + c] = px[i + c] + (rgb[c] - px[i + c]) * a + 0.5;
}

// ffmpeg here has no drawtext, so labels are HTML screenshots with a transparent background, overlaid by the encoder.
function renderLabels(dir: string) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "render-hero-chrome-"));
  try {
    for (const [name, l] of Object.entries(LABELS)) {
      const file = path.join(dir, `${name}.png`);
      fs.rmSync(file, { force: true });
      const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden;color:#fff;-webkit-font-smoothing:antialiased}</style>${l.html}`;
      const r = spawnSync(CHROME, [
        "--headless=new", `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-device-scale-factor=1",
        "--default-background-color=00000000", `--window-size=${l.w},${l.h}`, `--screenshot=${file}`,
        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
      ], { encoding: "utf8", timeout: 60_000 });
      if (!fs.existsSync(file)) throw new Error(`Chrome did not render the ${name} label: ${r.error ?? r.stderr}`);
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function* rawFrames(stream: AsyncIterable<Buffer>, size: number) {
  let frame = Buffer.allocUnsafe(size);
  let n = 0;
  for await (const chunk of stream) {
    for (let off = 0; off < chunk.length; ) {
      const k = Math.min(size - n, chunk.length - off);
      chunk.copy(frame, n, off, off + k);
      n += k;
      off += k;
      if (n === size) {
        yield frame;
        frame = Buffer.allocUnsafe(size); // the encoder may still hold the last one
        n = 0;
      }
    }
  }
  if (n) throw new Error("decoder output ended inside a frame");
}

function exited(p: ChildProcess, what: string) {
  return new Promise<void>((resolve, reject) => {
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${what} exited ${code}`))));
  });
}
