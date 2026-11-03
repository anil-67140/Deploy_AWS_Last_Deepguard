/**
 * Human-readable names + plain-English meaning for every feature the XGBoost model uses.
 * The raw names (S_out_cnt_24h, AE_z3 …) come from ai-engine/features.py; SHAP charts show
 * these labels so an auditor — or an examiner — can read them without the source code.
 *
 *   S_* = SENDER account behaviour      R_* = RECEIVER account behaviour
 *   *_1h / *_24h = rolling time windows  AE_* = produced by the Autoencoder
 */

export const GROUPS = {
  amount:   { label: 'Amount',               color: '#38bdf8' },
  timing:   { label: 'Timing',               color: '#a78bfa' },
  route:    { label: 'Route & payment type', color: '#2dd4bf' },
  sender:   { label: 'Sender behaviour',     color: '#f472b6' },
  receiver: { label: 'Receiver behaviour',   color: '#fb923c' },
  flow:     { label: 'Money-flow pattern',   color: '#facc15' },
  velocity: { label: 'Velocity (1h / 24h)',  color: '#f87171' },
  anomaly:  { label: 'Autoencoder anomaly',  color: '#c084fc' },
}

const F = (group, label, desc) => ({ group, label, desc })

export const FEATURES = {
  // ── Amount
  Log_Amount_Paid:  F('amount', 'Amount sent',               'Size of the amount paid (log scale). Very large or unusual amounts are riskier.'),
  Log_Amount_Recv:  F('amount', 'Amount received',           'Size of the amount received (log scale).'),
  Log_Amount_Ratio: F('amount', 'Sent vs received gap',      'How different the amount sent is from the amount received. A big gap can mean a hidden fee, conversion or layering.'),
  Is_Round_Amount:  F('amount', 'Round-number amount',       'Exact round amounts (e.g. 10,000) are more common in structured transfers.'),
  // ── Timing
  Hour:             F('timing', 'Hour of day',               'The hour the transfer happened.'),
  DayOfWeek:        F('timing', 'Day of week',               'The weekday of the transfer.'),
  Is_Night:         F('timing', 'Night-time transfer',       'Transfers made at night are less typical for normal business activity.'),
  // ── Route & payment type
  Is_Self_Transfer: F('route',  'Self-transfer',             'Sender and receiver are the same account.'),
  Is_Cross_Bank:    F('route',  'Cross-bank transfer',       'Money moved between two different banks.'),
  Is_Cross_Currency:F('route',  'Currency conversion',       'Paid in one currency and received in another.'),
  Payment_Format_enc:    F('route', 'Payment method',        'How the payment was made (wire, ACH, bitcoin, cheque …). Some methods are riskier.'),
  Payment_Currency_enc:  F('route', 'Currency sent',         'Currency the sender paid in.'),
  Receiving_Currency_enc:F('route', 'Currency received',     'Currency the receiver was paid in.'),
  // ── Sender behaviour
  S_out_n:          F('sender', "Sender's outgoing history", "How many outgoing transfers this sender has made so far."),
  S_amt_vs_avg:     F('sender', "Amount vs sender's usual",  "How this amount compares with what this sender normally sends."),
  S_dt_prev:        F('sender', "Time since sender's last transfer", 'A very short gap means rapid-fire activity.'),
  Pair_n:           F('sender', 'Earlier transfers on this pair', 'How often this exact sender → receiver pair has transacted before. New pairs are riskier.'),
  S_uniq_recv:      F('sender', 'Distinct receivers paid',   'Number of different accounts the sender has paid (fan-out).'),
  S_new_recv_rate:  F('sender', 'Rate of brand-new receivers','Share of the sender’s payments going to accounts it has never paid before.'),
  S_same_hour:      F('sender', 'Sender transfers in same hour', 'Other transfers by the sender within the same hour.'),
  S_same_day:       F('sender', 'Sender transfers on same day',  'Other transfers by the sender on the same day.'),
  S_same_amt:       F('sender', 'Repeated identical amount', 'The sender has sent exactly this amount before (possible structuring).'),
  // ── Receiver behaviour
  R_in_n:           F('receiver', "Receiver's incoming history", 'How many incoming transfers this receiver has had so far.'),
  R_dt_prev:        F('receiver', "Time since receiver's last incoming", 'A very short gap means money is arriving rapidly.'),
  R_uniq_send:      F('receiver', 'Distinct senders paying receiver', 'Number of different accounts paying the receiver (fan-in).'),
  R_same_hour:      F('receiver', 'Receiver transfers in same hour', 'Other incoming transfers within the same hour.'),
  R_same_day:       F('receiver', 'Receiver transfers on same day',  'Other incoming transfers on the same day.'),
  R_amt_vs_avg:     F('receiver', "Amount vs receiver's usual", 'How this amount compares with what this receiver normally gets.'),
  // ── Money-flow pattern
  S_prior_in_n:     F('flow', 'Sender previously received money',  'Number of earlier incoming transfers to the sender (money in → money out).'),
  S_prior_in_amt:   F('flow', 'Amount previously received by sender','Total the sender received earlier.'),
  S_passthru:       F('flow', 'Sender pass-through',           'Sender receives money and quickly sends it on — a classic layering signal.'),
  R_prior_out_n:    F('flow', 'Receiver previously sent money','Number of earlier outgoing transfers by the receiver.'),
  R_prior_out_amt:  F('flow', 'Amount previously sent by receiver','Total the receiver sent earlier.'),
  R_prior_in_amt:   F('flow', 'Amount previously received by receiver','Total the receiver received earlier.'),
  R_out_in_ratio:   F('flow', 'Receiver out/in ratio',         'Money leaving vs entering the receiver. Near 1 means funds are just passing through.'),
  // ── Velocity windows
  S_out_cnt_1h:     F('velocity', 'Sender outgoing (last hour)',   'Number of transfers the sender made in the previous hour.'),
  S_out_cnt_24h:    F('velocity', 'Sender outgoing (last 24 h)',   'Number of transfers the sender made in the previous 24 hours.'),
  S_out_amt_24h:    F('velocity', 'Sender outgoing amount (24 h)', 'Total amount the sender moved out in the previous 24 hours.'),
  R_in_cnt_1h:      F('velocity', 'Receiver incoming (last hour)', 'Number of transfers the receiver got in the previous hour.'),
  R_in_cnt_24h:     F('velocity', 'Receiver incoming (last 24 h)', 'Number of transfers the receiver got in the previous 24 hours.'),
  R_in_amt_24h:     F('velocity', 'Receiver incoming amount (24 h)','Total amount the receiver got in the previous 24 hours.'),
  S_in_cnt_1h:      F('velocity', 'Sender incoming (last hour)',   'Transfers received by the sender in the previous hour.'),
  S_in_cnt_24h:     F('velocity', 'Sender incoming (last 24 h)',   'Transfers received by the sender in the previous 24 hours.'),
  S_in_amt_24h:     F('velocity', 'Sender incoming amount (24 h)', 'Amount received by the sender in the previous 24 hours.'),
  R_out_cnt_1h:     F('velocity', 'Receiver outgoing (last hour)', 'Transfers sent by the receiver in the previous hour.'),
  R_out_cnt_24h:    F('velocity', 'Receiver outgoing (last 24 h)', 'Transfers sent by the receiver in the previous 24 hours.'),
  R_out_amt_24h:    F('velocity', 'Receiver outgoing amount (24 h)','Amount sent by the receiver in the previous 24 hours.'),
  // ── Autoencoder
  AE_err:           F('anomaly', 'Autoencoder surprise',       'How badly the Autoencoder could rebuild this transaction. High = unlike normal traffic.'),
}
for (let i = 0; i < 8; i++) {
  FEATURES[`AE_z${i}`] = F('anomaly', `Autoencoder pattern ${i + 1}`, 'One of 8 hidden “behaviour fingerprint” values learned by the Autoencoder.')
}

