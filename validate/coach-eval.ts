// Offline AI Coach test set: a scripted fake model calls the real tools on the real session, then answers; the app's
// own ask() loop decides whether that answer reaches the coach. Each case states what SHOULD happen, so the score shows
// where verification lets wrong answers through. No API calls, no cost.
// usage (from the repo root): node validate/coach-eval.ts [--save]
import fs from "node:fs";
import type OpenAI from "openai";
import { jobFile, readJob, readTracks } from "../lib/jobs.ts";
import { ask, findMoments, loadSession, type CoachEvent } from "../lib/coach.ts";

type Client = Pick<OpenAI, "responses">;
type Step = { name: string; args: Record<string, unknown> };
type Case = { id: string; why: string; question: string; lang?: "en" | "tr"; steps: Step[]; expect: "accept" | "reject" };

const BASE = "validate/baseline/coach-eval.json";
const id = "d8650763e4d0";
const job = readJob(id);
const tracks = job && readTracks(job);
if (!job?.calibration || !tracks) throw new Error(`job ${id} has no calibration or tracks on this machine`);
const s = loadSession(job, tracks, jobFile(id, "clip.mp4"));

// A model that follows a script: one tool call per turn, repeating its last step (the answer) when refused.
function scripted(steps: Step[]): Client {
  let i = 0;
  const create = async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return { output: [{ type: "function_call", name: step.name, arguments: JSON.stringify(step.args), call_id: `c${i}` }], usage: { input_tokens: 0, output_tokens: 0 } };
  };
  return { responses: { create } } as unknown as Client;
}

const [A, B] = s.metrics;
const dA = Math.round(A.distanceM), dB = Math.round(B.distanceM);
const fastest = findMoments(s, "A", "fastest", 1).moments[0] as { sourceTime: string; speedMs: number };
const netCount = (findMoments(s, "A", "net_visits", 5) as { count?: number }).count ?? 0;
const wrongCount = [7, 6, 8, 5].find((n) => n !== netCount)!;
const metrics = (player?: "A" | "B"): Step => ({ name: "get_metrics", args: player ? { player } : {} });
const answer = (text: string): Step => ({ name: "answer", args: { text } });
const q = "How did the players move?";

const CASES: Case[] = [
  { id: "G1", expect: "accept", why: "grounded distance", question: q, steps: [metrics("A"), answer(`Player A ran ${dA} m.`)] },
  { id: "G2", expect: "accept", why: "grounded moment and speed", question: q, steps: [{ name: "find_moments", args: { player: "A", kind: "fastest", limit: 1 } }, answer(`Player A's fastest 1-s run was at ${fastest.sourceTime} at ${fastest.speedMs} m/s.`)] },
  { id: "G3", expect: "accept", why: "rough value marked as rough", question: q, steps: [metrics("B"), answer(`Player B ran about ${dB} m, but this number is rough.`)] },
  { id: "G4", expect: "accept", why: "Turkish answer", question: "Oyuncu A ne kadar koştu?", lang: "tr", steps: [metrics("A"), answer(`Oyuncu A ${dA} m koştu.`)] },
  { id: "G5", expect: "accept", why: "minute breakdown value", question: q, steps: [{ name: "minute_breakdown", args: { player: "A" } }, answer(`Player A ran ${A.perMinuteM[0]} m in the first minute.`)] },
  { id: "B1", expect: "reject", why: "A's distance given to B", question: q, steps: [metrics(), answer(`Player B ran ${dA} m.`)] },
  { id: "B2", expect: "reject", why: "average speed called peak speed", question: q, steps: [metrics("A"), answer(`Player A's peak speed was ${A.avgSpeed} m/s.`)] },
  { id: "B3", expect: "reject", why: "wrong unit", question: q, steps: [metrics("A"), answer(`Player A ran ${dA} km.`)] },
  { id: "B4", expect: "reject", why: `invented small count (real: ${netCount})`, question: q, steps: [{ name: "find_moments", args: { player: "A", kind: "net_visits" } }, answer(`Player A came to the net ${wrongCount} times.`)] },
  { id: "B5", expect: "reject", why: "rough value given as exact and compared", question: q, steps: [metrics(), answer(`Player B ran exactly ${dB} m, more than Player A.`)] },
  { id: "B6", expect: "reject", why: "number from the question confirmed as fact", question: "Did Player A run 900 m?", steps: [metrics("A"), answer("Yes, Player A ran 900 m.")] },
  { id: "B7", expect: "reject", why: "invented time (control)", question: q, steps: [{ name: "find_moments", args: { player: "A", kind: "fastest", limit: 1 } }, answer("Player A sprinted hardest at 6:59.")] },
  { id: "B8", expect: "reject", why: "invented decimal (control)", question: q, steps: [metrics("A"), answer("Player A's peak speed was 2.5 m/s.")] },
];

const results = [];
for (const c of CASES) {
  const events: CoachEvent[] = [];
  await ask(s, c.question, [], (e) => events.push(e), scripted(c.steps), undefined, c.lang ?? "en");
  const final = events.find((e): e is Extract<CoachEvent, { type: "answer" }> => e.type === "answer");
  const got = final?.verified ? "accept" : "reject";
  results.push({ id: c.id, why: c.why, expect: c.expect, got, ok: got === c.expect, refusals: events.filter((e) => e.type === "refused").length });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}  expect ${r.expect.padEnd(6)} got ${r.got.padEnd(6)} ${r.why}`);
const score = results.filter((r) => r.ok).length;
console.log(`\nscore ${score}/${results.length} (cost $0, fake model)`);

if (process.argv.includes("--save")) {
  fs.writeFileSync(BASE, JSON.stringify({ generatedAt: new Date().toISOString(), score, total: results.length, results }, null, 1) + "\n");
  console.log(`saved ${BASE}`);
} else if (fs.existsSync(BASE)) {
  const base = JSON.parse(fs.readFileSync(BASE, "utf8")) as { score: number; results: { id: string; ok: boolean }[] };
  const moved = results.filter((r) => base.results.find((b) => b.id === r.id)?.ok !== r.ok).map((r) => `${r.id} ${r.ok ? "now passes" : "now fails"}`);
  console.log(`baseline score ${base.score}/${base.results.length}${moved.length ? `; changed: ${moved.join(", ")}` : "; no case changed"}`);
}
