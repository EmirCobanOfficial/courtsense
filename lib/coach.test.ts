// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type OpenAI from "openai";
import { applyHomography, CALIBRATION_POINTS, solveHomography, type Pt } from "./court.ts";
import type { Box, Tracks } from "./metrics.ts";
import type { Job } from "./jobs.ts";
import { ask, findMoments, loadSession, ungrounded, type CoachEvent } from "./coach.ts";

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

test("ungrounded: Turkish formats grounded in tool results pass, invented numbers do not", () => {
  const evidence = JSON.stringify({ distanceM: 578, avgSpeedMs: 0.93, peakSpeedMs: 2.05, zonesPct: { behindBaseline: 68 }, frames: 10688, sourceTime: "6:46" });
  assert.deepEqual(ungrounded("Oyuncu A 578 m koştu, ortalama 0,93 m/s, tepe 2,1 m/s; sürenin %68'i dip çizgi arkasında. En hızlı an 6:46. 10.688 kare, 3 an.", evidence), []);
  assert.deepEqual(ungrounded("612 m koştu, 7:05'te 0,97 m/s.", evidence), ["7:05", "612", "0,97"]);
});

test("findMoments: the sprint is the fastest moment, in source-video time", () => {
  const m = findMoments(session, "A", "fastest", 1).moments[0] as { sourceSec: number; speedMs: number };
  assert.ok(m.sourceSec >= 190 + 4 && m.sourceSec <= 190 + 7, `at ${m.sourceSec}`);
  assert.ok(m.speedMs > 2, `speed ${m.speedMs}`);
  const runs = findMoments(session, "A", "longest_run", 1).moments;
  assert.equal(runs[0].sourceTime, "3:14"); // the 0.5 m/s walk is not a run; the sprint (with smoothing ramp) is
});

test("ask: runs the chosen tool, refuses an invented number, accepts the grounded answer", async () => {
  const call = (name: string, args: object, id: string) => ({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 100, output_tokens: 10 } });
  const replies = [
    { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hemen bakıyorum." }] }], usage: { input_tokens: 50, output_tokens: 5 } },
    call("get_metrics", { player: "A" }, "c1"),
    call("answer", { text: "Oyuncu A 612 m koştu." }, "c2"),
    call("answer", { text: `Oyuncu A ${Math.round(session.metrics[0].distanceM)} m koştu.` }, "c3"),
  ];
  const bodies: Record<string, unknown>[] = [];
  const client = { responses: { create: async (body: Record<string, unknown>) => (bodies.push(structuredClone(body)), replies.shift()) } } as unknown as OpenAI;
  const events: CoachEvent[] = [];
  await ask(session, "A ne kadar koştu?", [], (e) => events.push(e), client);

  assert.deepEqual(events.map((e) => e.type), ["step", "step", "refused", "step", "answer", "done"]);
  assert.equal(bodies[0].parallel_tool_calls, false);
  assert.match(JSON.stringify(bodies[1].input), /Call exactly one tool/); // plain text got the nudge
  assert.match(JSON.stringify(bodies[2].input), /function_call_output.*distanceM/); // the tool result went back
  const answer = events.find((e) => e.type === "answer");
  assert.ok(answer?.type === "answer" && answer.verified);
  const done = events.at(-1);
  assert.ok(done?.type === "done" && done.turns === 4 && done.usage.input === 350);
});

test("ask: three refusals end unverified; bad tool input comes back as an error", async () => {
  const call = (name: string, args: object, id: string) => ({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }] });
  const replies = [call("find_moments", { player: "C", kind: "fastest" }, "c0"), ...[1, 2, 3].map((i) => call("answer", { text: `${900 + i} m` }, `c${i}`))];
  const bodies: Record<string, unknown>[] = [];
  const client = { responses: { create: async (body: Record<string, unknown>) => (bodies.push(structuredClone(body)), replies.shift()) } } as unknown as OpenAI;
  const events: CoachEvent[] = [];
  await ask(session, "?", [], (e) => events.push(e), client);
  assert.match(JSON.stringify(bodies[1].input), /player must be A or B/);
  assert.equal(events.filter((e) => e.type === "refused").length, 2);
  const answer = events.find((e) => e.type === "answer");
  assert.ok(answer?.type === "answer" && !answer.verified);
});
