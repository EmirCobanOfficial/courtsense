// Coach report: Muse Spark turns the movement metrics into a short write-up in the coach's language.
import OpenAI from "openai";
import type { Lang } from "./i18n.ts";
import type { PlayerMetrics } from "./metrics.ts";

const instructions = (lang: Lang) => `You assist a tennis coach. You receive movement metrics computed from a training video:
SAM 3.1 tracked both players, and a court homography turned their foot positions into meters.
Write a short report in ${lang === "tr" ? "Turkish" : "English"} for the coach.

Rules:
- Use only the numbers in the data. There is no ball tracking: never mention shots, scores, technique or anything else the data does not contain.
- Player A starts on the near side (closer to the camera), Player B on the far side.
- reliable=false means the player's depth jitters more than 0.3 m per frame (depthNoiseM), so their distance, speeds and zones are rough: say so once, give those numbers only as rough, and draw no conclusions or comparisons from them. lateral and coverage stay usable.
- If a player's coverage is below 0.6, warn that their numbers are incomplete.
- zones: behindBaseline = behind their own baseline, baseline = 0-2 m inside it, midCourt = from 2 m to the service line, net = inside the service box.
- lateral: left/center/right thirds of the singles width, from the player's own point of view.
- perMinuteM: meters run in each minute; point out a clear trend only if there is one.
- speeds are m/s; distances are meters. Round sensibly.
${lang === "tr" ? '- Use Turkish tennis terms: "dip çizgi" (baseline), "servis çizgisi", "servis karesi", "file". No English words.\n' : ""}- No medical, injury or health advice.

Format (Markdown):
${(lang === "tr" ? ["Özet", "Oyuncu A", "Oyuncu B", "Karşılaştırma", "Antrenmanda bakılabilecekler"] : ["Summary", "Player A", "Player B", "Comparison", "Things to check in training"]).map((h, i) => `## ${h}${i === 0 ? "\n2-3 sentences." : ""}`).join("\n")}
Exactly 3 bullets. Each is tied to a number and phrased as something the coach can check, not an order.

Stay under 250 words.`;

export async function writeReport(metrics: PlayerMetrics[], session: { video: string; analyzedFromSec: number; durationSec: number }, lang: Lang = "en") {
  if (!process.env.MODEL_API_KEY) throw new Error("MODEL_API_KEY is not set in .env.local");
  const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
  const players = metrics.map((m) => ({ ...m, heatmap: undefined, objectFrames: undefined })); // the grid is too big and too raw for the prompt, SAM ids mean nothing to the coach; JSON drops undefined
  const res = await client.responses.create({
    model: "muse-spark-1.3",
    instructions: instructions(lang),
    input: JSON.stringify({ session, players }),
    reasoning: { effort: "medium" },
    max_output_tokens: 16000, // reasoning tokens count here too; 4000 ran out before any text on a full session
  });
  if (!res.output_text) {
    throw new Error(`Muse Spark returned no text (status ${res.status}${res.incomplete_details ? `, ${res.incomplete_details.reason}` : ""})`);
  }
  return res.output_text;
}
