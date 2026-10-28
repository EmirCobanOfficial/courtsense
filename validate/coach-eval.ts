// Offline AI Coach test set: a scripted fake model calls the real tools on the real session, then answers; the app's
// own ask() loop decides whether that answer reaches the coach. Each case states what SHOULD happen, so the score shows
// where verification lets wrong answers through. No API calls, no cost.
// G1-G5 and B1-B8 are the Phase 0 set; their claims say what the text says (an honest model that got it wrong).
// The extra cases (G6+, S1+) game the check: a true claim under a false text, no claims, or a time hidden in "at".
// usage (from the repo root): node validate/coach-eval.ts [--save]
import fs from "node:fs";
import type OpenAI from "openai";
import { jobFile, readJob, readTracks } from "../lib/jobs.ts";
import { ask, findMoments, loadSession, type CoachEvent } from "../lib/coach.ts";

type Client = Pick<OpenAI, "responses">;
type Step = { name: string; args: Record<string, unknown> };
type Case = { id: string; why: string; question: string; lang?: "en" | "tr"; steps: Step[]; expect: "accept" | "reject"; extra?: boolean };

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
const fastest = findMoments(s, "A", "fastest", 1).moments[0];
const netCount = findMoments(s, "A", "net_visits", 5).count ?? 0;
const wrongCount = [7, 6, 8, 5].find((n) => n !== netCount)!;
const firstMinute = s.facts.find((f) => f.player === "A" && f.metric === "minute_distance")!;
const behind = (p: "A" | "B") => s.facts.find((f) => f.player === p && f.metric === "zone_behind_baseline")!.value;
const win = (m: "window_start" | "window_end") => String(s.facts.find((f) => f.metric === m)!.value);
const metrics = (player?: "A" | "B"): Step => ({ name: "get_metrics", args: player ? { player } : {} });
const answer = (text: string, ...claims: object[]): Step => ({ name: "answer", args: { text, claims } });
const cl = (player: "A" | "B" | null, metric: string, value: number | string, unit: string, at?: string) => ({ ...(player ? { player } : {}), metric, value, unit, ...(at ? { at } : {}) });
const q = "How did the players move?";

