// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardPrompt, drawCard } from "./card.ts";
import type { ImageClient } from "./model.ts";
import type { PlayerMetrics } from "./metrics.ts";

const player = (p: "A" | "B", reliable: boolean) =>
  ({ player: p, reliable, zones: { behindBaseline: 0.67, baseline: 0.12, midCourt: 0.11, net: 0.1 }, lateral: { left: 0.11, center: 0.78, right: 0.11 } }) as PlayerMetrics;

test("cardPrompt: the player's pattern in words, the coach's goal, and no numbers", () => {
  const p = cardPrompt(player("A", true), "Step inside the baseline after 10 serves");
  assert.match(p, /blue player figure/);
  assert.match(p, /mostly stood behind the baseline, in the middle\./);
  assert.match(p, /goal for the next practice: Step inside the baseline after serves\. Arrows/);
  assert.match(p, /No text, letters, numbers or logos/);
  assert.doesNotMatch(p, /[0-9]/);
});

test("cardPrompt: a rough player's depth is left out, only left/right is used", () => {
  const p = cardPrompt(player("B", false), "Daha geniş oyna");
  assert.match(p, /orange player figure.*mostly stood in the middle\./);
  assert.doesNotMatch(p, /baseline|mid-court|net/);
  assert.match(p, /Daha geniş oyna/);
});

test("drawCard: asks Muse Image for one landscape image and returns it as a data URL", async () => {
  let sent: Record<string, unknown> = {};
  const client = { images: { generate: async (args: Record<string, unknown>) => ((sent = args), { data: [{ b64_json: "iVBORw0KGgo=" }] }) } } as unknown as ImageClient;
  assert.equal(await drawCard("a drill", client), "data:image/png;base64,iVBORw0KGgo=");
  assert.deepEqual(sent, { model: "muse-image-1.0", prompt: "a drill", n: 1, size: "1536x1024", response_format: "b64_json" });
  const empty = { images: { generate: async () => ({ data: [] }) } } as unknown as ImageClient;
  await assert.rejects(drawCard("a drill", empty), /returned no image/);
});
