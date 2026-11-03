// Risk bands exactly as the AI engine computes them (ai-engine/main.py → analyze):
//   Critical  risk >= max(thr*1.3, thr+0.15)     High  risk >= thr
//   Medium    risk >= thr*0.5                    Low   otherwise
export const LEVEL_COLORS = { Critical: '#ef4444', High: '#f59e0b', Medium: '#3b82f6', Low: '#22c55e' }

export function getBands(threshold) {
  const thr = Number.isFinite(threshold) ? threshold : 0.5
  const crit = Math.max(thr * 1.3, thr + 0.15)
  const pct = (x) => Math.min(100, x * 100)
  return {
    thr: pct(thr),
    list: [
      { level: 'Low',      from: 0,            to: pct(thr * 0.5) },
      { level: 'Medium',   from: pct(thr * 0.5), to: pct(thr) },
      { level: 'High',     from: pct(thr),     to: pct(crit) },
      { level: 'Critical', from: pct(crit),    to: 100 },
    ],
  }
}
