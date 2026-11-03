import { useState } from 'react'
import { describeFeature, GROUPS } from '../../utils/featureLabels'

/**
 * Diverging SHAP chart.  RIGHT / red = pushed the fraud probability UP, LEFT / green = pulled it DOWN.
 * Works with SIGNED values (shapSigned). For older jobs that only stored unsigned shares, pass `unsigned`
 * and it renders one-directional "share of influence" bars instead.
 */
const COLS = '10.5rem 1fr 3rem'

export default function ShapDiverging({ signed, unsigned, limit = 8 }) {
  const [active, setActive] = useState(null)
  const isSigned = signed && Object.keys(signed).length > 0
  const src = isSigned ? signed : unsigned
  if (!src || !Object.keys(src).length) return null

  const rows = Object.entries(src)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, limit)
    .map(([name, v]) => ({ ...describeFeature(name), value: v }))
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 1e-9)
  const usedGroups = [...new Set(rows.map(r => r.group))]

  return (
    <div>
      <div className="grid items-center gap-2 mb-1.5" style={{ gridTemplateColumns: COLS }}>
        <span />
        {isSigned ? (
          <div className="flex justify-between text-[10px]">
            <span className="text-emerald-400/80">◀ lowers risk</span>
            <span className="text-red-400/80">raises risk ▶</span>
          </div>
        ) : <span className="text-[10px] text-slate-500 text-right">share of influence ▶</span>}
        <span />
      </div>

      <div className="space-y-1.5">
        {rows.map((r, i) => {
          const w = (Math.abs(r.value) / max) * 100
          const up = r.value >= 0
          return (
            <div key={r.name} className="group relative grid items-center gap-2 cursor-default" style={{ gridTemplateColumns: COLS }}
                 onMouseEnter={() => setActive(r.name)} onMouseLeave={() => setActive(null)}>
              <div className="flex items-center gap-1.5 min-w-0">
                <i className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: r.color }} />
                <span className="text-[11px] text-slate-300 leading-tight line-clamp-2" title={r.name}>{r.label}</span>
              </div>

              {isSigned ? (
                <div className="grid grid-cols-2 h-4 items-center">
                  <div className="flex justify-end h-full items-center border-r border-slate-600">
                    {!up && <div className="h-3 rounded-l-full grow-left" style={{ width: `${w}%`, background: 'linear-gradient(270deg,#10b981,#065f46)', animationDelay: `${i * 40}ms` }} />}
                  </div>
                  <div className="flex justify-start h-full items-center">
                    {up && <div className="h-3 rounded-r-full grow-right" style={{ width: `${w}%`, background: 'linear-gradient(90deg,#991b1b,#ef4444)', animationDelay: `${i * 40}ms` }} />}
                  </div>
                </div>
              ) : (
                <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full grow-right" style={{ width: `${w}%`, background: 'linear-gradient(90deg,#0369a1,#38bdf8)', animationDelay: `${i * 40}ms` }} />
                </div>
              )}

              <span className={`text-right text-[11px] font-mono tabular-nums ${isSigned ? (up ? 'text-red-300' : 'text-emerald-300') : 'text-slate-300'}`}>
                {isSigned ? `${up ? '+' : '−'}${Math.abs(r.value).toFixed(2)}` : `${(r.value * 100).toFixed(0)}%`}
              </span>

              {active === r.name && (
                <div className="absolute z-20 left-0 -top-1 -translate-y-full w-64 bg-slate-950 border border-slate-600 rounded-lg p-2.5 shadow-xl pointer-events-none fade-up">
                  <p className="text-xs font-semibold text-white">{r.label}</p>
                  <p className="text-[10px] font-mono text-slate-500 mb-1">{r.name} · {r.groupLabel}</p>
                  {r.desc && <p className="text-[11px] text-slate-300 leading-snug">{r.desc}</p>}
                  <p className="text-[11px] mt-1" style={{ color: isSigned ? (up ? '#fca5a5' : '#6ee7b7') : '#7dd3fc' }}>
                    {isSigned ? (up ? 'This pushed the risk UP for this transaction.' : 'This pulled the risk DOWN for this transaction.')
                              : `Accounts for ${(r.value * 100).toFixed(0)}% of the model’s reasoning.`}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 pt-2 border-t border-slate-800">
        {usedGroups.map(g => (
          <span key={g} className="flex items-center gap-1 text-[10px] text-slate-500">
            <i className="w-1.5 h-1.5 rounded-full" style={{ background: GROUPS[g]?.color }} />{GROUPS[g]?.label}
          </span>
        ))}
      </div>
      <p className="text-[10px] text-slate-600 mt-2 leading-snug">
        {isSigned ? 'Exact TreeSHAP values from the XGBoost decision model (log-odds scale; longer bar = stronger effect). Top 8 factors shown.'
                  : 'Older job: only the unsigned share of influence was saved. Re-run the file to see which factors raised vs lowered the risk.'}
      </p>
    </div>
  )
}
