// Practice card: Muse Image draws the coach's goal for the next practice as a top-down court drill, starting from where
// the player mostly stood, put into words. The picture holds no numbers or text, so there is nothing in it to check;
// the numbers go in the caption, straight from the metrics.
import { imageClient, type ImageClient } from "./model.ts";
import type { PlayerMetrics } from "./metrics.ts";

const ZONE = { behindBaseline: "behind the baseline", baseline: "on the baseline", midCourt: "in mid-court", net: "close to the net" };
const SIDE = { left: "on the left side", center: "in the middle", right: "on the right side" };
const most = <K extends string>(shares: Record<K, number>) => (Object.entries(shares) as [K, number][]).sort((a, b) => b[1] - a[1])[0];

// A rough player's forward/back position is left out: only their left/right split is reliable.
export function cardPrompt(m: PlayerMetrics, goal: string): string {
  const where = m.reliable ? `${ZONE[most(m.zones)[0]]}, ${SIDE[most(m.lateral)[0]]}` : SIDE[most(m.lateral)[0]];
  return [
    "A clean, flat illustration of a tennis drill seen from directly above a hard court, for a coach to show a player.",
    `One ${m.player === "A" ? "blue" : "orange"} player figure. In the last session this player mostly stood ${where}.`,
    `The drill shows the coach's goal for the next practice: ${goal.replace(/[0-9]/g, "").replace(/\s+/g, " ").trim().replace(/[^.!?]$/, "$&.")}`,
    "Arrows and a few cones show the movement. White court lines on a blue court.",
    "No text, letters, numbers or logos anywhere in the image.",
  ].join(" ");
}

// One image ($0.01), as a data URL for the page.
export async function drawCard(prompt: string, client: ImageClient = imageClient()): Promise<string> {
  const res = await client.images.generate({ model: "muse-image-1.0", prompt, n: 1, size: "1536x1024", response_format: "b64_json" });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error("Muse Image returned no image");
  const type = b64.startsWith("/9j/") ? "jpeg" : b64.startsWith("UklGR") ? "webp" : b64.startsWith("PHN2") ? "svg+xml" : "png";
  return `data:image/${type};base64,${b64}`;
}
