// Claim-level grounding for every number Muse Spark gives the coach (assistant answers and the session report).
// The model lists each number it writes as a claim {player, metric, value, unit, at}. verify() checks
//  - each claim against the session's facts (built in coach.ts from the metrics and moments, rounded the way the tools
//    show them): a wrong value, player, metric, unit or time, or more decimals than the data has, is refused;
//  - the text: every number in it must be a claim, in the claim's unit, after the claim's player when the sentence
//    names one, not next to another metric's words, and marked as rough when the player's depth is unreliable.
// Only numbers that are not data (numbered-list markers, the "1-s" window, model names) may appear without a claim.
export type Player = "A" | "B";
export type Unit = "m" | "m/s" | "%" | "s" | "time" | "count";
type Meta = { unit: Unit; depth: boolean; family: string };

// unit, whether the value rests on the depth estimate (rough for an unreliable player), and the words that name it
export const METRICS = {
  distance: { unit: "m", depth: true, family: "distance" },
  avg_speed: { unit: "m/s", depth: true, family: "average" },
  peak_speed: { unit: "m/s", depth: true, family: "peak" },
  tracked_time: { unit: "time", depth: false, family: "tracked" },
  coverage: { unit: "%", depth: false, family: "coverage" },
  depth_noise: { unit: "m", depth: false, family: "noise" },
  zone_behind_baseline: { unit: "%", depth: true, family: "behind" },
  zone_baseline: { unit: "%", depth: true, family: "baseline" },
  zone_mid_court: { unit: "%", depth: true, family: "mid" },
  zone_net: { unit: "%", depth: true, family: "net" },
  // a rough player's zone share as a range (clearly in the zone .. possibly in it); the range itself states the doubt
  zone_behind_baseline_low: { unit: "%", depth: false, family: "behind" },
  zone_behind_baseline_high: { unit: "%", depth: false, family: "behind" },
  zone_baseline_low: { unit: "%", depth: false, family: "baseline" },
  zone_baseline_high: { unit: "%", depth: false, family: "baseline" },
  zone_mid_court_low: { unit: "%", depth: false, family: "mid" },
  zone_mid_court_high: { unit: "%", depth: false, family: "mid" },
  zone_net_low: { unit: "%", depth: false, family: "net" },
  zone_net_high: { unit: "%", depth: false, family: "net" },
  lateral_left: { unit: "%", depth: false, family: "left" },
  lateral_center: { unit: "%", depth: false, family: "center" },
  lateral_right: { unit: "%", depth: false, family: "right" },
  minute_distance: { unit: "m", depth: true, family: "minute" },
  fastest_speed: { unit: "m/s", depth: true, family: "fastest" },
  fastest_time: { unit: "time", depth: false, family: "fastest" },
  run_distance: { unit: "m", depth: true, family: "run" },
  run_duration: { unit: "s", depth: true, family: "run" },
  run_time: { unit: "time", depth: false, family: "run" },
  net_visit_count: { unit: "count", depth: true, family: "net" },
  net_visit_duration: { unit: "s", depth: true, family: "net" },
  net_visit_time: { unit: "time", depth: false, family: "net" },
  side_change_time: { unit: "time", depth: false, family: "side" },
  window_start: { unit: "time", depth: false, family: "window" },
  window_end: { unit: "time", depth: false, family: "window" },
  shown_time: { unit: "time", depth: false, family: "shown" },
} as const satisfies Record<string, Meta>;
export type Metric = keyof typeof METRICS;
export type Claim = { player?: Player | null; metric: Metric; value: number | string; unit: Unit; at?: string };
export type Fact = { player: Player | null; metric: Metric; value: number | string; decimals: number; at?: string };
export type Problem = { subject: string; why: string };
export type VerifyOptions = { lang: "en" | "tr"; rough: Record<Player, boolean> };

const TIMED = new Set<Metric>(["minute_distance", "fastest_speed", "fastest_time", "run_distance", "run_duration", "run_time", "net_visit_duration", "net_visit_time"]);
// no player: the analysed window, and moments the assistant showed or watched
const NO_PLAYER = new Set<Metric>(["window_start", "window_end", "shown_time"]);

