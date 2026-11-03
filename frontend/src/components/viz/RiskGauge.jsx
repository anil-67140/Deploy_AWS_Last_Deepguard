import { getBands, LEVEL_COLORS } from './riskBands'

const CX = 110, CY = 105, R = 80
const polar = (deg) => {            // 0..180 (left → right along the top)
  const a = Math.PI * (1 - deg / 180)
  return [CX + R * Math.cos(a), CY - R * Math.sin(a)]
}
const arc = (from, to) => {
  const [x1, y1] = polar(from), [x2, y2] = polar(to)
  return `M ${x1} ${y1} A ${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`
}

/** Semi-circle gauge whose coloured bands are the REAL Low/Medium/High/Critical cut-offs. */
export default function RiskGauge({ score = 0, level, threshold }) {
  const { thr, list } = getBands(threshold)
  const s = Math.max(0, Math.min(100, Number(score) || 0))
  const toDeg = (v) => (v / 100) * 180
  const [nx, ny] = polar(toDeg(s))
  const [tx1, ty1] = polar(toDeg(thr))
  const tOut = (() => { const a = Math.PI * (1 - toDeg(thr) / 180); return [CX + (R + 13) * Math.cos(a), CY - (R + 13) * Math.sin(a)] })()
  const color = LEVEL_COLORS[level] || '#94a3b8'

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 220 152" className="w-full max-w-[250px]" role="img"
           aria-label={`Risk score ${s.toFixed(0)} out of 100, ${level} risk`}>
        <path d={arc(0, 180)} fill="none" stroke="#1e293b" strokeWidth="16" strokeLinecap="round" />
        {list.map(b => (
          <path key={b.level} d={arc(toDeg(b.from) + 0.6, toDeg(b.to) - 0.6)} fill="none"
                stroke={LEVEL_COLORS[b.level]} strokeOpacity={b.level === level ? 1 : 0.28} strokeWidth="14" />
        ))}
        {/* alert-threshold tick */}
        <line x1={tx1} y1={ty1} x2={tOut[0]} y2={tOut[1]} stroke="#e2e8f0" strokeWidth="2" strokeDasharray="2 2" />
        <text x={tOut[0]} y={tOut[1] - 4} textAnchor="middle" fontSize="8.5" fill="#94a3b8">alert {thr.toFixed(0)}</text>
        {/* needle */}
        <line x1={CX} y1={CY} x2={nx} y2={ny} stroke={color} strokeWidth="3.5" strokeLinecap="round"
              style={{ transition: 'all .8s cubic-bezier(.2,.8,.2,1)' }} />
        <circle cx={CX} cy={CY} r="7" fill="#0f172a" stroke={color} strokeWidth="3" />
        <text x={CX} y={CY + 27} textAnchor="middle" fontSize="26" fontWeight="700" fill="#fff">{s.toFixed(0)}</text>
        <text x={CX} y={CY + 41} textAnchor="middle" fontSize="8.5" letterSpacing="1" fill="#64748b">RISK SCORE / 100</text>
      </svg>
      <div className="flex items-center gap-3 -mt-1">
        {list.map(b => (
          <span key={b.level} className="flex items-center gap-1 text-[10px] text-slate-400">
            <i className="w-2 h-2 rounded-full" style={{ background: LEVEL_COLORS[b.level], opacity: b.level === level ? 1 : 0.4 }} />
            {b.level}
          </span>
        ))}
      </div>
    </div>
  )
}
