"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Heatmap } from "@/app/components/Heatmap.tsx";
import { MaskVideo } from "@/app/components/MaskVideo.tsx";
import { CoachChat } from "@/app/components/CoachChat.tsx";
import { applyHomography, CALIBRATION_POINTS, COURT_LINES, solveHomography, type Pt } from "@/lib/court.ts";
import { LangContext, useT, type Key, type Lang } from "@/lib/i18n.ts";
import type { Job } from "@/lib/jobs.ts";
import type { PlayerMetrics } from "@/lib/metrics.ts";
import { ECONOMY_FPS, samCost, STANDARD_FPS } from "@/lib/cost.ts";

// The saved language; the server render (and a blocked localStorage) gets English.
const savedLang = (): Lang => {
  try {
    return localStorage.getItem("lang") === "tr" ? "tr" : "en";
  } catch {
    return "en";
  }
};
const onStorage = (cb: () => void) => (window.addEventListener("storage", cb), () => window.removeEventListener("storage", cb));

export default function Home() {
  const [picked, setPicked] = useState<Lang>();
  const saved = useSyncExternalStore(onStorage, savedLang, () => "en" as Lang);
  const lang = picked ?? saved;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const refreshJobs = useCallback(() => fetch("/api/jobs").then((r) => r.json()).then(setJobs), []);
  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const choose = (l: Lang) => {
    setPicked(l);
    try {
      localStorage.setItem("lang", l);
    } catch {}
  };

  return (
    <LangContext.Provider value={lang}>
      <main className="mx-auto w-full max-w-5xl px-4 py-8 space-y-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">CourtSense</h1>
            <Tagline />
          </div>
          <div className="flex overflow-hidden rounded border border-black/20 text-xs dark:border-white/25" role="group" aria-label="Language / Dil">
            {(["en", "tr"] as const).map((l) => (
              <button key={l} onClick={() => choose(l)} aria-pressed={lang === l} className={`px-2 py-1 ${lang === l ? "bg-foreground text-background" : ""}`}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </header>
        <Upload onCreated={(id) => (refreshJobs(), setSelected(id))} />
        {jobs.length > 0 && <JobList jobs={jobs} selected={selected} onSelect={setSelected} />}
        {selected && <JobView key={selected} id={selected} onStatus={refreshJobs} />}
      </main>
    </LangContext.Provider>
  );
}

function Tagline() {
  const { t } = useT();
  return <p className="text-sm opacity-70">{t("tagline")}</p>;
}

function JobList({ jobs, selected, onSelect }: { jobs: Job[]; selected: string | null; onSelect: (id: string) => void }) {
  const { t } = useT();
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{t("videos")}</h2>
      <ul className="flex flex-wrap gap-2">
        {jobs.map((j) => (
          <li key={j.id}>
            <button
              onClick={() => onSelect(j.id)}
              className={`rounded border px-3 py-1 text-sm ${selected === j.id ? "border-current" : "border-black/15 dark:border-white/20"}`}
            >
              {j.name} · {range(j, t("rangeEnd"))}{j.fps === ECONOMY_FPS ? ` · ${t("economyTag")}` : ""} · {t(`status_${j.status}`)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Economy (7.5 fps) stays in the code and the API but is not offered here: in one of two real runs SAM lost the far
// player for the last 2 minutes (README, "Fewer frames"). Add [ECONOMY_FPS, "modeEconomy"] to offer it again.
const UPLOAD_MODES = [[STANDARD_FPS, "modeStandard"]] as const;

function Upload({ onCreated }: { onCreated: (id: string) => void }) {
  const { t, usd, lang } = useT();
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [fps, setFps] = useState(STANDARD_FPS);
  const [start, setStart] = useState("3:10");
  const [end, setEnd] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState("");

  // the video's length, read in the browser, for the cost estimate (unknown if the browser cannot open the file)
  function pick(f: File | null) {
    setFile(f);
    setDuration(null);
    if (!f) return;
    const v = document.createElement("video");
    const url = URL.createObjectURL(f);
    v.preload = "metadata";
    v.onloadedmetadata = () => (setDuration(Number.isFinite(v.duration) ? v.duration : null), URL.revokeObjectURL(url));
    v.onerror = () => URL.revokeObjectURL(url);
    v.src = url;
  }
  const startSec = parseTime(start), endSec = end.trim() ? parseTime(end) : undefined;
  const seconds = startSec === null || endSec === null ? NaN : Math.min(endSec ?? Infinity, duration ?? Infinity) - startSec;
  const est = Number.isFinite(seconds) && seconds > 0 ? samCost(seconds, fps) : null;

  async function submit() {
    if (!file || startSec === null || endSec === null) return setErr(t("badInput"));
    setErr("");
    const res = await fetch("/api/jobs", { method: "POST", body: JSON.stringify({ name: file.name, size: file.size, startSec, endSec, fps }) });
    const { job, needsUpload, error } = await res.json();
    if (!res.ok) return setErr(error);
    if (needsUpload) {
      // XHR instead of fetch: fetch has no upload progress events
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `/api/jobs/${job.id}/upload`);
        xhr.upload.onprogress = (e) => setPct(e.loaded / e.total);
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText)));
        xhr.onerror = () => reject(new Error(t("uploadFailed")));
        xhr.send(file);
      }).catch((e) => setErr(e.message));
      setPct(null);
    }
    onCreated(job.id);
  }

  return (
    <section className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
      <h2 className="font-medium">{t("newVideo")}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          {t("video")}
          <input type="file" accept="video/*" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="block text-sm" />
        </label>
        <label className="text-sm">
          {t("start")}
          <input value={start} onChange={(e) => setStart(e.target.value)} className="block w-24 rounded border border-black/20 px-2 py-1 dark:border-white/25 bg-transparent" />
        </label>
        <label className="text-sm">
          {t("end")}
          <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder={t("toEnd")} className="block w-28 rounded border border-black/20 px-2 py-1 dark:border-white/25 bg-transparent" />
        </label>
        <button onClick={submit} disabled={pct !== null} className="rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-50">
          {t("upload")}
        </button>
      </div>
      <fieldset className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <legend className="mb-1">{t("mode")}</legend>
        {UPLOAD_MODES.map(([f, k]) => (
          <label key={f} className="flex items-center gap-2">
            <input type="radio" name="mode" checked={fps === f} onChange={() => setFps(f)} />
            {t(k)}
          </label>
        ))}
      </fieldset>
      <p className="text-sm">
        {est
          ? t("costEstimate", { usd: usd(est.usd), frames: est.frames.toLocaleString(lang), fps: fps.toLocaleString(lang) })
          : t("costPerMinute", { usd: usd(samCost(60, fps).usd), fps: fps.toLocaleString(lang) })}
      </p>
      {fps === ECONOMY_FPS && <p className="text-xs opacity-70">{t("economyNote")}</p>}
      {pct !== null && <Bar value={pct} label={t("uploading", { p: Math.round(pct * 100) })} />}
      {err && <p className="text-sm text-red-600">{err}</p>}
    </section>
  );
}

function JobView({ id, onStatus }: { id: string; onStatus: () => void }) {
  const { t, pct, lang } = useT();
  const [job, setJob] = useState<Job | null>(null);
  const [metrics, setMetrics] = useState<PlayerMetrics[] | null>(null);
  const [report, setReport] = useState<ReportState | null>(null);
  const [jump, setJump] = useState<{ sourceSec: number; n: number }>();
  const status = useRef<Job["status"]>(undefined);
  const load = useCallback(
    () =>
      fetch(`/api/jobs/${id}?lang=${lang}`)
        .then((r) => r.json())
        .then((d) => {
          setJob(d.job);
          setMetrics(d.metrics);
          setReport(d.report ? { text: d.report, verified: d.reportVerified } : null);
          // the video list above shows each job's status too
          if (status.current && status.current !== d.job.status) onStatus();
          status.current = d.job.status;
        }),
    [id, lang, onStatus],
  );
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (job?.status === "ready" || job?.status === "error") return;
      load();
    }, 2000);
    return () => clearInterval(timer);
  }, [load, job?.status]);

  if (!job) return null;
  const hasFrame = job.status === "segmenting" || job.status === "ready" || (job.status === "error" && job.frames);
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h2 className="font-medium">
          {job.name} <span className="opacity-60">· {range(job, t("rangeEnd"))}{job.fps === ECONOMY_FPS ? ` · ${t("economyTag")}` : ""}</span>
        </h2>
        {job.status !== "ready" && job.status !== "error" && <Bar value={job.progress} label={`${t(`status_${job.status}`)} ${pct(job.progress)}`} />}
        {job.status === "error" && (
          <p className="text-sm text-red-600">
            {job.error}{" "}
            <button onClick={() => fetch(`/api/jobs/${id}`, { method: "POST" }).then(load)} className="underline">
              {t("retry")}
            </button>
          </p>
        )}
        {job.truncated && <p className="text-sm opacity-70">{t("truncated")}</p>}
      </div>
      {hasFrame && job.width && job.height && <Calibration job={job} onSaved={(m) => (load(), setMetrics(m))} />}
      {metrics && <MaskVideo job={job} metrics={metrics} jumpTo={jump} />}
      {metrics && <CoachChat job={job} onSeek={(sourceSec) => setJump((j) => ({ sourceSec, n: (j?.n ?? 0) + 1 }))} />}
      {metrics && <MetricsTable metrics={metrics} startSec={job.startSec} />}
      {metrics && job.fps === ECONOMY_FPS && <p className="-mt-4 text-xs opacity-60">{t("economyNote")}</p>}
      {metrics && <Heatmap metrics={metrics} />}
      {metrics && <Report id={id} report={report} onReport={setReport} />}
      {metrics && <PracticeCard id={id} metrics={metrics} />}
    </section>
  );
}

