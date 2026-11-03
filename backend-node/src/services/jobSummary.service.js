/**
 * Per-job summaries — what makes the Dashboard instant.
 *
 * PROBLEM: the dashboard needs "how many Critical/High/Medium/Low", "which typologies", "score histogram" and "top
 * alerts" across ALL analyses. Computing that from the Transaction collection means scanning every transaction ever
 * saved (hundreds of thousands of fat documents) on each load — 5-7 s, and it grows with every file.
 *
 * FIX: the numbers are tiny, and the upload pipeline already looks at every result while it runs. So it adds them up
 * as it goes (addResults) and stores ONE small summary on the Job. The dashboard then merges a few hundred bytes per
 * job (mergeSummaries) instead of scanning transactions. Jobs analysed before this change get their summary computed
 * once, in the background (backfillMissingSummaries), then are instant too.
 */
const Job = require('../models/Job.model');
const Transaction = require('../models/Transaction.model');
const overviewCache = require('./overviewCache');

const LEVELS = ['Critical', 'High', 'Medium', 'Low'];
const TOP_ALERTS = 10;
const BUCKETS = 10; // risk-score deciles: 0-10 … 90-100

function createAccumulator() {
  return { risk: { Critical: 0, High: 0, Medium: 0, Low: 0 }, categories: {}, scores: new Array(BUCKETS).fill(0), topAlerts: [] };
}

/** Add one batch of engine results (snake_case fields as returned by the AI engine). */
function addResults(acc, results, jobId) {
  for (const r of results) {
    if (acc.risk[r.risk_level] !== undefined) acc.risk[r.risk_level]++;
    const score = Number(r.risk_score) || 0;
    acc.scores[Math.max(0, Math.min(BUCKETS - 1, Math.floor(score / 10)))]++;
    if (r.is_fraud) {
      const cat = r.fraud_category || 'Unknown';
      acc.categories[cat] = (acc.categories[cat] || 0) + 1;
      const top = acc.topAlerts;
      if (top.length < TOP_ALERTS || score > top[top.length - 1].riskScore) {
        top.push({ jobId, transactionId: r.transaction_id, riskScore: score, riskLevel: r.risk_level, fraudCategory: r.fraud_category, isFraud: true });
        top.sort((a, b) => b.riskScore - a.riskScore);
        if (top.length > TOP_ALERTS) top.length = TOP_ALERTS;
      }
    }
  }
}

const finalize = (acc) => ({ v: 1, risk: acc.risk, categories: acc.categories, scores: acc.scores, topAlerts: acc.topAlerts });

/** Merge the stored summaries of many jobs into the shapes the dashboard UI already consumes. */
function mergeSummaries(jobs) {
  const risk = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  const cats = {};
  const scores = new Array(BUCKETS).fill(0);
  let alerts = [];
  let withSummary = 0;
  for (const j of jobs) {
    const s = j.summary;
    if (!s) continue;
    withSummary++;
    for (const l of LEVELS) risk[l] += (s.risk && s.risk[l]) || 0;
    for (const [k, v] of Object.entries(s.categories || {})) cats[k] = (cats[k] || 0) + v;
    (s.scores || []).forEach((c, i) => { if (i < BUCKETS) scores[i] += c || 0; });
    alerts = alerts.concat(s.topAlerts || []);
  }
  alerts.sort((a, b) => b.riskScore - a.riskScore);
  return {
    withSummary,
    riskBreakdown: LEVELS.map((l) => ({ _id: l, count: risk[l] })).filter((r) => r.count > 0),
    categoryBreakdown: Object.entries(cats).map(([_id, count]) => ({ _id, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    scoreDistribution: scores.map((count, i) => ({ _id: i * 10, count })),
    recentAlerts: alerts.slice(0, TOP_ALERTS),
  };
}

/** One-off computation from the database for a job that has no stored summary (older jobs). Uses the jobId indexes. */
async function computeSummaryFromDb(jobId) {
  const [facet, top] = await Promise.all([
    Transaction.aggregate([
      { $match: { jobId } },
      { $facet: {
        risk: [{ $group: { _id: '$riskLevel', count: { $sum: 1 } } }],
        categories: [{ $match: { isFraud: true } }, { $group: { _id: '$fraudCategory', count: { $sum: 1 } } }],
        scores: [{ $bucket: { groupBy: '$riskScore', boundaries: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 101], default: 'other', output: { count: { $sum: 1 } } } }],
      } },
    ]).allowDiskUse(true),
    Transaction.find({ jobId, isFraud: true }).sort({ riskScore: -1 }).limit(TOP_ALERTS)
      .select('transactionId riskScore riskLevel fraudCategory').lean(),
  ]);
  const f = (facet && facet[0]) || { risk: [], categories: [], scores: [] };
  const acc = createAccumulator();
  for (const r of f.risk) if (acc.risk[r._id] !== undefined) acc.risk[r._id] = r.count;
  for (const c of f.categories) acc.categories[c._id || 'Unknown'] = c.count;
  for (const b of f.scores) {
    if (b._id === 'other') continue;
    const i = Math.min(BUCKETS - 1, Math.floor(b._id / 10));
    acc.scores[i] += b.count; // the 100-101 bucket folds into 90-100
  }
  acc.topAlerts = top.map((t) => ({ jobId, transactionId: t.transactionId, riskScore: t.riskScore, riskLevel: t.riskLevel, fraudCategory: t.fraudCategory, isFraud: true }));
  return finalize(acc);
}

let backfillRunning = false;
const pendingFilter = { status: 'completed', summary: { $exists: false } };
const countPending = () => Job.countDocuments(pendingFilter);

/** Compute missing summaries one job at a time (single-flight). Safe to call often; returns how many were built. */
async function backfillMissingSummaries({ limit = 25 } = {}) {
  if (backfillRunning) return 0;
  backfillRunning = true;
  let built = 0;
  try {
    const jobs = await Job.find(pendingFilter).select('jobId').limit(limit).lean();
    for (const j of jobs) {
      try {
        const summary = await computeSummaryFromDb(j.jobId);
        await Job.updateOne({ jobId: j.jobId }, { $set: { summary } });
        built++;
        overviewCache.clear();
      } catch (err) {
        console.warn(`⚠️  summary backfill failed for job ${j.jobId}: ${err.message}`);
      }
    }
    if (built) console.log(`📊 Built dashboard summaries for ${built} earlier job(s)`);
  } finally {
    backfillRunning = false;
  }
  return built;
}

module.exports = { createAccumulator, addResults, finalize, mergeSummaries, computeSummaryFromDb, backfillMissingSummaries, countPending };
