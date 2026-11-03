// Pure helpers behind the network-graph page. No React and no Cytoscape in here, so the
// logic can be tested on its own: API response -> model -> elements + plain-language evidence.

export const ORIGIN_COLOR = '#38bdf8'
export const LOOP_COLOR = '#a78bfa'

// One ramp for risk everywhere (nodes, edges, badges, bars) so colour always means the same thing.
export const LEVEL = {
  Low:      { fill: '#1b2535', line: '#5b6b84', text: '#94a3b8' },
  Medium:   { fill: '#3a2f12', line: '#e0b04a', text: '#e8c06a' },
  High:     { fill: '#3f2110', line: '#f0803c', text: '#f59a62' },
  Critical: { fill: '#47141a', line: '#ef4f55', text: '#f87177' },
}
export const levelStyle = (l) => LEVEL[l] || LEVEL.Low

export function fmtAmt(n) {
  n = Number(n) || 0
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function fmtTime(t) {
  const d = new Date(t)
  return isNaN(d) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const shortId = (id) => (id && id.length > 12 ? `${id.slice(0, 5)}…${id.slice(-4)}` : id)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`

function bfs(adj, start) {
  const dist = new Map([[start, 0]])
  const parent = new Map()
  const queue = [start]
  while (queue.length) {
    const u = queue.shift()
    for (const v of adj.get(u) || []) {
      if (!dist.has(v)) { dist.set(v, dist.get(u) + 1); parent.set(v, u); queue.push(v) }
    }
  }
  return { dist, parent }
}

/** API response -> accounts, aggregated flows (one per sender->receiver pair), lane columns. */
export function buildModel(data) {
  const origin = data.originAccount
  const txs = (data.edges || []).filter(e => e.source && e.target)
  const nodes = new Map()
  const flows = new Map()

  const node = (id, bank) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, bank: bank || '', sent: 0, received: 0, sentAmt: 0, recvAmt: 0,
        maxRisk: 0, level: 'Low', flagged: 0, selfCount: 0, col: 0, loopsBack: false })
    } else if (bank && !nodes.get(id).bank) nodes.get(id).bank = bank
    return nodes.get(id)
  }
  node(origin, data.originBank)

  const currencies = new Set()
  for (const t of txs) {
    const key = `${t.source}>${t.target}`
    let f = flows.get(key)
    if (!f) {
      f = { id: key, source: t.source, target: t.target, self: t.source === t.target, txs: [], count: 0, total: 0,
        maxRisk: 0, level: 'Low', flagged: 0, formats: new Set(), currencies: new Set(), loop: false }
      flows.set(key, f)
    }
    const amt = Number(t.amount) || 0
    f.txs.push(t); f.count++; f.total += amt
    if ((t.riskScore || 0) >= f.maxRisk) { f.maxRisk = t.riskScore || 0; f.level = t.riskLevel || 'Low' }
    if (t.isFraud) f.flagged++
    if (t.format) f.formats.add(t.format)
    if (t.currency) { f.currencies.add(t.currency); currencies.add(t.currency) }

    const s = node(t.source, t.fromBank), r = node(t.target, t.toBank)
    s.sent++; s.sentAmt += amt; r.received++; r.recvAmt += amt
    if (s === r) s.selfCount++
    for (const n of s === r ? [s] : [s, r]) {
      if ((t.riskScore || 0) >= n.maxRisk) { n.maxRisk = t.riskScore || 0; n.level = t.riskLevel || 'Low' }
      if (t.isFraud) n.flagged++
    }
  }

  // Lanes: how many transfers away from the origin, and on which side.
  const out = new Map(), inn = new Map()
  const link = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b) }
  for (const f of flows.values()) if (!f.self) { link(out, f.source, f.target); link(inn, f.target, f.source) }
  const down = bfs(out, origin), up = bfs(inn, origin)

  for (const n of nodes.values()) {
    const o = down.dist.get(n.id), i = up.dist.get(n.id)
    if (n.id === origin) n.col = 0
    else if (o !== undefined && (i === undefined || o <= i)) n.col = o
    else if (i !== undefined) n.col = -i
    else n.col = 1
    // Reachable from the origin AND able to reach it again => the money can come back.
    n.loopsBack = n.id !== origin && o !== undefined && i !== undefined
  }
  // A flow sits on a round trip if its sender is reachable from the origin and its receiver can reach the origin.
  for (const f of flows.values()) {
    f.loop = !f.self && down.dist.has(f.source) && up.dist.has(f.target)
  }
  const origNode = nodes.get(origin)
  if (origNode && [...flows.values()].some(f => f.loop)) origNode.loopsBack = true

  // Shortest round trip origin -> ... -> origin, for the evidence text.
  let loopPath = null
  for (const u of inn.get(origin) || []) {
    if (!down.dist.has(u)) continue
    if (!loopPath || down.dist.get(u) + 1 < loopPath.length - 1) {
      const path = [origin]
      const back = []
      for (let x = u; x !== origin; x = down.parent.get(x)) back.push(x)
      loopPath = [...path, ...back.reverse(), origin]
    }
  }

  return { origin, nodes, flows, txs, currencies, loopPath, out, inn, truncated: !!data.truncated,
    totalTransactions: data.totalTransactions || txs.length }
}

export const COL_W = 300

/**
 * Lane layout: one column per hop. Rules that keep it readable:
 *  - round-trip accounts sit above the middle row, so the line that closes the loop does not run through the origin
 *  - in outer lanes, accounts line up with the accounts that connect them to the previous lane (fewer crossings)
 */
export function layout(model) {
  const cols = new Map()
  for (const n of model.nodes.values()) {
    if (!cols.has(n.col)) cols.set(n.col, [])
    cols.get(n.col).push(n)
  }
  const longest = Math.max(...[...cols.values()].map(l => l.length))
  const ROW_H = longest <= 8 ? 100 : 72
  const pos = new Map()
  const put = (n, y) => pos.set(n.id, { x: n.col * COL_W, y })
  const byRisk = (a, b) => b.maxRisk - a.maxRisk || (b.sentAmt + b.recvAmt) - (a.sentAmt + a.recvAmt) || (a.id < b.id ? -1 : 1)
  const centreOut = (i) => (i === 0 ? 0 : i % 2 === 1 ? (i + 1) / 2 : -i / 2)   // 0, +1, -1, +2, -2 ...

  for (const n of cols.get(0) || []) put(n, 0)

  const nearerNeighbours = (n, lane) => {
    const res = []
    for (const f of model.flows.values()) {
      if (f.self) continue
      const other = f.source === n.id ? f.target : f.target === n.id ? f.source : null
      if (other && pos.has(other) && model.nodes.get(other).col === lane) res.push(other)
    }
    return res
  }

  for (const sign of [1, -1]) {
    for (let k = 1; cols.has(sign * k); k++) {
      const list = cols.get(sign * k)
      if (k === 1) {
        const loops = list.filter(n => n.loopsBack).sort(byRisk)
        const rest = list.filter(n => !n.loopsBack).sort(byRisk)
        const used = new Set()
        loops.forEach((n, i) => { put(n, -(i + 1) * ROW_H); used.add(-(i + 1)) })
        let i = 0
        for (const n of rest) {
          let row = centreOut(i++)
          while (used.has(row)) row = centreOut(i++)
          put(n, row * ROW_H)
        }
      } else {
        const want = new Map(list.map(n => {
          const nb = nearerNeighbours(n, sign * (k - 1))
          return [n.id, nb.length ? nb.reduce((t, id) => t + pos.get(id).y, 0) / nb.length : 0]
        }))
        list.sort((a, b) => want.get(a.id) - want.get(b.id) || byRisk(a, b))
        let last = -Infinity
        const ys = list.map(n => (last = Math.max(want.get(n.id), last + ROW_H)))
        const shift = list.reduce((t, n) => t + want.get(n.id), 0) / list.length - ys.reduce((t, y) => t + y, 0) / ys.length
        list.forEach((n, i) => put(n, ys[i] + shift))
      }
    }
  }
  for (const n of model.nodes.values()) if (!pos.has(n.id)) put(n, 0)
  return { pos }
}

/** Lane headings (drawn as an overlay by the page so they stay readable at any zoom). */
export function lanes(model) {
  const cols = [...new Set([...model.nodes.values()].map(n => n.col))].sort((a, b) => a - b)
  return cols.map(col => ({
    col,
    label: col === 0 ? 'Origin account'
      : col < 0 ? `Money in, ${plural(-col, 'hop')} back` : `Money out, ${plural(col, 'hop')} on`,
  }))
}

/** Model -> Cytoscape elements (nodes with positions, one edge per flow, lane headings). */
export function toElements(model) {
  const { pos } = layout(model)
  const money = [...model.nodes.values()].map(n => n.sentAmt + n.recvAmt)
  const lg = (v) => Math.log10(v + 1)
  const mMax = Math.max(...money.map(lg), 1), mMin = Math.min(...money.map(lg), 0)
  const norm = (v, lo, hi) => (hi - lo < 1e-9 ? 0.5 : (lg(v) - lo) / (hi - lo))

  const els = []
  for (const n of model.nodes.values()) {
    const isOrigin = n.id === model.origin
    const size = Math.round(30 + 26 * norm(n.sentAmt + n.recvAmt, mMin, mMax))
    const p = pos.get(n.id)
    els.push({ group: 'nodes', position: p, data: {
      id: n.id, label: n.id, level: n.level, size: isOrigin ? Math.max(size, 54) : size,
      origin: isOrigin, loop: n.loopsBack, flagged: n.flagged > 0,
    } })
  }

  const totals = [...model.flows.values()].map(f => f.total)
  const eMax = Math.max(...totals.map(lg), 1), eMin = Math.min(...totals.map(lg), 0)
  for (const f of model.flows.values()) {
    els.push({ group: 'edges', data: {
      id: f.id, source: f.source, target: f.target, level: f.level, flagged: f.flagged > 0, loop: f.loop,
      self: f.self, width: +(1.6 + 5.4 * norm(f.total, eMin, eMax)).toFixed(2),
      label: f.count > 1 ? `×${f.count}  ${fmtAmt(f.total)}` : fmtAmt(f.total),
    } })
  }

  return els
}

/**
 * Plain-language findings, each tied to the nodes/flows that prove it so the page can highlight them.
 * Only claims what the data in the graph shows; wording says "can" where it is an interpretation.
 */
export function detectPatterns(model) {
  const { origin, flows, nodes } = model
  const list = []
  const flowIdsOf = (pred) => [...flows.values()].filter(pred).map(f => f.id)

  // 1. Money that can return to where it started
  if (model.loopPath) {
    const ids = model.loopPath
    const fl = ids.slice(0, -1).map((a, i) => `${a}>${ids[i + 1]}`).filter(k => flows.has(k))
    list.push({ id: 'roundtrip', tone: 'danger',
      title: `Money can return to the origin in ${plural(ids.length - 1, 'transfer')}`,
      detail: `${ids.map(shortId).join(' → ')}. Round trips make the source of funds harder to follow, which is a classic layering step.`,
      nodes: ids, flows: fl })
  }

  // 2. Paying yourself
  const selfNodes = [...nodes.values()].filter(n => n.selfCount > 0)
  if (selfNodes.length) {
    const count = selfNodes.reduce((s, n) => s + n.selfCount, 0)
    const total = flowIdsOf(f => f.self).reduce((s, k) => s + flows.get(k).total, 0)
    list.push({ id: 'self', tone: selfNodes.some(n => n.id === origin) ? 'danger' : 'warn',
      title: selfNodes.length === 1
        ? `${shortId(selfNodes[0].id)} paid itself ${plural(count, 'time')}`
        : `${plural(selfNodes.length, 'account')} paid themselves ${plural(count, 'time')} in total`,
      detail: `${fmtAmt(total)} moved between an account and itself. This creates activity without sending money to anyone, and the model has a dedicated signal for it.`,
      nodes: selfNodes.map(n => n.id), flows: flowIdsOf(f => f.self) })
  }

  // 3. Spreading out / gathering in
  const recvs = [...(model.out.get(origin) || [])]
  if (recvs.length >= 3) list.push({ id: 'fanout', tone: 'warn',
    title: `Sends money to ${recvs.length} different accounts`,
    detail: 'Splitting a sum across many recipients can keep each payment small and less noticeable.',
    nodes: [origin, ...recvs], flows: recvs.map(r => `${origin}>${r}`) })
  const sends = [...(model.inn.get(origin) || [])]
  if (sends.length >= 3) list.push({ id: 'fanin', tone: 'warn',
    title: `Receives money from ${sends.length} different accounts`,
    detail: 'Many accounts paying into one can mean funds are being collected before they are moved on.',
    nodes: [origin, ...sends], flows: sends.map(s => `${s}>${origin}`) })

  // 4. Relaying money (only when amounts are comparable, i.e. a single currency)
  if (model.currencies.size <= 1) {
    let inAmt = 0, outAmt = 0
    for (const f of flows.values()) {
      if (f.self) continue
      if (f.target === origin) inAmt += f.total
      if (f.source === origin) outAmt += f.total
    }
    if (inAmt > 0 && outAmt > 0 && Math.min(inAmt, outAmt) / Math.max(inAmt, outAmt) >= 0.8) {
      list.push({ id: 'passthru', tone: 'warn', title: 'Passes on most of what it receives',
        detail: `${fmtAmt(inAmt)} came in and ${fmtAmt(outAmt)} went out. Accounts that mainly relay money are typical of mule accounts.`,
        nodes: [origin], flows: flowIdsOf(f => !f.self && (f.source === origin || f.target === origin)) })
    }
  }

  // 5. Fast activity around the origin
  const times = model.txs.filter(t => t.source === origin || t.target === origin)
    .map(t => new Date(t.timestamp).getTime()).filter(x => !isNaN(x))
  if (times.length >= 5) {
    const hours = (Math.max(...times) - Math.min(...times)) / 3.6e6
    if (hours <= 24) list.push({ id: 'burst', tone: 'info',
      title: `${times.length} transactions in ${hours < 1 ? 'under an hour' : `${Math.ceil(hours)} hours`}`,
      detail: 'The model tracks how many payments an account makes in the last hour and day, so bursts raise the score.',
      nodes: [origin], flows: flowIdsOf(f => f.source === origin || f.target === origin) })
  }

  // 6. Bitcoin
  const btc = flowIdsOf(f => f.formats.has('Bitcoin'))
  if (btc.length) list.push({ id: 'btc', tone: 'info', title: 'Includes Bitcoin payments',
    detail: 'Crypto payments are harder to tie to a person. The engine gives high-risk Bitcoin transfers their own category.',
    nodes: [], flows: btc })

  // 7. Other risky accounts in the trail
  const risky = [...nodes.values()].filter(n => n.id !== origin && (n.level === 'Critical' || n.level === 'High'))
  if (risky.length) list.push({ id: 'neighbours', tone: 'warn',
    title: `${plural(risky.length, 'other account')} in this trail ${risky.length === 1 ? 'is' : 'are'} also high risk`,
    detail: 'Risk tends to cluster: accounts that deal with flagged accounts are worth checking too.',
    nodes: risky.map(n => n.id), flows: [] })

  const order = { danger: 0, warn: 1, info: 2 }
  return list.sort((a, b) => order[a.tone] - order[b.tone])
}

/** Everything touching an account or a flow, for hover/selection highlighting. */
export function neighbourhood(model, sel) {
  if (!sel) return null
  const nodeIds = new Set(), flowIds = new Set()
  if (sel.kind === 'flow') {
    const f = model.flows.get(sel.id)
    if (f) { flowIds.add(f.id); nodeIds.add(f.source); nodeIds.add(f.target) }
  } else {
    nodeIds.add(sel.id)
    for (const f of model.flows.values()) {
      if (f.source === sel.id || f.target === sel.id) { flowIds.add(f.id); nodeIds.add(f.source); nodeIds.add(f.target) }
    }
  }
  return { nodes: [...nodeIds], flows: [...flowIds] }
}

// Plain-language names for the model's engineered features (ai-engine/features.py).
const SHAP_LABELS = {
  Log_Amount_Paid: 'Size of the amount sent', Log_Amount_Recv: 'Size of the amount received',
  Log_Amount_Ratio: 'Gap between amount sent and received', Is_Round_Amount: 'Amount is a round number',
  Hour: 'Hour of the day', DayOfWeek: 'Day of the week', Is_Night: 'Sent at night (10pm to 5am)',
  Is_Self_Transfer: 'Sender and receiver are the same account', Is_Cross_Bank: 'Money moves between banks',
  Is_Cross_Currency: 'Currency changes on the way', Payment_Format_enc: 'Payment method',
  Payment_Currency_enc: 'Currency paid', Receiving_Currency_enc: 'Currency received',
  S_out_n: 'How many payments the sender made before', S_amt_vs_avg: "Amount compared with the sender's usual",
  S_dt_prev: "Time since the sender's last payment", Pair_n: 'Earlier payments between this same pair',
  S_uniq_recv: 'Different accounts the sender has paid', S_new_recv_rate: 'How often the sender pays new accounts',
  S_same_hour: "Sender's other payments this hour", S_same_day: "Sender's other payments today",
  S_same_amt: 'Sender repeating the same amount', R_in_n: 'How many payments the receiver got before',
  R_dt_prev: "Time since the receiver's last payment", R_uniq_send: 'Different accounts that paid the receiver',
  R_same_hour: "Receiver's other payments this hour", R_same_day: "Receiver's other payments today",
  R_amt_vs_avg: "Amount compared with the receiver's usual", S_prior_in_n: 'Payments the sender received earlier',
  S_prior_in_amt: 'Money the sender received earlier', S_passthru: 'Sender passes on more than it received',
  R_prior_out_n: 'Payments the receiver sent earlier', R_prior_out_amt: 'Money the receiver sent earlier',
  R_prior_in_amt: 'Money the receiver received earlier', R_out_in_ratio: 'Receiver passes on what it receives',
}
export function shapLabel(key) {
  if (SHAP_LABELS[key]) return SHAP_LABELS[key]
  const s = key.replace(/_enc$/, '').replace(/^Log_/, '').replace(/_/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}
