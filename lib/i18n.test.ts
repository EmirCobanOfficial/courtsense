// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsd } from "./i18n.ts";

test("formatUsd: dollar amounts in English and in Turkish (decimal comma, dollar sign kept)", () => {
  assert.equal(formatUsd(2.1376, "en"), "$2.14");
  assert.equal(formatUsd(1.0688, "en"), "$1.07");
  assert.equal(formatUsd(2.1376, "tr"), "$2,14");
  assert.equal(formatUsd(1.0688, "tr"), "$1,07");
  assert.equal(formatUsd(0.0328, "en", 3), "$0.033"); // the assistant's cost per answer
  assert.equal(formatUsd(0.0328, "tr", 3), "$0,033");
});