/** Safe lookup — unknown names still render (prettified). */
export function describeFeature(name) {
  const f = FEATURES[name]
  if (f) return { name, ...f, color: GROUPS[f.group].color, groupLabel: GROUPS[f.group].label }
  const pretty = String(name).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return { name, group: 'route', label: pretty, desc: '', color: '#94a3b8', groupLabel: 'Other' }
}

const joinNice = (arr) => arr.length <= 1 ? (arr[0] || '')
  : arr.length === 2 ? `${arr[0]} and ${arr[1]}`
  : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`

/**
 * Build the "Why was this flagged?" sentence(s) from SIGNED SHAP values.
 * positive SHAP => pushed the fraud probability UP; negative => pulled it DOWN.
 */
export function buildNarrative({ shapSigned, shapUnsigned, riskScore, riskLevel, threshold }) {
  const lbl = ([n]) => describeFeature(n).label.toLowerCase()
  const thr = threshold != null ? ` (alert threshold ${(threshold * 100).toFixed(0)})` : ''
  const head = `Scored ${Number(riskScore).toFixed(1)}/100${thr} — ${riskLevel} risk.`

  const signed = Object.entries(shapSigned || {}).filter(([, v]) => Number.isFinite(v))
  if (signed.length) {
    const ups   = signed.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    const downs = signed.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1])
    const parts = [head]
    if (ups.length) {
      const top = ups.slice(0, 3)
      const groups = [...new Set(top.map(([n]) => describeFeature(n).groupLabel.toLowerCase()))]
      parts.push(`The strongest risk drivers were ${joinNice(top.map(lbl))} — mostly ${joinNice(groups)} signals.`)
    } else {
      parts.push('None of the top factors pushed the score up.')
    }
    if (downs.length) parts.push(`Factors that lowered the risk: ${joinNice(downs.slice(0, 2).map(lbl))}.`)
    return parts.join(' ')
  }

  // Older jobs: only unsigned "share of influence" was saved — say what the model relied on, not which direction.
  const uns = Object.entries(shapUnsigned || {}).filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1])
  if (uns.length) return `${head} The model relied most on ${joinNice(uns.slice(0, 3).map(lbl))}.`
  return null
}

export const NEXT_STEP = {
  Critical: 'Escalate for review now: trace the network graph and check the counter-party accounts.',
  High:     'Review soon: open the network graph to see who this money came from and where it went.',
  Medium:   'Watch-list: no alert, but similar activity from these accounts is worth monitoring.',
  Low:      'No action needed: the model sees this as ordinary activity.',
}
