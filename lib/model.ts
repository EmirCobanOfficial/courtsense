// The clients for Muse Spark calls (coach assistant and report) and Muse Image (practice card). With
// COURTSENSE_FAKE_MODEL=good or =bad the scripted local stand-ins in fake-model.ts answer instead: no network, no cost,
// for checking the coach, report and card flows in the browser. SAM is disabled in that mode too (jobs.ts).
import OpenAI from "openai";
import { fakeImages, fakeModel } from "./fake-model.ts";

export type ModelClient = Pick<OpenAI, "responses">;
export type ImageClient = Pick<OpenAI, "images">;

export const fakeMode = () => !!process.env.COURTSENSE_FAKE_MODEL;

function meta() {
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not set in .env.local");
  return new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
}

export function modelClient(): ModelClient {
  return fakeMode() ? fakeModel(process.env.COURTSENSE_FAKE_MODEL === "bad") : meta();
}

export function imageClient(): ImageClient {
  return fakeMode() ? fakeImages() : meta();
}
