// Muse Voice Transcribe (Meta Model API): the coach can ask the assistant by voice. The words come back as text the
// coach can still correct before asking. The API takes WAV only (mono, 16-bit PCM, 16 or 24 kHz); the route converts.
// The language and the tennis terms go along as hints: on a test recording they turned "Oyumcu ayn" into "Oyuncu A en".
import { fakeMode } from "./model.ts";
import type { Lang } from "./i18n.ts";

const URL = "https://api.meta.ai/v1/asr/transcribe";
const HINTS: Record<Lang, { languageBias: string[]; keywords: string[] }> = {
  en: { languageBias: ["English"], keywords: ["Player A", "Player B", "baseline", "net", "service line", "mid-court"] },
  tr: { languageBias: ["Turkish"], keywords: ["Oyuncu A", "Oyuncu B", "dip çizgi", "file", "servis çizgisi", "orta saha"] },
};

export async function transcribe(wav: Blob, lang: Lang, post: typeof fetch = fetch): Promise<string> {
  if (fakeMode()) return lang === "tr" ? "(Sahte model, API çağrısı yok.) Oyuncu A en hızlı nerede koştu?" : "(Fake model, no API call.) Where did Player A run fastest?";
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not set in .env.local");
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK", ...HINTS[lang] })], { type: "application/json" }));
  form.append("audio", wav, "question.wav");
  const res = await post(URL, { method: "POST", headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, Accept: "application/json" }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Muse Voice Transcribe: ${body.message ?? body.error?.message ?? `HTTP ${res.status}`}`);
  return String(body.transcript ?? "").trim();
}
