// Coach report: Muse Spark turns the session's numbers into a short write-up in the coach's language.
// It is written from the same views the assistant's tools return and lists every number as a claim, checked like the
// assistant's answers (claims.ts). One rewrite with the problems found; after that, or if the rewrite call fails, the
// report is kept but marked unverified.
import type OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { verify, type Player, type Problem } from "./claims.ts";
import { CLAIM_RULES, CLAIMS, reportData, type Session } from "./coach.ts";
import type { Lang } from "./i18n.ts";
import { modelClient, type ModelClient } from "./model.ts";

const ATTEMPTS = 2;

const instructions = (lang: Lang) => `You assist a tennis coach. You receive movement data computed from a training video:
SAM 3.1 tracked both players, and a court homography turned their foot positions into meters.
Write a short report in ${lang === "tr" ? "Turkish" : "English"} for the coach and submit it with submit_report.

Rules:
- Use only the numbers in the data. There is no ball tracking: never mention shots, scores, technique or anything else the data does not contain.
- Player A starts on the near side (closer to the camera), Player B on the far side.
- reliable=false means the player's depth jitters more than 0.3 m per frame (depthNoiseM), so their distance, speeds and zones are rough: say so once, give those numbers only as rough, and draw no conclusions or comparisons from them. lateralPct and coveragePct stay usable.
- If a player's coveragePct is below 60, warn that their numbers are incomplete.
- zonesPct: behindBaseline = behind their own baseline, baseline = 0-2 m inside it, midCourt = from 2 m to the service line, net = inside the service box.
- zoneRangesPct (rough players only): each zone's share as [clearly in it, possibly in it], from the measured position error. For those players give the zones as these ranges.
- lateralPct: left/center/right thirds of the singles width, from the player's own point of view.
- minutes: meters run in each minute (from = its start); point out a clear trend only if there is one.
${CLAIM_RULES(lang)}
${lang === "tr" ? '- Use Turkish tennis terms: "dip çizgi" (baseline), "servis çizgisi", "servis karesi", "file". No English words.\n' : ""}- No medical, injury or health advice.

Format (Markdown):
${(lang === "tr" ? ["Özet", "Oyuncu A", "Oyuncu B", "Karşılaştırma", "Antrenmanda bakılabilecekler"] : ["Summary", "Player A", "Player B", "Comparison", "Things to check in training"]).map((h, i) => `## ${h}${i === 0 ? "\n2-3 sentences." : ""}`).join("\n")}
Exactly 3 bullets. Each is tied to a number and phrased as something the coach can check, not an order.

Stay under 250 words.`;

const TOOL = {
  type: "function" as const, strict: false, name: "submit_report",
  description: "Submit the Markdown report with every number in it listed as a claim. Refused when a claim does not match the data, or the text has a number without a claim, after the wrong player, in the wrong unit, or a rough value not marked as rough.",
  parameters: { type: "object", properties: { markdown: { type: "string" }, claims: CLAIMS }, required: ["markdown", "claims"], additionalProperties: false },
};

export async function writeReport(s: Session, lang: Lang = "en", client: ModelClient = modelClient()): Promise<{ text: string; verified: boolean; problems: Problem[] }> {
  const data = JSON.stringify(reportData(s));
  const rough = Object.fromEntries(s.metrics.map((m) => [m.player, !m.reliable])) as Record<Player, boolean>;
  let last: { text: string; problems: Problem[]; submitted: unknown } | null = null;
  let status = "";
  for (let i = 0; i < ATTEMPTS; i++) {
    // a rewrite starts fresh from the refused report and its problems: replaying the first attempt's reasoning costs more than it helps
    const input: ResponseInputItem[] = [{ role: "user", content: data }];
    if (last) input.push({ role: "user", content: `Your report was refused:\n${last.problems.map((p) => `- ${p.subject}: ${p.why}`).join("\n")}\nFix these and call submit_report again. What you submitted: ${JSON.stringify(last.submitted)}` });
    let res: OpenAI.Responses.Response;
    try {
      res = await client.responses.create({
        model: "muse-spark-1.3",
        instructions: instructions(lang),
        input,
        tools: [TOOL],
        parallel_tool_calls: false,
        store: false,
        reasoning: { effort: "medium" },
        max_output_tokens: 16000, // reasoning tokens count here too; 4000 ran out before any text on a full session
      });
    } catch (e) {
      if (last) return { text: last.text, problems: last.problems, verified: false }; // keep the report already paid for
      throw e;
    }
    status = `status ${res.status}${res.incomplete_details ? `, ${res.incomplete_details.reason}` : ""}`;
    const call = res.output.find((o) => o.type === "function_call");
    if (!call) {
      if (res.output_text) last = { text: res.output_text, problems: [{ subject: "report", why: "its numbers were not listed as claims" }], submitted: { markdown: res.output_text } };
      continue;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {}
    const text = String(args.markdown ?? "").trim();
    const problems = text ? verify(text, Array.isArray(args.claims) ? args.claims : [], s.facts, { lang, rough }) : [{ subject: "report", why: "empty report" }];
    if (!problems.length) return { text, verified: true, problems };
    if (text) last = { text, problems, submitted: args };
  }
  if (!last) throw new Error(`Muse Spark returned no report (${status})`);
  return { text: last.text, problems: last.problems, verified: false };
}
