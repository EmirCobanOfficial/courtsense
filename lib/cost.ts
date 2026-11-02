// SAM 3.1 video pricing and the two analysis modes. No Node APIs here: the upload screen shows its estimate with these
// numbers, and the server cuts the clip and names the job with the same ones.
export const SAM_USD_PER_FRAME = 0.2 / 1000; // $0.20 per 1,000 frames (Meta Model API pricing)
export const SAM_MIN_FRAMES = 50; // a video request is billed for at least 50 frames
export const MAX_FRAMES = 15000; // frames one SAM 3.1 request takes
export const STANDARD_FPS = 15;
export const ECONOMY_FPS = 7.5; // half the frames: positions as accurate, distance and peak speed read 1-5% lower (README)

// The frame rate a request asks for: Standard when unset; anything but the two modes is refused (null).
export const parseFps = (v: unknown): number | null =>
  v === undefined || v === null ? STANDARD_FPS : v === STANDARD_FPS || v === ECONOMY_FPS ? v : null;

// Frames SAM 3.1 gets for `seconds` of video at `fps` (the clip is cut that way in lib/jobs.ts), and their price.
export function samCost(seconds: number, fps: number) {
  const frames = Math.min(MAX_FRAMES, Math.round(seconds * fps));
  return { frames, usd: Math.max(SAM_MIN_FRAMES, frames) * SAM_USD_PER_FRAME };
}
