// A scripted stand-in for Muse Spark, used only when COURTSENSE_FAKE_MODEL is set (model.ts): no network, no cost.
// It writes the way a well-behaved model would, from the data in each request, so the claim check, the verified badges
// and the report rewrite can be seen in the browser. bad: one number for Player A is off, every time, so the answer is
// refused until it ends unverified and the report stays unverified after its rewrite.
import type OpenAI from "openai";

const NOTE = "(Fake model, no API call.)";
type Item = { type?: string; output?: string; content?: unknown };
type View = { player: "A" | "B"; reliable: boolean; distanceM: number; coveragePct: number; zonesPct: { behindBaseline: number } };
type Moment = { sourceTime: string; sourceSec: number; speedMs: number; from: { lateral: string }; to: { lateral: string } };

const call = (name: string, args: object) => ({
  status: "completed",
  output_text: "",
  output: [{ type: "function_call", call_id: `fake-${name}`, name, arguments: JSON.stringify(args) }],
  usage: { input_tokens: 0, output_tokens: 0 },
});

// the coach: find Player A's fastest moment, show it in the video, then answer from that tool result
function coach(input: Item[], bad: boolean) {
  const results = input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output ?? "{}"));
  const moment = results.find((r) => r.kind === "fastest")?.moments?.[0] as Moment | undefined;
  if (!moment) return call("find_moments", { player: "A", kind: "fastest", limit: 1 });
  if (!results.some((r) => r.shown)) return call("show_moment", { sourceSec: moment.sourceSec, label: "Player A's fastest moment" });
  const speed = bad ? +(moment.speedMs + 1).toFixed(2) : moment.speedMs;
  return call("answer", {
    text: `${NOTE} Player A's fastest moment was at ${moment.sourceTime}: about ${speed} m/s, running from the ${moment.from.lateral} toward the ${moment.to.lateral} (from the player's view).`,
    claims: [
      { player: "A", metric: "fastest_time", value: moment.sourceTime, unit: "time" },
      { player: "A", metric: "fastest_speed", value: speed, unit: "m/s", at: moment.sourceTime },
    ],
  });
}

function report(data: { players: View[] }, bad: boolean) {
  const about = (p: View) => (p.reliable ? "" : "about ");
  const distance = (p: View) => (bad && p.player === "A" ? p.distanceM + 10 : p.distanceM);
  const markdown = [
    "## Summary",
    `${NOTE} The scripted fake model wrote this to show the verification badge; it is not an analysis.`,
    ...data.players.flatMap((p) => [
      `## Player ${p.player}`,
      `- Player ${p.player} ran ${about(p)}${distance(p)} m and was tracked for ${p.coveragePct}% of the session.`,
      `- Player ${p.player} spent ${about(p)}${p.zonesPct.behindBaseline}% of the time behind the baseline.`,
    ]),
  ].join("\n");
  const claims = data.players.flatMap((p) => [
    { player: p.player, metric: "distance", value: distance(p), unit: "m" },
    { player: p.player, metric: "coverage", value: p.coveragePct, unit: "%" },
    { player: p.player, metric: "zone_behind_baseline", value: p.zonesPct.behindBaseline, unit: "%" },
  ]);
  return call("submit_report", { markdown, claims });
}

export function fakeModel(bad: boolean): Pick<OpenAI, "responses"> {
  const create = async (body: { tools?: { name?: string }[]; input?: unknown }) => {
    const tools = (body.tools ?? []).map((t) => t.name);
    const input = (Array.isArray(body.input) ? body.input : []) as Item[];
    if (tools.includes("submit_report")) return report(JSON.parse(String(input[0]?.content)), bad);
    if (tools.includes("answer")) return coach(input, bad);
    return { status: "completed", output_text: `${NOTE} No clip was watched.`, output: [], usage: { input_tokens: 0, output_tokens: 0 } }; // look_at_clip
  };
  return { responses: { create } } as unknown as Pick<OpenAI, "responses">;
}

// Muse Image stand-in for the practice card: a plain top-down court with one arrow, no text
const COURT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"><rect width="600" height="400" fill="#2a5caa"/><g fill="none" stroke="#fff" stroke-width="3"><rect x="60" y="80" width="480" height="240"/><path d="M300 80V320M60 120H540M60 280H540M180 120V280M420 120V280M180 200H420"/></g><path d="M110 200H250" stroke="#f0913a" stroke-width="8" marker-end="url(#a)"/><defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#f0913a"/></marker></defs></svg>`;
export const fakeImages = () =>
  ({ images: { generate: async () => ({ data: [{ b64_json: Buffer.from(COURT_SVG).toString("base64") }] }) } }) as unknown as Pick<OpenAI, "images">;
