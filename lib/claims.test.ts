// run: node --test lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaim, sentences, verify, type Claim, type Fact, type VerifyOptions } from "./claims.ts";

// the real session's numbers, as the tools show them; B's depth is unreliable
const facts: Fact[] = [
  { player: null, metric: "window_start", value: "3:10", decimals: 0 },
  { player: null, metric: "window_end", value: "14:19", decimals: 0 },
  { player: "A", metric: "distance", value: 567, decimals: 0 },
  { player: "B", metric: "distance", value: 752, decimals: 0 },
  { player: "A", metric: "avg_speed", value: 0.92, decimals: 2 },
  { player: "B", metric: "avg_speed", value: 1.13, decimals: 2 },
  { player: "A", metric: "peak_speed", value: 2.01, decimals: 2 },
  { player: "B", metric: "peak_speed", value: 3.02, decimals: 2 },
  { player: "A", metric: "zone_behind_baseline", value: 67, decimals: 0 },
  { player: "B", metric: "zone_behind_baseline", value: 66, decimals: 0 },
  { player: "B", metric: "lateral_left", value: 40, decimals: 0 },
  { player: "A", metric: "fastest_speed", value: 3.81, decimals: 2, at: "6:44" },
  { player: "A", metric: "fastest_time", value: "6:44", decimals: 0 },
  { player: "A", metric: "minute_distance", value: 52.3, decimals: 1, at: "3:10" },
  { player: "A", metric: "net_visit_count", value: 9, decimals: 0 },
  { player: null, metric: "shown_time", value: "7:30", decimals: 0 },
];
const en: VerifyOptions = { lang: "en", rough: { A: false, B: true } };
const tr: VerifyOptions = { ...en, lang: "tr" };
const c = (player: "A" | "B" | null, metric: Claim["metric"], value: number | string, unit: Claim["unit"], at?: string): Claim => ({ player, metric, value, unit, at });
const why = (text: string, claims: unknown[], o = en) => verify(text, claims, facts, o).map((p) => `${p.subject}: ${p.why}`);
const dA = c("A", "distance", 567, "m");
const dB = c("B", "distance", 752, "m");

test("checkClaim: wrong value, player, unit, time or precision is refused; fewer decimals are fine", () => {
  assert.match(checkClaim(c("B", "distance", 567, "m"), facts)!, /data says 752, not 567/);
  assert.match(checkClaim(c("A", "distance", 567, "m/s"), facts)!, /measured in m, not m\/s/);
  assert.match(checkClaim(c(null, "distance", 567, "m"), facts)!, /which player/);
  assert.match(checkClaim(c("A", "fastest_speed", 3.81, "m/s", "6:59"), facts)!, /no fastest_speed at 6:59/);
  assert.match(checkClaim(c("A", "fastest_time", "6:59", "time"), facts)!, /no fastest_time at 6:59/);
  assert.match(checkClaim(c("A", "peak_speed", "2.010", "m/s"), facts)!, /more decimals/);
  assert.match(checkClaim(c("A", "distance", 570, "m"), facts)!, /data says 567/); // whole numbers are not rounded
  assert.match(checkClaim({ metric: "speed" } as unknown as Claim, facts)!, /unknown metric/);
  assert.equal(checkClaim(c("A", "peak_speed", 2, "m/s"), facts), null);
  assert.equal(checkClaim(c("A", "fastest_speed", "3,8", "m/s", "06:44"), facts), null);
  assert.equal(checkClaim(c("B", "window_start", "3:10", "time"), facts), null); // the window has no player
});

test("verify: grounded answers pass, in English and Turkish formats", () => {
  assert.deepEqual(why("Player A ran 567 m, about 0.9 m/s on average.", [dA, c("A", "avg_speed", 0.9, "m/s")]), []);
  assert.deepEqual(why("Oyuncu A 567 m koştu; ortalama hızı 0,92 m/s, en hızlı anı 6:44'te 3,81 m/s.",
    [dA, c("A", "avg_speed", 0.92, "m/s"), c("A", "fastest_time", "6:44", "time"), c("A", "fastest_speed", 3.81, "m/s", "6:44")], tr), []);
  assert.deepEqual(why("Oyuncu A zamanının %67'sini dip çizginin gerisinde geçirdi.", [c("A", "zone_behind_baseline", 67, "%")], tr), []);
});