type ReportState = { text: string; verified: boolean | null }; // null: written before the claim check

function Report({ id, report, onReport }: { id: string; report: ReportState | null; onReport: (r: ReportState) => void }) {
  const { t, lang } = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function generate() {
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/jobs/${id}/report`, { method: "POST", body: JSON.stringify({ lang }) });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(d.error);
    onReport({ text: d.report, verified: d.verified });
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="font-medium">{t("report")}</h3>
        <button onClick={generate} disabled={busy} className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50">
          {busy ? t("writing") : report ? t("regenerate") : t("generate")}
        </button>
        {report && report.verified !== null && (
          <span className={`text-sm ${report.verified ? "text-green-700 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>{t(report.verified ? "verified" : "unverified")}</span>
        )}
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {report && (
        <div className="space-y-2 rounded-lg border border-black/10 p-4 text-sm leading-6 dark:border-white/15">
          {report.text.split("\n").map((line, i) =>
            line.startsWith("## ") ? (
              <h4 key={i} className="pt-2 font-medium">
                {inline(line.slice(3))}
              </h4>
            ) : /^[-*] /.test(line) ? (
              <p key={i} className="pl-4 -indent-3">
                • {inline(line.slice(2))}
              </p>
            ) : line.trim() ? (
              <p key={i}>{inline(line)}</p>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

const ZONE_KEY = { behindBaseline: "z_behind", baseline: "z_baseline", midCourt: "z_mid", net: "z_net" } as const;
const SIDE_KEY = { left: "s_left", center: "s_center", right: "s_right" } as const;
const most = <K extends string>(shares: Record<K, number>) => (Object.entries(shares) as [K, number][]).sort((a, b) => b[1] - a[1])[0];

// Muse Image draws the coach's goal as a drill. The picture holds no numbers; the caption's come from the metrics.
function PracticeCard({ id, metrics }: { id: string; metrics: PlayerMetrics[] }) {
  const { t, pct } = useT();
  const [p, setP] = useState<0 | 1>(0);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [card, setCard] = useState<{ image: string; goal: string; m: PlayerMetrics } | null>(null);
  async function draw(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await fetch(`/api/jobs/${id}/card`, { method: "POST", body: JSON.stringify({ player: p ? "B" : "A", goal }) });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(d.error);
    setCard({ image: d.image, goal: goal.trim(), m: metrics[p] });
  }
  const facts = (m: PlayerMetrics) => {
    const [zone, zoneShare] = most(m.zones), [side, sideShare] = most(m.lateral);
    const where = `${m.reliable ? `${pct(zoneShare)} ${t(ZONE_KEY[zone])}, ` : ""}${pct(sideShare)} ${t(SIDE_KEY[side])}`;
    return `${t("player", { p: m.player })} · ${t("cardLast")}: ${where}${m.reliable ? "" : ` (${t("cardRough")})`}`;
  };
  return (
    <div className="space-y-3">
      <h3 className="font-medium">
        {t("card")} <span className="text-sm font-normal opacity-60">· {t("cardSub")}</span>
      </h3>
      <form onSubmit={draw} className="flex flex-wrap gap-2">
        <select value={p} onChange={(e) => setP(e.target.value === "1" ? 1 : 0)} aria-label={t("cardPlayerAria")} className="rounded border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/25">
          <option value="0">{t("player", { p: "A" })}</option>
          <option value="1">{t("player", { p: "B" })}</option>
        </select>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200} placeholder={t("cardGoal")} aria-label={t("cardGoalAria")}
          className="min-w-0 flex-1 rounded border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/25" />
        <button disabled={busy || !goal.trim()} className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50">
          {busy ? t("cardBusy") : t("cardDraw")}
        </button>
      </form>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {card && (
        <figure className="max-w-2xl space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from Muse Image, nothing to optimize */}
          <img src={card.image} alt={t("cardAlt", { goal: card.goal })} className="w-full rounded-lg border border-black/10 dark:border-white/15" />
          <figcaption className="space-y-1 text-sm">
            <p>{facts(card.m)}</p>
            <p>{card.goal}</p>
            <p className="opacity-60">{t("cardNote")}</p>
          </figcaption>
        </figure>
      )}
    </div>
  );
}

// Minimal Markdown: **bold** only; the report format is fixed by the prompt.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => (part.startsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : part));
}

function Calibration({ job, onSaved }: { job: Job; onSaved: (m: PlayerMetrics[] | null) => void }) {
  const { t } = useT();
  const [pts, setPts] = useState<Pt[]>(job.calibration ?? []);
  const [err, setErr] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const W = job.width!;
  const H = job.height!;

  let lines: [Pt, Pt][] = [];
  if (pts.length === 4) {
    try {
      const toImage = solveHomography(CALIBRATION_POINTS.map((p) => p.world), pts);
      lines = COURT_LINES.map(([a, b]) => [applyHomography(toImage, a), applyHomography(toImage, b)]);
    } catch {}
  }

  function click(e: React.MouseEvent<HTMLImageElement>) {
    if (pts.length >= 4) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPts([...pts, [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)]]);
  }

  async function save() {
    const res = await fetch(`/api/jobs/${job.id}/calibration`, { method: "POST", body: JSON.stringify({ points: pts }) });
    const d = await res.json();
    if (!res.ok) return setErr(d.error);
    setErr("");
    onSaved(d.metrics);
  }

  return (
    <div className="space-y-2">
      <h3 className="font-medium">{t("calibration")}</h3>
      <p className="text-sm">
        {pts.length < 4 ? (
          <>
            {t("clickPoint", { n: pts.length + 1 })}
            <b>{t(`cal_${pts.length}` as Key)}</b>
          </>
        ) : (
          t("calDone")
        )}
      </p>
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element -- raw frame from the API, needs exact pixel mapping */}
        <img ref={imgRef} src={`/api/jobs/${job.id}/frame`} alt={t("calAlt")} onClick={click} className="w-full cursor-crosshair select-none rounded" />
        <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 h-full w-full">
          {lines.map(([a, b], i) => (
            <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#22c55e" strokeWidth={3} />
          ))}
          {pts.map(([x, y], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r={10} fill="none" stroke="#f43f5e" strokeWidth={4} />
              <text x={x + 14} y={y - 14} fill="#f43f5e" fontSize={32} fontWeight={700}>
                {i + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setPts([])} className="rounded border border-black/20 px-3 py-1 text-sm dark:border-white/25">
          {t("reset")}
        </button>
        <button onClick={save} disabled={pts.length !== 4} className="rounded bg-foreground px-3 py-1 text-sm text-background disabled:opacity-50">
          {t("save")}
        </button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
    </div>
  );
}

function MetricsTable({ metrics, startSec }: { metrics: PlayerMetrics[]; startSec: number }) {
  const { t, pct } = useT();
  // a rough player's zone share comes with its range: clearly in the zone .. possibly in it
  const zone = (k: keyof PlayerMetrics["zones"]) => (m: PlayerMetrics) =>
    `${pct(m.zones[k])}${m.reliable ? "" : ` (${pct(m.zoneRanges[k][0])}–${pct(m.zoneRanges[k][1])})`}`;
  // third item: the value depends on depth, so it is shown as rough when the player's depth is noisy
  const rows: [Key, (m: PlayerMetrics) => string, boolean?][] = [
    ["m_confidence", (m) => `${t(m.reliable ? "m_good" : "m_low")} (±${m.depthNoiseM.toFixed(2)} m)`],
    ["m_tracked", (m) => `${fmtTime(m.seconds)} (${pct(m.coverage)})`],
    ["m_distance", (m) => `${Math.round(m.distanceM)} m`, true],
    ["m_avg", (m) => `${m.avgSpeed.toFixed(2)} m/s`, true],
    ["m_peak", (m) => `${m.peakSpeed.toFixed(2)} m/s`, true],
    ["m_behind", zone("behindBaseline"), true],
    ["m_baseline", zone("baseline"), true],
    ["m_mid", zone("midCourt"), true],
    ["m_net", zone("net"), true],
    ["m_lateral", (m) => `${pct(m.lateral.left)} / ${pct(m.lateral.center)} / ${pct(m.lateral.right)}`],
    ["m_sides", (m) => (m.sideChangesAt.length ? m.sideChangesAt.map((s) => fmtTime(startSec + s)).join(", ") : "—")],
  ];
  return (
    <div className="space-y-2">
      <h3 className="font-medium">{t("metrics")}</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left opacity-70">
            <th className="py-1 font-normal"></th>
            <th className="py-1 font-normal">{t("playerA")}</th>
            <th className="py-1 font-normal">{t("playerB")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, f, depth]) => (
            <tr key={key} className="border-t border-black/10 dark:border-white/10">
              <td className="py-1 opacity-70">{t(key)}</td>
              {metrics.map((m) => (
                <td key={m.player} className={`py-1 tabular-nums ${depth && !m.reliable ? "opacity-45" : ""}`}>
                  {depth && !m.reliable ? `~${f(m)}` : f(m)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {metrics.some((m) => !m.reliable) && <p className="text-xs opacity-60">{t("roughNote")}</p>}
    </div>
  );
}

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="space-y-1">
      <div className="h-2 w-full overflow-hidden rounded bg-black/10 dark:bg-white/15">
        <div className="h-full bg-foreground transition-all" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <p className="text-xs opacity-70">{label}</p>
    </div>
  );
}

const range = (j: Job, end: string) => `${fmtTime(j.startSec)}–${j.endSec ? fmtTime(j.endSec) : end}`;
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function parseTime(t: string): number | null {
  const m = /^(\d+):([0-5]?\d)$/.exec(t.trim());
  return m ? +m[1] * 60 + +m[2] : null;
}
