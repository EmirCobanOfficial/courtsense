// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { applyHomography, CALIBRATION_POINTS, solveHomography, type Pt } from "./court.ts";
import type { Box, Tracks } from "./metrics.ts";
import type { Job } from "./jobs.ts";
import { ask, findMoments, loadSession, type CoachEvent } from "./coach.ts";
import { writeReport } from "./report.ts";
import { fakeModel } from "./fake-model.ts";

const imagePts: Pt[] = [[400, 900], [1500, 900], [1250, 600], [650, 600]];
const toImage = solveHomography(CALIBRATION_POINTS.map((p) => p.world), imagePts);
const fps = 10;
const box = (f: number, w: Pt): Box => {
  const [u, v] = applyHomography(toImage, w);
  return [f, u - 20, v - 100, u + 20, v, 0.9];
};
// A walks 0.5 m/s for 5 s, sprints 3 m/s for 2 s, then stands; B stands on the far side.
const ax = (f: number) => (f < 50 ? -4 + 0.05 * f : f < 70 ? -1.5 + 0.3 * (f - 50) : 4.5);
const objects: Record<string, Box[]> = { a: [], b: [] };
for (let f = 0; f < 100; f++) {
  objects.a.push(box(f, [ax(f), 1]));
  objects.b.push(box(f, [0, 22]));
}
const tracks: Tracks = { fps, width: 1920, height: 1080, frames: 100, objects };
const job = { id: "aaaaaaaaaaaa", name: "t.mp4", startSec: 190, createdAt: "", status: "ready", progress: 1, calibration: imagePts } as Job;
const session = loadSession(job, tracks, "/nonexistent.mp4");

const distA = Math.round(session.metrics[0].distanceM);
const fake = (replies: unknown[]) => {
  const bodies: Record<string, unknown>[] = [];
  const next = () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  const client = { responses: { create: async (body: Record<string, unknown>) => (bodies.push(structuredClone(body)), next()) } } as unknown as OpenAI;
  return { client, bodies };
};

test("findMoments: the sprint is the fastest moment, in source-video time", () => {
  const m = findMoments(session, "A", "fastest", 1).moments[0] as { sourceSec: number; speedMs: number };
  assert.ok(m.sourceSec >= 190 + 4 && m.sourceSec <= 190 + 7, `at ${m.sourceSec}`);
  assert.ok(m.speedMs > 2, `speed ${m.speedMs}`);
  const runs = findMoments(session, "A", "longest_run", 1).moments;
  assert.equal(runs[0].sourceTime, "3:14"); // the 0.5 m/s walk is not a run; the sprint (with smoothing ramp) is
});

test("findMoments: the fastest moment says where the player ran from and to, the zone only when depth is reliable", () => {
  const m = findMoments(session, "A", "fastest", 1).moments[0];
  assert.deepEqual([m.from?.side, m.from?.zone, m.to?.zone, m.to?.lateral], ["near", "baseline", "baseline", "right"]);
  const rough = { ...session, metrics: [session.metrics[0], { ...session.metrics[1], reliable: false }] };
  assert.deepEqual(findMoments(rough, "B", "fastest", 1).moments[0].from, { side: "far", lateral: "center" });
});

test("ask: runs the chosen tool, refuses an invented number, accepts the grounded answer", async () => {
  const call = (name: string, args: object, id: string) => ({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 100, output_tokens: 10 } });
  const replies = [
    { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hemen bakıyorum." }] }], usage: { input_tokens: 50, output_tokens: 5 } },
    call("get_metrics", { player: "A" }, "c1"),
    call("answer", { text: "Oyuncu A 612 m koştu.", claims: [] }, "c2"),
    call("answer", { text: `Oyuncu A ${distA} m koştu.`, claims: [{ player: "A", metric: "distance", value: distA, unit: "m" }] }, "c3"),
  ];
  const { client, bodies } = fake(replies);
  const events: CoachEvent[] = [];
  await ask(session, "A ne kadar koştu?", [], (e) => events.push(e), client);

  assert.deepEqual(events.map((e) => e.type), ["step", "step", "refused", "step", "answer", "done"]);
  assert.equal(bodies[0].parallel_tool_calls, false);
  assert.match(JSON.stringify(bodies[1].input), /Call exactly one tool/); // plain text got the nudge
  assert.match(JSON.stringify(bodies[2].input), /function_call_output.*distanceM/); // the tool result went back
  assert.match(JSON.stringify(bodies[3].input), /612 m: not backed by a claim/); // the model hears why
  assert.deepEqual(events.filter((e) => e.type === "refused").map((e) => e.type === "refused" && e.reason), ["numbers that do not match the data: 612 m"]);
  const answer = events.find((e) => e.type === "answer");
  assert.ok(answer?.type === "answer" && answer.verified);
  const done = events.at(-1);
  assert.ok(done?.type === "done" && done.turns === 4 && done.usage.input === 350);
});

