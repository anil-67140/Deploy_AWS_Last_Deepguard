import { GitBranch, X, Lightbulb, ArrowRight, Info } from 'lucide-react'
import RiskGauge from './RiskGauge'
import ShapDiverging from './ShapDiverging'
import ModelScoreBars from './ModelScoreBars'
import { LEVEL_COLORS } from './riskBands'
import { buildNarrative, NEXT_STEP } from '../../utils/featureLabels'

function Section({ title, children, hint }) {
  return (
    <section className="fade-up">
      <div className="flex items-center gap-1.5 mb-2.5">
        <h4 className="eyebrow">{title}</h4>
        {hint && <span title={hint}><Info className="w-3 h-3 text-slate-600" /></span>}
      </div>
      {children}
    </section>
  )
}

/** "Why was this transaction flagged?" — gauge, plain-English story, signed SHAP, model agreement. */
export default function TxExplainPanel({ tx, threshold, onClose, onTrace }) {
  const color = LEVEL_COLORS[tx.riskLevel] || '#94a3b8'
  const hasSigned = tx.shapSigned && Object.keys(tx.shapSigned).length > 0
  const hasAnyShap = hasSigned || (tx.shapValues && Object.keys(tx.shapValues).length > 0)
  const story = buildNarrative({ shapSigned: tx.shapSigned, shapUnsigned: tx.shapValues, riskScore: tx.riskScore, riskLevel: tx.riskLevel, threshold })
  const facts = [
    ['From',    tx.account || '—', true],
    ['To',      tx.toAccount || '—', true],
    ['Amount',  `$${(tx.amountPaid || 0).toLocaleString()}`],
    ['Method',  tx.paymentFormat || '—'],
    ['Currency', `${tx.paymentCurrency || '?'} → ${tx.receivingCurrency || '?'}`],
  ]

  return (
    <aside className="w-[27rem] max-w-[45vw] flex-shrink-0 border-l border-slate-800 bg-slate-900/95 overflow-y-auto">
      <div className="sticky top-0 z-10 px-5 py-3 border-b border-slate-800 bg-slate-900/95 backdrop-blur flex items-center justify-between">
        <div className="min-w-0">
          <p className="eyebrow">Explain this transaction</p>
          <p className="text-xs font-mono text-slate-200 truncate">{tx.transactionId}</p>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800" aria-label="Close"><X className="w-4 h-4" /></button>
      </div>

      <div className="p-5 space-y-6">
        {/* verdict */}
        <div className="rounded-2xl border p-4 text-center fade-up" style={{ borderColor: `${color}55`, background: `linear-gradient(160deg, ${color}14, transparent 70%)` }}>
          <RiskGauge score={tx.riskScore} level={tx.riskLevel} threshold={threshold} />
          <div className="mt-1 flex items-center justify-center gap-2">
            <span className="chip" style={{ color, borderColor: `${color}66`, background: `${color}1f` }}>{tx.riskLevel} risk</span>
            {tx.fraudCategory && tx.fraudCategory !== 'Clean' && <span className="chip border-slate-600 text-slate-300">{tx.fraudCategory}</span>}
          </div>
        </div>

        {/* story */}
        {(story || !hasAnyShap) && (
          <Section title="Why was it flagged?">
            <div className="rounded-xl bg-slate-800/50 border border-slate-700/60 p-3.5">
              <div className="flex gap-2.5">
                <Lightbulb className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color }} />
                <p className="text-[13px] text-slate-200 leading-relaxed">
                  {story || (tx.riskLevel === 'Low'
                    ? 'This transaction scored low, so no detailed explanation was generated (explanations are produced for medium risk and above).'
                    : 'No factor-level explanation is stored for this transaction.')}
                </p>
              </div>
              <p className="text-[12px] text-slate-400 mt-2.5 pl-6 flex gap-1.5"><ArrowRight className="w-3 h-3 mt-0.5 flex-shrink-0" />{NEXT_STEP[tx.riskLevel] || ''}</p>
            </div>
          </Section>
        )}

        {/* shap */}
        {hasAnyShap && (
          <Section title="What drove the score" hint="SHAP shows how much each factor moved this transaction’s score up or down.">
            <ShapDiverging signed={tx.shapSigned} unsigned={tx.shapValues} />
          </Section>
        )}

        {/* models */}
        <Section title="What each model says" hint="Only the final score triggers alerts.">
          <ModelScoreBars tx={tx} threshold={threshold} />
        </Section>

        {/* facts */}
        <Section title="Transaction facts">
          <dl className="rounded-xl border border-slate-800 divide-y divide-slate-800">
            {facts.map(([k, v, mono]) => (
              <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd className={`text-xs text-slate-200 text-right truncate ${mono ? 'font-mono' : ''}`}>{v}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <button onClick={onTrace} className="btn-secondary w-full flex items-center justify-center gap-2 text-xs">
          <GitBranch className="w-3.5 h-3.5" /> Trace network graph
        </button>
      </div>
    </aside>
  )
}
