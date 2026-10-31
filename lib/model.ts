// The client for Muse Spark calls (coach assistant and report). With COURTSENSE_FAKE_MODEL=good or =bad the scripted
// local model in fake-model.ts answers instead: no network, no cost, for checking the coach and report flows in the
// browser. SAM is disabled in that mode too (jobs.ts).
import OpenAI from "openai";
import { fakeModel } from "./fake-model.ts";

export type ModelClient = Pick<OpenAI, "responses">;

export const fakeMode = () => !!process.env.COURTSENSE_FAKE_MODEL;

export function modelClient(): ModelClient {
  if (fakeMode()) return fakeModel(process.env.COURTSENSE_FAKE_MODEL === "bad");
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not set in .env.local");
  return new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
}
