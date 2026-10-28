// run: node --test validate/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { budgetClient, BudgetError, PRICE, worstCaseUsd } from "./budget.ts";

type Client = Pick<OpenAI, "responses">;
const fake = (usage = { input_tokens: 1000, output_tokens: 500 }) => {
  let calls = 0;
  const client = { responses: { create: async () => (calls++, { output: [], usage }) } } as unknown as Client;
  return { client, calls: () => calls };
};
const req = (extra: Record<string, unknown> = {}) => ({ model: "muse-spark-1.3", input: "hello", max_output_tokens: 1000, ...extra });

test("budget: charges the real usage after each call", async () => {
  const f = fake();
  const { client, ledger } = budgetClient(f.client, 0.5);
  await client.responses.create(req() as never);
  assert.equal(f.calls(), 1);
  assert.equal(ledger.calls, 1);
  assert.ok(Math.abs(ledger.spentUsd - (1000 * PRICE.input + 500 * PRICE.output)) < 1e-12);
});

test("budget: refuses a call whose worst case would pass the cap, before it reaches the API", async () => {
  const f = fake();
  const cap = worstCaseUsd(req()) * 1.5; // room for one worst case, not two
  const { client, ledger } = budgetClient(f.client, cap);
  ledger.spentUsd = cap - worstCaseUsd(req()) / 2;
  await assert.rejects(client.responses.create(req() as never), BudgetError);
  assert.equal(f.calls(), 0);
  assert.equal(ledger.refused, 1);
});

test("budget: refuses video input and missing max_output_tokens", async () => {
  const f = fake();
  const { client } = budgetClient(f.client, 0.5);
  const video = req({ input: [{ role: "user", content: [{ type: "input_video", video_url: "data:video/mp4;base64,AAAA" }] }] });
  await assert.rejects(client.responses.create(video as never), /video/);
  await assert.rejects(client.responses.create(req({ max_output_tokens: undefined }) as never), /max_output_tokens/);
  assert.equal(f.calls(), 0);
});

test("budget: a failed call is charged at its worst case", async () => {
  const client = { responses: { create: async () => { throw new Error("network"); } } } as unknown as Client;
  const { client: c, ledger } = budgetClient(client, 0.5);
  await assert.rejects(c.responses.create(req() as never), /network/);
  assert.ok(Math.abs(ledger.spentUsd - worstCaseUsd(req())) < 1e-12);
});
