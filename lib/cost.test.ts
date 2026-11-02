// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ECONOMY_FPS, MAX_FRAMES, parseFps, samCost, STANDARD_FPS } from "./cost.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("samCost: the coach's 712.5 s clip gives what SAM 3.1 billed, in both modes", () => {
  // billed: 10,688 frames on Oct 27 (15 fps), 5,344 frames on Nov 2 (7.5 fps)
  const standard = samCost(712.533, STANDARD_FPS), economy = samCost(712.533, ECONOMY_FPS);
  assert.equal(standard.frames, 10688);
  near(standard.usd, 2.1376);
  assert.equal(standard.usd.toFixed(2), "2.14");
  assert.equal(economy.frames, 5344);
  near(economy.usd, 1.0688);
  assert.equal(economy.usd.toFixed(2), "1.07");
});

test("samCost: per minute, the 50-frame minimum and the one-request cap", () => {
  assert.equal(samCost(60, STANDARD_FPS).usd.toFixed(2), "0.18");
  assert.equal(samCost(60, ECONOMY_FPS).usd.toFixed(2), "0.09");
  assert.deepEqual(samCost(2, ECONOMY_FPS).frames, 15);
  near(samCost(2, ECONOMY_FPS).usd, 0.01); // billed as 50 frames
  assert.equal(samCost(3600, STANDARD_FPS).frames, MAX_FRAMES);
});

test("parseFps: Standard when unset, only the two modes accepted", () => {
  assert.equal(parseFps(undefined), 15);
  assert.equal(parseFps(null), 15);
  assert.equal(parseFps(15), 15);
  assert.equal(parseFps(7.5), 7.5);
  for (const bad of [30, 0, -7.5, "7.5", NaN, {}]) assert.equal(parseFps(bad), null);
});
