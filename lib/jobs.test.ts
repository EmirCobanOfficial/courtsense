// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { jobIdFor } from "./jobs.ts";

test("jobIdFor: a Standard job keeps its old id; Economy gets its own, so the two never share cached SAM results", () => {
  const before = crypto.createHash("sha1").update("DJI.MP4|123|190").digest("hex").slice(0, 12); // the id before modes
  assert.equal(jobIdFor("DJI.MP4", 123, 190), before);
  assert.equal(jobIdFor("DJI.MP4", 123, 190, 15), before);
  const economy = jobIdFor("DJI.MP4", 123, 190, 7.5);
  assert.notEqual(economy, before);
  assert.match(economy, /^[a-f0-9]{12}$/);
  assert.equal(jobIdFor("DJI.MP4", 123, 190, 7.5), economy); // stable, so a re-upload in Economy reuses its results
});