// Words naming a metric family, per language. Compared only with numbers of the same unit, nearest word wins.
// Generic verbs ("ran", "koştu") name no family: they fit a total, a minute and a run alike.
const WORDS: Record<"en" | "tr", Record<string, RegExp>> = {
  en: {
    distance: /\b(total|overall|in all)\b/gi, minute: /\bminute\b/gi, run: /\b(runs?|sprints?|bursts?)\b/gi, noise: /\bnoise\b|\bjitter\b/gi,
    average: /\b(averag\w*|avg|mean)\b/gi, peak: /\b(peak\w*|top speed|maximum|max)\b/gi, fastest: /\bfastest\b/gi,
    behind: /\bbehind\b/gi, baseline: /\b(at|on) the baseline\b|\bbaseline zone\b/gi, mid: /\bmid-?court\b|\bmiddle\b/gi, net: /\bnet\b|\bservice box(es)?\b/gi,
    left: /\bleft\b/gi, right: /\bright\b/gi, center: /\bcent(er|re)\b/gi, coverage: /\bcoverage\b/gi,
  },
  tr: {
    distance: /toplam\w*/gi, minute: /dakika\w*|\bdk\b/gi, run: /koşu\w*|\bsprint\w*/gi, noise: /gürültü\w*|titreme\w*/gi,
    average: /ortalama/gi, peak: /tepe|en yüksek|maksimum/gi, fastest: /en hızlı/gi,
    behind: /gerisi\w*|arkası\w*|arkasında|gerisinde/gi, baseline: /dip çizgide|dip çizgi (bölge|üzerin)\w*/gi, mid: /orta saha\w*|orta alan\w*/gi, net: /\bfile\w*|servis kare\w*/gi,
    left: /\bsol(da|a|daki|un)?(?![a-zçğıöşü])/gi, right: /\bsağ(da|a|daki|ın)?(?![a-zçğıöşü])/gi, center: /\bortada\b|merkez\w*/gi, coverage: /kapsam\w*/gi,
  },
};
const FAMILIES_BY_UNIT: Record<Unit, string[]> = {
  m: ["distance", "minute", "run", "noise"], "m/s": ["average", "peak", "fastest"], "%": ["behind", "baseline", "mid", "net", "left", "right", "center", "coverage"],
  s: ["run", "net"], count: ["net"], time: [],
};
const HEDGE = /\b(about|approximately|approx|roughly|rough|around|estimated)\b|~|≈|yaklaşık|kabaca|tahmini|civarında/i;
const PLAYER = /\b(?:Player|Oyuncu)\s+([AB])\b|\b([AB])\s+oyuncusu\b/g;
const BOTH = /\b(both|each)\b|\bplayers\b|iki oyuncu|her iki|ikisi/i; // no single player: the previous sentence's player does not carry over
// not data: product names, the 1-second window the moments are measured over, numbered-list markers
const NOT_DATA = [/\bSAM\s?3(?:\.1)?\b/gi, /\bMuse Spark\s?1\.3\b/gi, /\b1[- ]?(?:s|sec|second|saniye\w*|sn)\b(?=[- ]?(?:run|window|speed|koşu|pencere|hız))/gi, /\b1-second\b/gi, /^\s*\d{1,2}[.)](?=\s|$)/gm];

export const normTime = (t: string) => t.trim().replace(/^0(\d:)/, "$1");
const mmssToSec = (t: string) => {
  const [m, s] = normTime(t).split(":").map(Number);
  return m * 60 + s;
};
const secToMmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// "3,81" -> 3.81 with 2 decimals; "10.688" also reads as 10688 (Turkish/English thousands)
function readings(raw: string): { v: number; d: number }[] {
  const out: { v: number; d: number }[] = [];
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) out.push({ v: +raw.replace(/[.,]/g, ""), d: 0 });
  if (/^\d+([.,]\d+)?$/.test(raw)) out.push({ v: +raw.replace(",", "."), d: raw.split(/[.,]/)[1]?.length ?? 0 });
  return out;
}
function claimNumber(value: unknown): { v: number; d: number } | null {
  const s = String(value ?? "").trim();
  return /^-?\d+([.,]\d+)?$/.test(s) ? { v: +s.replace(",", "."), d: s.split(/[.,]/)[1]?.length ?? 0 } : null;
}
export const describeClaim = (c: Claim) => `${c.player ? `Player ${c.player} ` : ""}${c.metric}=${c.value}${c.unit === "time" || c.unit === "count" ? "" : ` ${c.unit}`}${c.at ? ` at ${c.at}` : ""}`;
const momentStart = (at: string) => normTime(at.split(/[–-]/)[0]);

