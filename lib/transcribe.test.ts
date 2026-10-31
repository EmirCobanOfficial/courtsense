// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribe } from "./transcribe.ts";

test("transcribe: sends WAV with the language and tennis terms as hints, returns the transcript", async () => {
  process.env.MODEL_API_KEY = "test-key";
  let sent: { url: string; init: RequestInit } | null = null;
  const post = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(JSON.stringify({ transcript: " Oyuncu A en hızlı nerede koştu? ", audioDurationMs: 2160 }), { status: 200 });
  }) as unknown as typeof fetch;
  const text = await transcribe(new Blob([new Uint8Array(44)], { type: "audio/wav" }), "tr", post);
  assert.equal(text, "Oyuncu A en hızlı nerede koştu?");
  assert.equal(sent!.url, "https://api.meta.ai/v1/asr/transcribe");
  const form = sent!.init.body as FormData;
  const settings = JSON.parse(await (form.get("request") as Blob).text());
  assert.deepEqual([settings.model, settings.audioEncoding, settings.mode, settings.languageBias], ["muse-voice-transcribe-1.0", "WAV", "PUSH_TO_TALK", ["Turkish"]]);
  assert.ok(settings.keywords.includes("Oyuncu A"));
  assert.ok(form.get("audio") instanceof Blob);
});

test("transcribe: an API error comes back as a readable error; fake mode makes no call", async () => {
  process.env.MODEL_API_KEY = "test-key";
  const failing = (async () => new Response(JSON.stringify({ message: "Unsupported WAV" }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(transcribe(new Blob([]), "en", failing), /Unsupported WAV/);
  process.env.COURTSENSE_FAKE_MODEL = "good";
  try {
    const never = (async () => assert.fail("no network in fake mode")) as unknown as typeof fetch;
    assert.match(await transcribe(new Blob([]), "en", never), /^\(Fake model/);
  } finally {
    delete process.env.COURTSENSE_FAKE_MODEL;
  }
});
