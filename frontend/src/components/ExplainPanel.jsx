import React from 'react'
import { AlertTriangle, ArrowRight, ChevronLeft, Info } from 'lucide-react'
import { levelStyle, fmtAmt, fmtTime, shortId, shapLabel, ORIGIN_COLOR } from '../utils/graphModel'

const CATEGORY_MEANING = {
  'Circular Transaction': 'Amount paid and amount received are almost identical.',
  'Cryptocurrency Laundering': 'A Bitcoin payment with a high score.',
  'High-Risk AML Typology': 'Very high score (above 85).',
  'Suspicious Layering': 'High score (above 70), consistent with moving money in steps.',
  'Unusual Transfer Volume': 'Moderately high score (above 50).',
  'Low-Risk Anomaly': 'Slightly unusual, but low risk.',
  Clean: 'Nothing unusual found.',
}
const TONE_COLOR = { danger: '#ef4f55', warn: '#f0803c', info: ORIGIN_COLOR }

export function RiskDial({ score = 0, level = 'Low', size = 64 }) {
  const r = 26, len = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(score, 100)) / 100
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={`Risk score ${Math.round(score)} out of 100, ${level}`}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="#1e293b" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={levelStyle(level).line} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${len * pct} ${len}`} transform="rotate(-90 32 32)" />
      <text x="32" y="37" textAnchor="middle" fontSize="16" fontWeight="700" fill="#f1f5f9">{Math.round(score)}</text>
    </svg>
  )
}

export function LevelPill({ level }) {
  const s = levelStyle(level)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2 py-0.5"
      style={{ background: s.fill, color: s.text, border: `1px solid ${s.line}66` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.line }} />{level || 'Low'}
    </span>
  )
}

/** Shared by the graph page and the analysis page: what the model leaned on, in plain words. */
export function ShapBars({ shap, limit = 6 }) {
  const rows = Object.entries(shap || {}).sort((a, b) => b[1] - a[1]).slice(0, limit)
  if (!rows.length) return null
  const max = rows[0][1] || 1
  return (
    <div>
      <div className="space-y-2.5">
        {rows.map(([key, v]) => (
          <div key={key} title={key}>
            <div className="flex justify-between gap-3 text-xs mb-1">
              <span className="text-slate-300">{shapLabel(key)}</span>
              <span className="text-slate-400 tabular-nums">{(v * 100).toFixed(0)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div className="h-full rounded-full bg-sky-400/80" style={{ width: `${Math.min((v / max) * 100, 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500 mt-3 leading-relaxed">
        Each bar is the share of the model's decision that this signal explains (SHAP). Hover a label to see the raw feature name.
      </p>
    </div>
  )
}

function ModelScores({ focus }) {
  const rows = [
    { name: 'Isolation Forest', v: focus.isolationForestScore, note: 'Rare behaviour compared with the rest of the data.' },
    { name: 'Autoencoder', v: focus.autoencoderScore, note: 'A network trained on normal activity. High when it cannot reproduce this transaction.' },
    ...(focus.gnnScore != null ? [{ name: 'Graph network (GNN)', v: focus.gnnScore, note: 'Looks at who the accounts are connected to.' }] : []),
  ]
  return (
    <div className="space-y-3">
      {rows.map(({ name, v, note }) => (
        <div key={name}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-300">{name}</span>
            <span className="text-slate-400 tabular-nums">{(v || 0).toFixed(0)}/100</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className="h-full rounded-full bg-slate-400" style={{ width: `${Math.min(v || 0, 100)}%` }} />
          </div>
          <p className="text-xs text-slate-500 mt-1">{note}</p>
        </div>
      ))}
    </div>
  )
}

function Section({ title, hint, children }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      {hint && <p className="text-xs text-slate-400 mt-0.5 mb-3">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  )
}