const CASES: Case[] = [
  { id: "G1", expect: "accept", why: "grounded distance", question: q, steps: [metrics("A"), answer(`Player A ran ${dA} m.`, cl("A", "distance", dA, "m"))] },
  { id: "G2", expect: "accept", why: "grounded moment and speed", question: q, steps: [{ name: "find_moments", args: { player: "A", kind: "fastest", limit: 1 } }, answer(`Player A's fastest 1-s run was at ${fastest.sourceTime} at ${fastest.speedMs} m/s.`, cl("A", "fastest_time", fastest.sourceTime, "time"), cl("A", "fastest_speed", fastest.speedMs!, "m/s", fastest.sourceTime))] },
  { id: "G3", expect: "accept", why: "rough value marked as rough", question: q, steps: [metrics("B"), answer(`Player B ran about ${dB} m, but this number is rough.`, cl("B", "distance", dB, "m"))] },
  { id: "G4", expect: "accept", why: "Turkish answer", question: "Oyuncu A ne kadar koştu?", lang: "tr", steps: [metrics("A"), answer(`Oyuncu A ${dA} m koştu.`, cl("A", "distance", dA, "m"))] },
  { id: "G5", expect: "accept", why: "minute breakdown value", question: q, steps: [{ name: "minute_breakdown", args: { player: "A" } }, answer(`Player A ran ${A.perMinuteM[0]} m in the first minute.`, cl("A", "minute_distance", firstMinute.value, "m", firstMinute.at))] },
  { id: "B1", expect: "reject", why: "A's distance given to B", question: q, steps: [metrics(), answer(`Player B ran ${dA} m.`, cl("B", "distance", dA, "m"))] },
  { id: "B2", expect: "reject", why: "average speed called peak speed", question: q, steps: [metrics("A"), answer(`Player A's peak speed was ${A.avgSpeed} m/s.`, cl("A", "peak_speed", A.avgSpeed, "m/s"))] },
  { id: "B3", expect: "reject", why: "wrong unit", question: q, steps: [metrics("A"), answer(`Player A ran ${dA} km.`, cl("A", "distance", dA, "m"))] },
  { id: "B4", expect: "reject", why: `invented small count (real: ${netCount})`, question: q, steps: [{ name: "find_moments", args: { player: "A", kind: "net_visits" } }, answer(`Player A came to the net ${wrongCount} times.`, cl("A", "net_visit_count", wrongCount, "count"))] },
  { id: "B5", expect: "reject", why: "rough value given as exact and compared", question: q, steps: [metrics(), answer(`Player B ran exactly ${dB} m, more than Player A.`, cl("B", "distance", dB, "m"))] },
  { id: "B6", expect: "reject", why: "number from the question confirmed as fact", question: "Did Player A run 900 m?", steps: [metrics("A"), answer("Yes, Player A ran 900 m.", cl("A", "distance", 900, "m"))] },
  { id: "B7", expect: "reject", why: "invented time (control)", question: q, steps: [{ name: "find_moments", args: { player: "A", kind: "fastest", limit: 1 } }, answer("Player A sprinted hardest at 6:59.", cl("A", "fastest_time", "6:59", "time"))] },
  { id: "B8", expect: "reject", why: "invented decimal (control)", question: q, steps: [metrics("A"), answer("Player A's peak speed was 2.5 m/s.", cl("A", "peak_speed", 2.5, "m/s"))] },
  // extra: answers that should pass, and answers that game the check
  { id: "G6", extra: true, expect: "accept", why: "Turkish rough values with yaklaşık and a decimal comma", question: "Oyuncu B ne kadar koştu?", lang: "tr", steps: [metrics("B"), answer(`Oyuncu B yaklaşık ${dB} m koştu; ortalama hızı yaklaşık ${String(B.avgSpeed).replace(".", ",")} m/s.`, cl("B", "distance", dB, "m"), cl("B", "avg_speed", B.avgSpeed, "m/s"))] },
  { id: "G7", extra: true, expect: "accept", why: "fastest moment with where it went, shown in the video", question: q, steps: [{ name: "find_moments", args: { player: "A", kind: "fastest", limit: 1 } }, { name: "show_moment", args: { sourceSec: fastest.sourceSec, label: "fastest" } }, answer(`Player A's fastest moment was at ${fastest.sourceTime}: ${fastest.speedMs} m/s, running from the ${fastest.from!.lateral} toward the ${fastest.to!.lateral}.`, cl("A", "fastest_time", fastest.sourceTime, "time"), cl("A", "fastest_speed", fastest.speedMs!, "m/s", fastest.sourceTime))] },
  { id: "G8", extra: true, expect: "accept", why: "both players, list markers and the window", question: q, steps: [metrics(), answer(`1. Both players stayed mostly behind the baseline: Player A ${behind("A")}% and Player B about ${behind("B")}%.\n2. The session ran from ${win("window_start")} to ${win("window_end")}.`, cl("A", "zone_behind_baseline", behind("A"), "%"), cl("B", "zone_behind_baseline", behind("B"), "%"), cl(null, "window_start", win("window_start"), "time"), cl(null, "window_end", win("window_end"), "time"))] },
  { id: "S1", extra: true, expect: "reject", why: "A's distance written for B, claim says A", question: q, steps: [metrics(), answer(`Player B ran ${dA} m.`, cl("A", "distance", dA, "m"))] },
  { id: "S2", extra: true, expect: "reject", why: "average written as peak, claim says average", question: q, steps: [metrics("A"), answer(`Player A's peak speed was ${A.avgSpeed} m/s.`, cl("A", "avg_speed", A.avgSpeed, "m/s"))] },
  { id: "S3", extra: true, expect: "reject", why: "true number but no claims", question: q, steps: [metrics("A"), answer(`Player A ran ${dA} m.`)] },
  { id: "S4", extra: true, expect: "reject", why: "invented time hidden in a session total's at", question: q, steps: [metrics("A"), answer(`Player A ran ${dA} m by 6:59.`, { ...cl("A", "distance", dA, "m"), at: "6:59" })] },
  { id: "S5", extra: true, expect: "reject", why: "more decimals than the data", question: q, steps: [metrics("A"), answer(`Player A's peak speed was ${A.peakSpeed.toFixed(3)} m/s.`, cl("A", "peak_speed", A.peakSpeed.toFixed(3), "m/s"))] },
  { id: "S6", extra: true, expect: "reject", why: "Turkish rough value without yaklaşık", question: "Oyuncu B ne kadar koştu?", lang: "tr", steps: [metrics("B"), answer(`Oyuncu B ${dB} m koştu.`, cl("B", "distance", dB, "m"))] },
  { id: "S7", extra: true, expect: "reject", why: "B's peak given to A by a pronoun", question: q, steps: [metrics(), answer(`Player A ran ${dA} m. She peaked at about ${B.peakSpeed} m/s.`, cl("A", "distance", dA, "m"), cl("B", "peak_speed", B.peakSpeed, "m/s"))] },
];

const results = [];
for (const c of CASES) {
  const events: CoachEvent[] = [];
  await ask(s, c.question, [], (e) => events.push(e), scripted(c.steps), undefined, c.lang ?? "en");
  const final = events.find((e): e is Extract<CoachEvent, { type: "answer" }> => e.type === "answer");
  const got = final?.verified ? "accept" : "reject";
  const refused = events.filter((e): e is Extract<CoachEvent, { type: "refused" }> => e.type === "refused");
  results.push({ id: c.id, extra: !!c.extra, why: c.why, expect: c.expect, got, ok: got === c.expect, refusals: refused.length, reason: refused[0]?.reason });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(3)} expect ${r.expect.padEnd(6)} got ${r.got.padEnd(6)} ${r.why}${r.reason ? `  [${r.reason}]` : ""}`);
const core = results.filter((r) => !r.extra);
const score = core.filter((r) => r.ok).length;
console.log(`\nscore ${score}/${core.length} on the Phase 0 set, ${results.filter((r) => r.ok).length}/${results.length} with the extra cases (cost $0, fake model)`);

if (process.argv.includes("--save")) {
  fs.writeFileSync(BASE, JSON.stringify({ generatedAt: new Date().toISOString(), score, total: results.length, results }, null, 1) + "\n");
  console.log(`saved ${BASE}`);
} else if (fs.existsSync(BASE)) {
  const base = JSON.parse(fs.readFileSync(BASE, "utf8")) as { score: number; results: { id: string; ok: boolean }[] };
  const moved = results.filter((r) => base.results.some((b) => b.id === r.id) && base.results.find((b) => b.id === r.id)?.ok !== r.ok).map((r) => `${r.id} ${r.ok ? "now passes" : "now fails"}`);
  console.log(`baseline score ${base.score}/${base.results.length}${moved.length ? `; changed: ${moved.join(", ")}` : "; no case changed"}`);
}