test("verify: the text must say what its claims say", () => {
  assert.deepEqual(why("Player B ran 567 m.", [dA]), ["567 m: written after Player B, but it is Player A's distance"]);
  assert.match(why("Player A's peak speed was 0.92 m/s.", [c("A", "avg_speed", 0.92, "m/s")])[0], /words for peak, but the claim is avg_speed/);
  assert.equal(why("Player A's average was 2.01 m/s and the peak 0.92 m/s.", [c("A", "avg_speed", 0.92, "m/s"), c("A", "peak_speed", 2.01, "m/s")]).length, 2);
  assert.deepEqual(why("Player A ran 567 km.", [dA]), ["567 km: distances are in meters"]);
  assert.deepEqual(why("Player A ran 567 m/s.", [dA]), ["567 m/s: written in m/s but the claim is in m"]);
  assert.deepEqual(why("Player B was fastest at 6:44.", [c("A", "fastest_time", "6:44", "time")]), ["6:44: written after Player B, but the claim is Player A's"]);
});

test("verify: numbers without a matching claim are refused, including ones from the question", () => {
  assert.deepEqual(why("Player A ran 567 m in 11 minutes.", [dA]), ["11: not backed by a claim"]);
  assert.deepEqual(why("Yes, Player A ran 900 m.", []), ["900 m: not backed by a claim"]);
  assert.deepEqual(why("Yes, Player A ran 900 m.", [c("A", "distance", 900, "m")]), ["Player A distance=900 m: the data says 567, not 900"]);
  assert.deepEqual(why("Player A peaked at 2.013 m/s.", [c("A", "peak_speed", 2.01, "m/s")]), ["2.013 m/s: not backed by a claim"]);
  assert.deepEqual(why("Player A sprinted hardest at 6:59.", []), ["6:59: this time is not backed by a claim"]);
  // "at" backs a time only for moments, so it cannot smuggle one in on a session total
  assert.deepEqual(why("Player A ran 567 m by 7:00.", [{ ...dA, at: "7:00" }]), ["7:00: this time is not backed by a claim"]);
});

test("verify: rough values need a hedge in the same sentence, in English and Turkish", () => {
  assert.match(why("Player B ran 752 m.", [dB])[0], /rough: say "about"/);
  assert.deepEqual(why("Player B ran about 752 m.", [dB]), []);
  assert.match(why("Oyuncu B 752 m koştu.", [dB], tr)[0], /rough: say "yaklaşık"/);
  assert.deepEqual(why("Oyuncu B yaklaşık 752 m koştu.", [dB], tr), []);
  assert.deepEqual(why("Player B spent 40% on the left.", [c("B", "lateral_left", 40, "%")]), []); // left/right does not rest on depth
});

test("verify: list markers, the 1-s window, model names, minute ranges and shown moments are not data", () => {
  assert.deepEqual(why("1. Player A ran 567 m.\n2. Player A's peak was 2.01 m/s.", [dA, c("A", "peak_speed", 2.01, "m/s")]), []);
  assert.deepEqual(why("Player A's fastest 1-s run was at 6:44 at 3.81 m/s.", [c("A", "fastest_time", "6:44", "time"), c("A", "fastest_speed", 3.81, "m/s", "6:44")]), []);
  assert.deepEqual(why("SAM 3.1 tracked Player A from 3:10 to 14:19.", [c(null, "window_start", "3:10", "time"), c(null, "window_end", "14:19", "time")]), []);
  assert.deepEqual(why("Player A ran 52.3 m in the first minute (3:10–4:10).", [c("A", "minute_distance", 52.3, "m", "3:10")]), []);
  assert.deepEqual(why("At 7:30 Player A is behind the baseline.", [c(null, "shown_time", "7:30", "time")]), []);
});

test("verify: the player carries over to the next sentence, except after 'both players'", () => {
  assert.deepEqual(why("Player A ran 567 m. She peaked at 3.02 m/s.", [dA, c("B", "peak_speed", 3.02, "m/s")]), ["3.02 m/s: written after Player A, but it is Player B's peak_speed"]);
  assert.deepEqual(why("Player B ran about 752 m. Both players stayed behind the baseline most of the time: about 67% and 66%.",
    [dB, c("A", "zone_behind_baseline", 67, "%"), c("B", "zone_behind_baseline", 66, "%")]), []);
  // report sections: the heading names the player
  assert.deepEqual(why("## Player B\n- Ran about 752 m.\n## Player A\n- Ran 567 m.", [dB, dA]), []);
  assert.deepEqual(why("## Player B\n- Ran 567 m.", [dA]), ["567 m: written after Player B, but it is Player A's distance"]);
});

test("verify: malformed claims are reported, not thrown", () => {
  const problems = why("Player A ran 567 m.", [null, "x", 5, { metric: "distance" }]);
  assert.deepEqual(problems, ["distance=undefined undefined: distance is measured in m, not undefined", "567 m: not backed by a claim"]);
});

test("sentences: split on line breaks and sentence ends, not inside decimals", () => {
  assert.deepEqual(sentences("Player A ran 567 m. Peak 2.01 m/s!\n## B"), ["Player A ran 567 m.", "Peak 2.01 m/s!", "## B"]);
});
