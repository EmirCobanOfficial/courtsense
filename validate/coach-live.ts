// Live AI Coach check: real Muse Spark calls on the coach's session, under a hard budget. $0.50 is the total for ALL
// live runs: the spend saved by earlier runs (data/validation/coach-live-*.json) is subtracted first, and --cap can
// only lower this run's share. Every request is priced at its worst case before it is sent (see budget.ts) and the run
// stops before the cap could be passed. look_at_clip is refused in this mode: video input cannot be priced in advance.
// No SAM calls. Answers are checked by the app (claims.ts) and audited again offline with simple independent rules.
// usage (from the repo root): node validate/coach-live.ts [--cap 0.15] [--report | --only-report]   (also / only the English report)
import fs from "node:fs";
import OpenAI from "openai";
import { jobFile, readJob, readTracks } from "../lib/jobs.ts";
import { ask, loadSession, type CoachEvent } from "../lib/coach.ts";
import { writeReport } from "../lib/report.ts";
import { budgetClient, BudgetError } from "./budget.ts";

const MAX_TOTAL = 0.5; // the owner's limit for all live checks together
const DIR = "data/validation";
const prior = (fs.existsSync(DIR) ? fs.readdirSync(DIR) : []).filter((f) => /^coach-live-.*\.json$/.test(f))
  .reduce((sum, f) => sum + (JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8")).summary?.spentUsd ?? 0), 0);
const capArg = process.argv.indexOf("--cap");
const CAP = +Math.min(capArg > 0 ? Number(process.argv[capArg + 1]) : Infinity, MAX_TOTAL - prior).toFixed(4);
if (!(CAP > 0)) throw new Error(`no budget left: earlier live runs spent $${prior.toFixed(4)} of $${MAX_TOTAL}`);
console.log(`earlier live runs: $${prior.toFixed(4)}; this run's hard cap: $${CAP} (total stays <= $${MAX_TOTAL})`);

const QUESTIONS: { id: string; text: string; lang: "en" | "tr" }[] = [
  { id: "fastest", text: "Where did Player A run fastest? Show me that moment.", lang: "en" },
  { id: "pace", text: "Did Player A's pace drop over the minutes?", lang: "en" },
  { id: "net", text: "How often did Player A come to the net?", lang: "en" },
  { id: "compare", text: "Who ran more, Player A or Player B?", lang: "en" },
  { id: "shots", text: "How many forehands did Player A hit?", lang: "en" },
  { id: "leading", text: "Player A ran 900 meters, right?", lang: "en" },
  { id: "tr-behind", text: "Oyuncu B zamanının ne kadarını dip çizginin gerisinde geçirdi?", lang: "tr" },
  { id: "net-compare", text: "Compare how much time Player A and Player B spent at the net.", lang: "en" },
];

function apiKey(): string {
  if (process.env.MODEL_API_KEY) return process.env.MODEL_API_KEY;
  const m = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8").match(/^MODEL_API_KEY=(.*)$/m) : null;
  if (!m) throw new Error("MODEL_API_KEY is not set (env or .env.local)");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

const id = "d8650763e4d0";
const job = readJob(id);
const tracks = job && readTracks(job);
if (!job?.calibration || !tracks) throw new Error(`job ${id} has no calibration or tracks on this machine`);
const s = loadSession(job, tracks, jobFile(id, "clip.mp4"));
const rough = Object.fromEntries(s.metrics.map((m) => [m.player, !m.reliable])) as Record<"A" | "B", boolean>;

// --- offline audit of one answer, using the tool results the model saw ---
type Item = { type?: string; name?: string; call_id?: string; output?: string };
function evidenceByPlayer(input: unknown) {
  const ev: Record<"A" | "B", { values: number[]; times: Set<string> }> = { A: { values: [], times: new Set() }, B: { values: [], times: new Set() } };
  const add = (p: string, v: unknown) => {
    if (p !== "A" && p !== "B") return;
    const walk = (x: unknown): void => {
      if (typeof x === "number") ev[p].values.push(x);
      else if (typeof x === "string" && /^\d+:\d\d$/.test(x)) ev[p].times.add(x);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(v);
  };
  for (const it of (Array.isArray(input) ? input : []) as Item[]) {
    if (it.type !== "function_call_output" || !it.output) continue;
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(it.output);
    } catch {
      continue;
    }
    if (Array.isArray(out.players)) for (const p of out.players as Record<string, unknown>[]) add(String(p.player), p);
    else if (typeof out.player === "string") add(out.player, out);
  }
  return ev;
}
function audit(qid: string, text: string, input: unknown): string[] {
  const flags: string[] = [];
  const ev = evidenceByPlayer(input);
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const who = [...new Set([...sentence.matchAll(/\b(?:Player|Oyuncu)\s+([AB])\b/g)].map((m) => m[1] as "A" | "B"))];
    const nums = (sentence.replace(/\d+:\d\d(?:\s*[–-]\s*\d+:\d\d)?/g, " ").match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
    if (who.length === 1 && nums.length) {
      const p = who[0];
      for (const n of nums) {
        const d = n.includes(".") ? n.split(".")[1].length : 0;
        if (!ev[p].values.some((v) => Math.abs(v - +n) <= 0.5 * 10 ** -d + 1e-9)) flags.push(`"${n}" is not in Player ${p}'s tool results: ${sentence.trim()}`);
      }
      if (rough[p] && /\b(m|m\/s|meters?|metre)\b|%/.test(sentence) && !/\b(about|rough|roughly|approx\w*|around|yaklaşık|kabaca)\b|~|≈/i.test(sentence)) flags.push(`rough value for Player ${p} not marked as rough: ${sentence.trim()}`);
    }
  }
  if (qid === "shots" && /\d/.test(text.replace(/\d+:\d\d/g, ""))) flags.push("gave numbers although there is no shot data");
  if (qid === "leading" && /\b900\b/.test(text)) flags.push("repeated the 900 m from the question");
  return flags;
}

// --- run ---
const { client, ledger } = budgetClient(new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: apiKey() }), CAP);
const results: Record<string, unknown>[] = [];
let report: Record<string, unknown> | null = null;
let stopped = "";
fs.mkdirSync(DIR, { recursive: true });
const file = `${DIR}/coach-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
// saved on any exit, so the spend is on record for the next run's cap even if this one fails
process.on("exit", () => {
  const summary = { capUsd: CAP, priorUsd: +prior.toFixed(4), spentUsd: +ledger.spentUsd.toFixed(4), requests: ledger.calls, refusedByBudget: ledger.refused, stopped: stopped || null, questions: results.length };
  fs.writeFileSync(file, JSON.stringify({ summary, ledger: ledger.entries, report, results }, null, 1) + "\n");
  console.log(`\n${JSON.stringify(summary)}\nsaved ${file} (git-ignored)`);
});

const ONLY_REPORT = process.argv.includes("--only-report");
for (const q of ONLY_REPORT ? [] : QUESTIONS) {
  if (stopped) break;
  const before = { usd: ledger.spentUsd, calls: ledger.calls };
  const events: CoachEvent[] = [];
  ledger.lastInput = undefined;
  try {
    await ask(s, q.text, [], (e) => events.push(e), client, undefined, q.lang);
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e;
    stopped = `${q.id}: ${e.message}`;
  }
  const final = events.find((e): e is Extract<CoachEvent, { type: "answer" }> => e.type === "answer");
  results.push({
    id: q.id,
    question: q.text,
    steps: events.filter((e) => e.type === "step").map((e) => (e as Extract<CoachEvent, { type: "step" }>).tool),
    refusals: events.filter((e) => e.type === "refused").map((e) => (e as Extract<CoachEvent, { type: "refused" }>).reason),
    answer: final?.text ?? null,
    verified: final?.verified ?? null,
    flags: final ? audit(q.id, final.text, ledger.lastInput) : ["no answer"],
    requests: ledger.calls - before.calls,
    costUsd: +(ledger.spentUsd - before.usd).toFixed(4),
  });
  const r = results.at(-1)!;
  console.log(`${q.id}: ${r.verified === null ? "no answer" : r.verified ? "verified" : "NOT verified"}, ${r.requests} requests, $${r.costUsd}, flags ${(r.flags as string[]).length}`);
}

// last: questions first keeps the comparison with Phase 0 when the cap runs out
if ((process.argv.includes("--report") || ONLY_REPORT) && !stopped) {
  const before = { usd: ledger.spentUsd, calls: ledger.calls };
  try {
    const r = await writeReport(s, "en", client);
    report = { ...r };
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e;
    stopped = `report: ${e.message}`;
  }
  report = { ...report, requests: ledger.calls - before.calls, costUsd: +(ledger.spentUsd - before.usd).toFixed(4) };
  console.log(`report: ${report.verified === undefined ? "none" : report.verified ? "verified" : "NOT verified"}, ${report.requests} requests, $${report.costUsd}`);
}
