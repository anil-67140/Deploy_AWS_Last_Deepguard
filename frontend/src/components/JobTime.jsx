import { useEffect, useState } from "react";
import { Timer, Loader2, Hourglass, XCircle } from "lucide-react";
import { formatDuration, getJobTiming, isActive } from "../utils/duration";

/** A clock that ticks once a second — but only while `enabled`, so idle pages cost nothing. */
export function useNow(enabled) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled]);
  return now;
}

/** Plain-text version of the breakdown, used for tooltips. */
export function breakdownText(job) {
  const { parts, queueMs, rowsPerSec } = getJobTiming(job);
  const lines = [];
  if (parts)
    parts.forEach((p) => lines.push(`${p.label}: ${formatDuration(p.ms)}`));
  if (queueMs) lines.push(`Waited in queue: ${formatDuration(queueMs)}`);
  if (rowsPerSec) lines.push(`Speed: ${rowsPerSec.toLocaleString()} rows/s`);
  return lines.join("\n");
}

/**
 * One-line duration for a job:
 *   completed → "Took 2 min 22 s"      failed → "Failed after 12 s"
 *   running   → "Running 1 min 12 s · ≈ 2 min left"      queued → "Waiting 12 s"
 * Pass `now` (from useNow) to make running jobs tick.
 */
export default function JobTime({ job, now, className = "" }) {
  const { tookMs, elapsedMs, etaMs } = getJobTiming(job, now);

  if (job.status === "completed" && tookMs !== null) {
    return (
      <span
        title={breakdownText(job) || "How long the analysis took"}
        className={`inline-flex items-center gap-1 text-xs font-medium text-emerald-300 ${className}`}
      >
        <Timer className="w-3 h-3" />
        Took {formatDuration(tookMs)}
      </span>
    );
  }
  if (job.status === "failed") {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs font-medium text-red-300 ${className}`}
      >
        <XCircle className="w-3 h-3" />
        {tookMs !== null ? `Failed after ${formatDuration(tookMs)}` : "Failed"}
      </span>
    );
  }
  if (isActive(job) && elapsedMs !== null) {
    const queued = job.status === "queued";
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs font-medium text-sky-300 tabular-nums ${className}`}
      >
        {queued ? (
          <Hourglass className="w-3 h-3" />
        ) : (
          <Loader2 className="w-3 h-3 animate-spin" />
        )}
        {queued ? "Waiting in queue" : "Running"} {formatDuration(elapsedMs)}
        {etaMs !== null && (
          <span className="text-slate-400 font-normal">
            · ≈ {formatDuration(etaMs)} left
          </span>
        )}
      </span>
    );
  }
  return null;
}

/** Segmented bar + legend: where the time went. Renders nothing for jobs analysed before timings were recorded. */
export function TimeBreakdown({ job }) {
  const { parts, queueMs, tookMs, rowsPerSec } = getJobTiming(job);
  if (!parts) return null;
  const total = parts.reduce((a, p) => a + p.ms, 0) || 1;
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-3.5">
      <div className="flex items-baseline justify-between mb-2">
        <p className="eyebrow">Where the time went</p>
        <p className="text-[11px] text-slate-400 tabular-nums">
          total <b className="text-white">{formatDuration(tookMs)}</b>
          {rowsPerSec ? (
            <span className="text-slate-500">
              {" "}
              · {rowsPerSec.toLocaleString()} rows/s
            </span>
          ) : null}
        </p>
      </div>
      <div
        className="flex h-2.5 rounded-full overflow-hidden bg-slate-800"
        role="img"
        aria-label={parts
          .map((p) => `${p.label} ${formatDuration(p.ms)}`)
          .join(", ")}
      >
        {parts.map((p) => (
          <div
            key={p.key}
            style={{ width: `${(p.ms / total) * 100}%`, background: p.color }}
            title={`${p.label}: ${formatDuration(p.ms)}`}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
        {parts.map((p) => (
          <li
            key={p.key}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span className="flex items-center gap-2 text-slate-300 min-w-0">
              <i
                className="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ background: p.color }}
              />
              <span className="truncate">{p.label}</span>
            </span>
            <span className="tabular-nums text-slate-200 font-medium">
              {formatDuration(p.ms)}{" "}
              <span className="text-slate-500 font-normal">
                ({Math.round((p.ms / total) * 100)}%)
              </span>
            </span>
          </li>
        ))}
      </ul>
      {queueMs > 0 && (
        <p className="text-[11px] text-slate-400 mt-2.5">
          Plus <b className="text-slate-200">{formatDuration(queueMs)}</b>{" "}
          waiting in the queue before it started.
        </p>
      )}
      <p className="text-[10px] text-slate-600 mt-2 leading-snug">
        Saving to the database runs alongside the AI scoring, so only the time
        spent <i>waiting</i> for it is counted.
      </p>
    </div>
  );
}
