import { LEVEL_COLORS } from './riskBands'

const ROWS = [
  { key: 'riskScore',            label: 'Final risk score',   role: 'Decision',  color: null,      tip: 'XGBoost with autoencoder features — this decides the alert.' },
  { key: 'autoencoderScore',     label: 'Autoencoder',        role: 'Signal',    color: '#c084fc', tip: 'Unsupervised: how unusual the pattern is compared with normal traffic.' },
  { key: 'isolationForestScore', label: 'Isolation Forest',   role: 'Signal',    color: '#38bdf8', tip: 'Unsupervised: how easily this transaction is isolated from the rest.' },
  { key: 'gnnScore',             label: 'Graph neural net',   role: 'Signal',    color: '#e879f9', tip: 'Looks at the whole transaction network around the accounts (optional).' },
]

/** Side-by-side view of what each model thinks — shows agreement / disagreement at a glance. */
export default function ModelScoreBars({ tx, threshold }) {
  const thr = Number.isFinite(threshold) ? threshold * 100 : null
  return (
    <div className="space-y-2.5">
      {ROWS.map(r => {
        const v = tx[r.key]
        if (v === null || v === undefined) return null
        const color = r.color || LEVEL_COLORS[tx.riskLevel] || '#38bdf8'
        return (
          <div key={r.key} title={r.tip}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-slate-300 flex items-center gap-1.5">
                {r.label}
                <span className={`text-[9px] px-1 rounded ${r.role === 'Decision' ? 'bg-sky-500/15 text-sky-300' : 'bg-slate-700/60 text-slate-400'}`}>{r.role}</span>
              </span>
              <span className="text-xs font-bold text-white tabular-nums">{Number(v).toFixed(1)}</span>
            </div>
            <div className="relative h-2 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full rounded-full grow-right" style={{ width: `${Math.min(100, v)}%`, background: `linear-gradient(90deg, ${color}55, ${color})` }} />
              {r.key === 'riskScore' && thr != null && (
                <div className="absolute top-0 bottom-0 w-px bg-white/80" style={{ left: `${thr}%` }} title={`Alert threshold ${thr.toFixed(0)}`} />
              )}
            </div>
          </div>
        )
      })}
      <p className="text-[10px] text-slate-600 leading-snug pt-1">
        Only the final score triggers an alert; the other bars are supporting evidence and can disagree.
      </p>
    </div>
  )
}