// A claim against the session's facts: null when it holds, else why not.
export function checkClaim(c: Claim, facts: Fact[]): string | null {
  const meta = (METRICS as Record<string, Meta>)[c.metric];
  if (!meta) return `unknown metric "${c.metric}"`;
  if (c.unit !== meta.unit) return `${c.metric} is measured in ${meta.unit}, not ${c.unit}`;
  const player = NO_PLAYER.has(c.metric) ? null : (c.player ?? null);
  if (!NO_PLAYER.has(c.metric) && !player) return "say which player (A or B)";
  let cands = facts.filter((f) => f.metric === c.metric && f.player === player);
  if (!cands.length) return `the session has no ${c.metric} for ${player ? `Player ${player}` : "the session"}`;
  if (meta.unit === "time") {
    const t = normTime(String(c.value));
    return cands.some((f) => normTime(String(f.value)) === t) ? null : `no ${c.metric} at ${t} for ${player ? `Player ${player}` : "the session"}`;
  }
  if (TIMED.has(c.metric) && c.at) {
    cands = cands.filter((f) => f.at && normTime(f.at) === momentStart(c.at!));
    if (!cands.length) return `no ${c.metric} at ${c.at} for Player ${player}`;
  }
  const n = claimNumber(c.value);
  if (!n) return `value "${c.value}" is not a number`;
  const hit = cands.find((f) => Math.abs(n.v - +f.value) <= 0.5 * 10 ** -n.d + 1e-9);
  if (!hit) return `the data says ${cands.slice(0, 3).map((f) => f.value).join(" / ")}, not ${c.value}`;
  if (n.d > hit.decimals) return `${c.value} has more decimals than the data (${hit.value})`;
  return null;
}

type Token = { raw: string; pos: number; time?: string; values?: { v: number; d: number }[]; unit: Unit | "km" | null };
const UNIT_OF: [RegExp, Unit | "km"][] = [[/^km$/i, "km"], [/^m\/s$/i, "m/s"], [/^(m|meters?|metres?|metre)$/i, "m"], [/^%$/, "%"], [/^(s|sec|seconds?|saniye|sn)$/i, "s"], [/^(times|kez|kere|visits?|ziyaret\w*)$/i, "count"]];