test("ask: three refusals end unverified; bad tool input comes back as an error", async () => {
  const call = (name: string, args: object, id: string) => ({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] });
  const replies = [call("find_moments", { player: "C", kind: "fastest" }, "c0"), ...[1, 2, 3].map((i) => call("answer", { text: `${900 + i} m` }, `c${i}`))];
  const { client, bodies } = fake(replies);
  const events: CoachEvent[] = [];
  await ask(session, "?", [], (e) => events.push(e), client);
  assert.match(JSON.stringify(bodies[1].input), /player must be A or B/);
  assert.equal(events.filter((e) => e.type === "refused").length, 2);
  const answer = events.find((e) => e.type === "answer");
  assert.ok(answer?.type === "answer" && !answer.verified);
});

test("ask: a moment the assistant showed may be named; one it did not show may not", async () => {
  const call = (name: string, args: object, id: string) => ({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] });
  const shown = (t: string) => ({ text: `At ${t} Player A is sprinting.`, claims: [{ metric: "shown_time", value: t, unit: "time" }] });
  const { client } = fake([call("show_moment", { sourceSec: 195, label: "sprint" }, "c1"), call("answer", shown("3:16"), "c2"), call("answer", shown("3:15"), "c3")]);
  const events: CoachEvent[] = [];
  await ask(session, "Show me the sprint.", [], (e) => events.push(e), client);
  assert.deepEqual(events.filter((e) => e.type === "refused" || e.type === "answer").map((e) => e.type === "answer" ? e.verified : e.type), ["refused", true]);
});

test("writeReport: a refused report is rewritten once with the problems, then marked unverified", async () => {
  const submit = (markdown: string, claims: object[]) => ({ status: "completed", output: [{ type: "function_call", call_id: "r", name: "submit_report", arguments: JSON.stringify({ markdown, claims }) }] });
  const good = submit(`## Player A\n- Ran ${distA} m.`, [{ player: "A", metric: "distance", value: distA, unit: "m" }]);
  const bad = submit("## Player A\n- Ran 999 m.", []);
  const ok = fake([bad, good]);
  assert.deepEqual(await writeReport(session, "en", ok.client), { text: `## Player A\n- Ran ${distA} m.`, verified: true, problems: [] });
  assert.match(JSON.stringify(ok.bodies[1].input), /999 m: not backed by a claim/);
  const no = fake([bad, structuredClone(bad)]);
  const r = await writeReport(session, "en", no.client);
  assert.deepEqual([r.verified, r.problems.map((p) => p.subject)], [false, ["999 m"]]);
  // the rewrite starts fresh: the data, then the problems and what was submitted
  assert.equal((no.bodies[1].input as unknown[]).length, 2);
  // a failed rewrite call keeps the first report, unverified
  const failed = await writeReport(session, "en", fake([bad, new Error("budget")]).client);
  assert.deepEqual([failed.text, failed.verified], ["## Player A\n- Ran 999 m.", false]);
});

test("fake model (browser check without API calls): good passes the claim check, bad ends unverified", async () => {
  for (const bad of [false, true]) {
    const events: CoachEvent[] = [];
    await ask(session, "Where did Player A run fastest?", [], (e) => events.push(e), fakeModel(bad));
    const answer = events.find((e) => e.type === "answer");
    assert.ok(answer?.type === "answer" && answer.verified === !bad && answer.text.startsWith("(Fake model"), JSON.stringify(events));
    assert.equal(events.filter((e) => e.type === "refused").length, bad ? 2 : 0);
    assert.ok(events.some((e) => e.type === "seek"));
    assert.equal((await writeReport(session, "en", fakeModel(bad))).verified, !bad);
  }
});
