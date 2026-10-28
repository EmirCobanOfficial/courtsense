import { COURT, COURT_LINES } from "@/lib/court.ts";
import { useT, type Key, type Lang } from "@/lib/i18n.ts";
import type { PlayerMetrics } from "@/lib/metrics.ts";

// Classes ~3x apart: one cell holds 0.01–25% of a player's time, so linear steps would paint almost every cell the palest blue.
const EDGES = [0.003, 0.01, 0.03, 0.1];
const LABELS = { en: ["<0.3", "0.3–1", "1–3", "3–10", "≥10"], tr: ["<0,3", "0,3–1", "1–3", "3–10", "≥10"] };
// One blue ramp; dark mode runs it the other way so little time fades into the dark background.
const STEPS = [
  "text-[#86b6ef] dark:text-[#184f95]",
  "text-[#5598e7] dark:text-[#256abf]",
  "text-[#2a78d6] dark:text-[#3987e5]",
  "text-[#1c5cab] dark:text-[#6da7ec]",
  "text-[#104281] dark:text-[#9ec5f4]",
];
const GAP = 0.18; // m between cells, ~2 px at the 192 px diagram width

export function Heatmap({ metrics }: { metrics: PlayerMetrics[] }) {
  const { t, lang } = useT();
  return (
    <div className="space-y-2">
      <h3 className="font-medium">
        {t("heatmap")} <span className="text-sm font-normal opacity-60">· {t("heatmapSub")}</span>
      </h3>
      <div className="flex gap-6">
        {metrics.map((m) => (
          <PlayerHeatmap key={m.player} m={m} />
        ))}
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="opacity-70">{t("heatLegend")}</span>
        {LABELS[lang].map((label, k) => (
          <span key={label} className="flex items-center gap-1">
            <span className={`size-3 rounded-sm bg-current ${STEPS[k]}`} />
            {label}
          </span>
        ))}
      </p>
    </div>
  );
}

function PlayerHeatmap({ m }: { m: PlayerMetrics }) {
  const { t, lang } = useT();
  const { x0, y0, cols, rows, counts } = m.heatmap;
  const total = counts.reduce((a, b) => a + b, 0);
  const title = t(m.player === "A" ? "playerA" : "playerB");
  const aria = total ? t("heatAria", { title, ...busiest(m.heatmap, total, t, lang) }) : `${title}. ${t("noTracking")}`;
  return (
    <figure className="max-w-48 flex-1 space-y-1">
      <figcaption className="text-sm">{title}</figcaption>
      <svg viewBox={`0 0 ${cols} ${rows}`} role="img" aria-label={aria} className="h-auto w-full">
        {/* world meters with +y up, so the near baseline (camera side) lands at the bottom */}
        <g transform={`translate(${-x0} ${rows + y0}) scale(1 -1)`}>
          {counts.map((c, i) =>
            c ? (
              <rect
                key={i}
                x={x0 + (i % cols) + GAP / 2}
                y={y0 + Math.floor(i / cols) + GAP / 2}
                width={1 - GAP}
                height={1 - GAP}
                rx={0.1}
                className={`fill-current ${STEPS[EDGES.filter((e) => c / total >= e).length]} hover:opacity-70`}
              >
                <title>{share(c / total, lang)}</title>
              </rect>
            ) : null,
          )}
          {/* a background-colored casing keeps the lines readable over dark cells */}
          <g strokeLinecap="square" className="pointer-events-none">
            {["stroke-background", "stroke-current opacity-60"].map((cls, pass) => (
              <g key={cls} className={cls}>
                {COURT_LINES.map(([a, b], i) => (
                  <line
                    key={i}
                    x1={a[0]}
                    y1={a[1]}
                    x2={b[0]}
                    y2={b[1]}
                    strokeWidth={(i === COURT_LINES.length - 1 ? 2 : 1) + (pass ? 0 : 2)}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            ))}
          </g>
        </g>
      </svg>
      {!total ? <p className="text-xs opacity-60">{t("noTracking")}</p> : !m.reliable && <p className="text-xs opacity-60">{t("heatRough")}</p>}
    </figure>
  );
}

// Names the busiest cell in the zone words of the metrics table.
function busiest({ counts, cols, x0, y0 }: PlayerMetrics["heatmap"], total: number, t: (k: Key) => string, lang: Lang) {
  const i = counts.indexOf(Math.max(...counts));
  const x = x0 + (i % cols) + 0.5;
  const y = y0 + Math.floor(i / cols) + 0.5;
  const far = y > COURT.net;
  const d = far ? COURT.length - y : y;
  const zone = d < 0 ? "z_behind" : d < 2 ? "z_baseline" : d < COURT.serviceFromBaseline ? "z_mid" : "z_net";
  const lx = far ? -x : x; // the far player faces the camera, so their left is camera right
  const side = lx < -COURT.singlesHalf / 3 ? "s_left" : lx > COURT.singlesHalf / 3 ? "s_right" : "s_center";
  return { half: t(far ? "far" : "near"), zone: t(zone), side: t(side), share: share(counts[i] / total, lang) };
}

// Two significant digits: cells hold as little as 0.01% of the time.
const share = (v: number, lang: Lang) => {
  const n = (v * 100).toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { maximumSignificantDigits: 2 });
  return lang === "tr" ? `%${n}` : `${n}%`;
};