function Verdict({ focus, model }) {
  const cur = model.currencies.size === 1 ? ` ${[...model.currencies][0]}` : ''
  return (
    <div className="flex gap-4 items-start">
      <RiskDial score={focus.riskScore} level={focus.riskLevel} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <LevelPill level={focus.riskLevel} />
          <span className="text-sm font-semibold text-slate-100">{focus.fraudCategory || 'Clean'}</span>
        </div>
        <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
          {CATEGORY_MEANING[focus.fraudCategory] || ''}
        </p>
        <p className="text-xs text-slate-300 mt-2 leading-relaxed">
          {fmtAmt(focus.amountPaid)}{focus.paymentCurrency ? ` ${focus.paymentCurrency}` : cur} by {focus.paymentFormat || 'unknown method'},
          {' '}<span className="font-mono">{shortId(focus.account)}</span> to <span className="font-mono">{shortId(focus.toAccount)}</span>
          {focus.timestamp ? `, ${fmtTime(focus.timestamp)}` : ''}.
        </p>
      </div>
    </div>
  )
}

function Evidence({ patterns, active, onPattern }) {
  if (!patterns.length) {
    return <p className="text-xs text-slate-400 leading-relaxed">No unusual pattern in the wider trail. The score comes from this transaction's own behaviour, shown below.</p>
  }
  return (
    <ul className="space-y-2">
      {patterns.map(p => {
        const on = active === p.id
        const Icon = p.tone === 'info' ? Info : AlertTriangle
        return (
          <li key={p.id}>
            <button onClick={() => onPattern(on ? null : p.id)} aria-pressed={on}
              className={`w-full text-left rounded-lg px-3 py-2.5 border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400
                ${on ? 'bg-slate-800 border-slate-600' : 'bg-slate-800/40 border-slate-800 hover:bg-slate-800/80'}`}
              style={{ borderLeft: `3px solid ${TONE_COLOR[p.tone]}` }}>
              <span className="flex items-start gap-2">
                <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: TONE_COLOR[p.tone] }} />
                <span>
                  <span className="block text-xs font-semibold text-slate-100">{p.title}</span>
                  <span className="block text-xs text-slate-400 mt-1 leading-relaxed">{p.detail}</span>
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg bg-slate-800/50 px-3 py-2">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-sm font-semibold text-slate-100 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

function NodeDetail({ node, model, onSelect }) {
  const isOrigin = node.id === model.origin
  const touching = [...model.flows.values()].filter(f => f.source === node.id || f.target === node.id)
    .sort((a, b) => b.maxRisk - a.maxRisk).slice(0, 8)
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <LevelPill level={node.level} />
          {isOrigin && <span className="text-xs rounded-full px-2 py-0.5" style={{ color: ORIGIN_COLOR, border: `1px solid ${ORIGIN_COLOR}55` }}>Origin</span>}
          {node.loopsBack && <span className="text-xs text-violet-300 rounded-full px-2 py-0.5 border border-violet-400/40">On a round trip</span>}
        </div>
        <p className="font-mono text-sm text-slate-100 mt-2 break-all select-all">{node.id}</p>
        {node.bank && <p className="text-xs text-slate-400 mt-0.5">Bank {node.bank}</p>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Sent" value={fmtAmt(node.sentAmt)} sub={`${node.sent} transactions`} />
        <Stat label="Received" value={fmtAmt(node.recvAmt)} sub={`${node.received} transactions`} />
        <Stat label="Highest risk" value={`${Math.round(node.maxRisk)}/100`} />
        <Stat label="Flagged" value={node.flagged} sub={node.selfCount ? `${node.selfCount} paid to itself` : undefined} />
      </div>
      <div>
        <p className="text-xs font-semibold text-slate-300 mb-2">Connections</p>
        <ul className="space-y-1">
          {touching.map(f => {
            const outgoing = f.source === node.id
            const other = f.self ? 'itself' : shortId(outgoing ? f.target : f.source)
            return (
              <li key={f.id}>
                <button onClick={() => onSelect({ kind: 'flow', id: f.id })}
                  className="w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
                  <span className="flex items-center gap-2 text-slate-300 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: levelStyle(f.level).line }} />
                    <span className="truncate">{outgoing ? 'Sent to' : 'Received from'} <span className="font-mono">{other}</span></span>
                  </span>
                  <span className="text-slate-400 tabular-nums flex-shrink-0">{f.count > 1 ? `×${f.count} ` : ''}{fmtAmt(f.total)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

function FlowDetail({ flow, onSelect }) {
  const txs = [...flow.txs].sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0))
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <LevelPill level={flow.level} />
          {flow.loop && <span className="text-xs text-violet-300 rounded-full px-2 py-0.5 border border-violet-400/40">On a round trip</span>}
        </div>
        <div className="flex items-center gap-2 mt-2 text-sm font-mono text-slate-100 flex-wrap">
          <button onClick={() => onSelect({ kind: 'node', id: flow.source })} className="hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded">{shortId(flow.source)}</button>
          <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
          {flow.self
            ? <span className="text-slate-300 font-sans text-xs">itself</span>
            : <button onClick={() => onSelect({ kind: 'node', id: flow.target })} className="hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded">{shortId(flow.target)}</button>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Total moved" value={fmtAmt(flow.total)} sub={[...flow.currencies].join(', ') || undefined} />
        <Stat label="Transactions" value={flow.count} sub={`${flow.flagged} flagged`} />
      </div>
      <div>
        <p className="text-xs font-semibold text-slate-300 mb-2">Transactions in this flow{flow.count > 10 ? ` (top 10 of ${flow.count} by risk)` : ''}</p>
        <ul className="space-y-1">
          {txs.slice(0, 10).map(t => (
            <li key={t.id} className="flex items-center justify-between gap-2 rounded-md bg-slate-800/40 px-2.5 py-1.5 text-xs">
              <span className="min-w-0">
                <span className="block font-mono text-slate-300 truncate">{t.id}</span>
                <span className="block text-slate-500">{[t.format, fmtTime(t.timestamp)].filter(Boolean).join(', ')}</span>
              </span>
              <span className="text-right flex-shrink-0">
                <span className="block text-slate-200 tabular-nums">{fmtAmt(t.amount)}</span>
                <span className="block tabular-nums" style={{ color: levelStyle(t.riskLevel).text }}>{Math.round(t.riskScore || 0)}/100</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default function ExplainPanel({ model, focus, patterns, selected, onSelect, onClear, activePattern, onPattern }) {
  const sel = selected && (selected.kind === 'flow' ? model.flows.get(selected.id) : model.nodes.get(selected.id))
  return (
    <aside className="w-80 xl:w-96 flex-shrink-0 border-l border-slate-800 bg-slate-900 overflow-y-auto" aria-label="Explanation">
      <div className="p-5 space-y-7">
        {sel ? (
          <>
            <button onClick={onClear} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded">
              <ChevronLeft className="w-3.5 h-3.5" /> Back to overview
            </button>
            {selected.kind === 'flow' ? <FlowDetail flow={sel} onSelect={onSelect} /> : <NodeDetail node={sel} model={model} onSelect={onSelect} />}
          </>
        ) : (
          <>
            {focus && <Verdict focus={focus} model={model} />}
            <Section title="What the trail shows" hint="Select a finding to light it up on the graph.">
              <Evidence patterns={patterns} active={activePattern} onPattern={onPattern} />
            </Section>
            {focus && (
              <>
                <Section title="How the models scored it" hint="Three detectors look at the transaction differently. The final score combines them.">
                  <ModelScores focus={focus} />
                </Section>
                {focus.shapValues && Object.keys(focus.shapValues).length > 0 && (
                  <Section title="Signals that mattered most" hint="Why this transaction scored the way it did.">
                    <ShapBars shap={focus.shapValues} />
                  </Section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
