/**
 * How long did a job take?  One place that turns the numbers the backend stores on a job into something readable.
 *
 * Job fields used:
 *   processingTimeMs  time the pipeline itself ran (read file → AI scoring → save). Also saved for FAILED jobs now.
 *   timings           { parseMs, engineMs, dbWaitMs, totalMs, rowsPerSec, … } — where that time went (newer jobs only)
 *   createdAt         when the file was submitted        completedAt  when the job finished (completed jobs)
 * Queue wait is not part of processingTimeMs; it is what is left of (completedAt − createdAt).
 */

/** 850 → "850 ms", 12400 → "12 s", 142000 → "2 min 22 s", 3900000 → "1 h 5 min". */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || ms < 0)
    return "—";
  ms = Number(ms);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  const tenth = Math.round(s * 10) / 10;
  if (tenth < 10) return `${tenth.toFixed(1)} s`; // 9.99 s must not read "10.0 s"
  const total = Math.round(s);
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  const rs = total % 60;
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

const ts = (v) => {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

export const isActive = (job) =>
  !!job && !["completed", "failed"].includes(job.status);

export const BREAKDOWN_COLORS = {
  parse: "#38bdf8",
  engine: "#a78bfa",
  db: "#f59e0b",
  other: "#64748b",
};

/**
 * Everything the UI needs about a job's timing.
 *   tookMs     how long the pipeline ran (completed or failed jobs) — null if unknown / still running
 *   queueMs    time spent waiting before processing started (0 when not known or negligible)
 *   elapsedMs  for a job that is still running: now − createdAt  (pass `now` so a ticking clock can re-render it)
 *   etaMs      rough time left while running (linear estimate from progress) — null when it would be a wild guess
 *   parts      the breakdown segments (null for jobs analysed before timings were recorded)
 */
export function getJobTiming(job, now = Date.now()) {
  if (!job)
    return {
      tookMs: null,
      queueMs: 0,
      elapsedMs: null,
      etaMs: null,
      parts: null,
      rowsPerSec: null,
    };
  const created = ts(job.createdAt);
  const completed = ts(job.completedAt);
  const finished = job.status === "completed" || job.status === "failed";

  let tookMs = null;
  if (finished) {
    if (job.processingTimeMs > 0) tookMs = job.processingTimeMs;
    else if (completed !== null && created !== null)
      tookMs = Math.max(0, completed - created); // older jobs
  }

  let queueMs = 0;
  if (
    job.status === "completed" &&
    completed !== null &&
    created !== null &&
    job.processingTimeMs > 0
  ) {
    queueMs = Math.max(0, completed - created - job.processingTimeMs);
    if (queueMs < 3000) queueMs = 0; // a couple of seconds is just upload/bookkeeping, not a real queue
  }

  let elapsedMs = null;
  let etaMs = null;
  if (isActive(job) && created !== null) {
    elapsedMs = Math.max(0, now - created);
    const p = Number(job.progress) || 0;
    if (p >= 25 && p < 100) etaMs = Math.round((elapsedMs / p) * (100 - p)); // parse stage ends at ~20%, so wait until past it
  }

  let parts = null;
  const t = job.timings;
  if (t && Number.isFinite(t.totalMs) && t.totalMs > 0) {
    const known = (t.parseMs || 0) + (t.engineMs || 0) + (t.dbWaitMs || 0);
    parts = [
      {
        key: "parse",
        label: "Reading & preparing the file",
        ms: t.parseMs || 0,
        color: BREAKDOWN_COLORS.parse,
      },
      {
        key: "engine",
        label: "AI models scoring",
        ms: t.engineMs || 0,
        color: BREAKDOWN_COLORS.engine,
      },
      {
        key: "db",
        label: "Waiting for the database",
        ms: t.dbWaitMs || 0,
        color: BREAKDOWN_COLORS.db,
      },
      {
        key: "other",
        label: "Summaries & bookkeeping",
        ms: Math.max(0, t.totalMs - known),
        color: BREAKDOWN_COLORS.other,
      },
    ].filter((p) => p.ms > 0);
  }

  const rowsPerSec =
    t?.rowsPerSec ||
    (tookMs && job.totalTransactions
      ? Math.round(job.totalTransactions / (tookMs / 1000))
      : null);

  return { tookMs, queueMs, elapsedMs, etaMs, parts, rowsPerSec };
}
