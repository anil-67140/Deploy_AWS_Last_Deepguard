/** Shared dark tooltip for recharts. `format(entry)` may return a string or a node. */
export default function ChartTooltip({ active, payload, label, labelFormat, valueFormat }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-950/95 border border-slate-600 rounded-lg px-3 py-2 shadow-xl text-xs">
      {label != null && <p className="font-semibold text-white mb-1">{labelFormat ? labelFormat(label, payload) : label}</p>}
      {payload.map((p, i) => (
        <p key={i} className="flex items-center gap-2 text-slate-300">
          <i className="w-2 h-2 rounded-full" style={{ background: p.color || p.fill || p.stroke }} />
          <span className="text-slate-400">{p.name}</span>
          <span className="font-semibold text-white ml-auto pl-3 tabular-nums">{valueFormat ? valueFormat(p.value, p) : Number(p.value).toLocaleString()}</span>
        </p>
      ))}
    </div>
  )
}