function tokens(sentence: string): Token[] {
  let s = sentence;
  const mask = (re: RegExp) => (s = s.replace(re, (m) => " ".repeat(m.length)));
  NOT_DATA.forEach(mask);
  const out: Token[] = [];
  for (const m of s.matchAll(/\b(\d{1,2}):([0-5]\d)\b/g)) out.push({ raw: m[0], pos: m.index!, time: normTime(m[0]), unit: "time" });
  mask(/\b\d{1,2}:[0-5]\d\b/g);
  const re = /(%\s?)?(\d+(?:[.,]\d+)*)(?:\s?(km\b|m\/s|meters?\b|metres?\b|metre\b|m\b|%|seconds?\b|sec\b|s\b|saniye\b|sn\b|times\b|kez\b|kere\b|visits?\b|ziyaret\w*))?/gi;
  for (const m of s.matchAll(re)) {
    const unitWord = m[1] ? "%" : m[3];
    out.push({ raw: m[0].trim(), pos: m.index!, values: readings(m[2]), unit: unitWord ? (UNIT_OF.find(([r]) => r.test(unitWord))?.[1] ?? null) : null });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

export function sentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+(?=[A-ZÇĞİÖŞÜ0-9"“(*-])/).map((x) => x.trim()).filter(Boolean);
}

// the family word nearest to a number, among the families its unit can have
function nearestFamily(sentence: string, pos: number, unit: Unit, lang: "en" | "tr"): string | null {
  let best: { fam: string; dist: number } | null = null;
  for (const fam of FAMILIES_BY_UNIT[unit]) {
    for (const m of sentence.matchAll(WORDS[lang][fam])) {
      const dist = m.index! < pos ? pos - (m.index! + m[0].length) : m.index! - pos;
      if (dist <= (m.index! < pos ? 60 : 30) && (!best || dist < best.dist)) best = { fam, dist };
    }
  }
  return best?.fam ?? null;
}

export function verify(text: string, raw: unknown[], facts: Fact[], o: VerifyOptions): Problem[] {
  const claims = raw.filter((c): c is Claim => !!c && typeof c === "object").map((c) => ({ ...c, at: typeof c.at === "string" ? c.at : undefined }));
  const problems: Problem[] = [];
  const valid = claims.filter((c) => {
    const why = checkClaim(c, facts);
    if (why) problems.push({ subject: describeClaim(c), why });
    return !why;
  });
  let carry: Player | null = null;
  for (const sentence of sentences(text)) {
    const mentions = [...sentence.matchAll(PLAYER)].map((m) => ({ p: (m[1] ?? m[2]) as Player, pos: m.index! }));
    for (const t of tokens(sentence)) {
      const context = mentions.filter((m) => m.pos < t.pos).at(-1)?.p ?? mentions[0]?.p ?? (BOTH.test(sentence) ? null : carry);
      const p = t.time ? checkTime(t, valid, claims, context) : checkNumber(t, sentence, valid, claims, context, o);
      if (p) problems.push(p);
    }
    if (mentions.length) carry = mentions.at(-1)!.p;
  }
  return problems.filter((p, i) => problems.findIndex((q) => q.subject === p.subject && q.why === p.why) === i);
}

function checkTime(t: Token, valid: Claim[], all: Claim[], context: Player | null): Problem | null {
  // a time is backed by a time claim, or by the start of a timed claim (and the end of its minute)
  const backs = (c: Claim) => {
    if (c.unit === "time") return normTime(String(c.value)) === t.time;
    if (!TIMED.has(c.metric) || !c.at) return false;
    const start = momentStart(c.at);
    return start === t.time || (c.metric === "minute_distance" && secToMmss(mmssToSec(start) + 60) === t.time);
  };
  const cands = valid.filter(backs);
  if (!cands.length) return all.some(backs) ? null : { subject: t.time!, why: "this time is not backed by a claim" };
  if (context && cands.every((c) => c.player && c.player !== context)) return { subject: t.time!, why: `written after Player ${context}, but the claim is Player ${cands[0].player}'s` };
  return null;
}

function checkNumber(t: Token, sentence: string, valid: Claim[], all: Claim[], context: Player | null, o: VerifyOptions): Problem | null {
  if (t.unit === "km") return { subject: t.raw, why: "distances are in meters" };
  const matches = (c: Claim) => {
    const n = claimNumber(c.value);
    return n !== null && c.unit !== "time" && t.values!.some((r) => Math.abs(n.v - r.v) <= 0.5 * 10 ** -r.d + 1e-9);
  };
  const cands = valid.filter(matches);
  if (!cands.length) return all.some(matches) ? null : { subject: t.raw, why: "not backed by a claim" };
  const reasons: string[] = [];
  for (const c of cands) {
    const meta = METRICS[c.metric];
    const fam = nearestFamily(sentence, t.pos, c.unit, o.lang);
    if (t.unit && t.unit !== c.unit) reasons.push(`written in ${t.unit} but the claim is in ${c.unit}`);
    else if (context && c.player && c.player !== context) reasons.push(`written after Player ${context}, but it is Player ${c.player}'s ${c.metric}`);
    else if (fam && fam !== meta.family) reasons.push(`sits next to words for ${fam}, but the claim is ${c.metric}`);
    else if (meta.depth && c.player && o.rough[c.player] && !HEDGE.test(sentence)) reasons.push(`Player ${c.player}'s ${c.metric} is rough: say "${o.lang === "tr" ? "yaklaşık" : "about"}" in that sentence`);
    else return null;
  }
  return { subject: t.raw, why: reasons[0] };
}
