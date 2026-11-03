const router = require("express").Router();
const { authenticate } = require("../middleware/auth.middleware");
const Transaction = require("../models/Transaction.model");
const Job = require("../models/Job.model");

// ── helpers ───────────────────────────────────────────────────────────────
// Query-string values can arrive as objects/arrays (?jobId[$ne]=x). Force
// scalars to strings so they can never be interpreted as Mongo operators.
const str = (v) =>
  typeof v === "string"
    ? v
    : v === undefined
      ? undefined
      : String(Array.isArray(v) ? v[0] : "").trim();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const int = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};
const MAX_PAGE_SIZE = 200;

function riskFilter(query, filter) {
  if (filter === "fraud") query.isFraud = true;
  if (filter === "critical") query.riskLevel = "Critical";
  if (filter === "high") query.riskLevel = "High";
  return query;
}

// Spreadsheet apps execute cells that start with = + - @ (CSV/formula injection).
const csvCell = (val) => {
  if (val === null || val === undefined) return "";
  let s = val instanceof Date ? val.toISOString() : String(val);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Stream a Mongo cursor out as JSON array or CSV without holding it all in memory.
async function streamCursor(res, cursor, format, columns) {
  if (format === "json") {
    res.write("[");
    let first = true;
    for await (const doc of cursor) {
      res.write((first ? "" : ",") + JSON.stringify(doc));
      first = false;
    }
    return res.end("]");
  }
  res.write(columns.join(",") + "\n");
  for await (const doc of cursor) {
    res.write(columns.map((c) => csvCell(doc[c])).join(",") + "\n");
  }
  res.end();
}

function setDownload(res, format, name) {
  res.setHeader(
    "Content-Type",
    format === "json" ? "application/json" : "text/csv",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${name}.${format}"`,
  );
}

const parseFormat = (req, res) => {
  const format = (str(req.query.format) || "csv").toLowerCase();
  if (!["csv", "json"].includes(format)) {
    res.status(400).json({ error: 'format must be "csv" or "json"' });
    return null;
  }
  return format;
};

// Safe file-name fragment (jobId is a UUID, but never trust a path param in a header).
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "");

// ── Get transactions for a job ────────────────────────────────────────────
router.get("/job/:jobId", authenticate, async (req, res) => {
  try {
    const jobId = str(req.params.jobId);
    const page = int(req.query.page, 1, 1, 1e6);
    const limit = int(req.query.limit, 50, 1, MAX_PAGE_SIZE);
    const filter = str(req.query.filter);
    const search = str(req.query.search);

    const query = riskFilter({ jobId }, filter);
    if (search) {
      const rx = { $regex: escapeRegex(search.slice(0, 100)), $options: "i" };
      query.$or = [
        { transactionId: rx },
        { account: rx },
        { fraudCategory: rx },
      ];
    }

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .sort({ riskScore: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(query),
    ]);
    res.json({ transactions, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single transaction with SHAP details ──────────────────────────────────
// jobId is required: transactionId is only unique within a job.
router.get("/transaction/:transactionId", authenticate, async (req, res) => {
  try {
    const jobId = str(req.query.jobId);
    if (!jobId)
      return res.status(400).json({ error: "jobId query param is required" });
    const tx = await Transaction.findOne({
      transactionId: str(req.params.transactionId),
      jobId,
    }).lean();
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    res.json(tx);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-16: export anomaly results (streamed) ──────────────────────────────
// GET /api/analysis/job/:jobId/export?format=csv|json&filter=fraud|critical|high
const TX_COLUMNS = [
  "transactionId",
  "timestamp",
  "fromBank",
  "account",
  "toBank",
  "toAccount",
  "amountPaid",
  "paymentCurrency",
  "amountReceived",
  "receivingCurrency",
  "paymentFormat",
  "riskScore",
  "riskLevel",
  "isFraud",
  "isolationForestScore",
  "autoencoderScore",
  "fraudCategory",
];
router.get("/job/:jobId/export", authenticate, async (req, res) => {
  try {
    const format = parseFormat(req, res);
    if (!format) return;
    const jobId = str(req.params.jobId);
    const query = riskFilter({ jobId }, str(req.query.filter));
    setDownload(res, format, `deepguard_export_${safeName(jobId)}`);
    const cursor = Transaction.find(query)
      .sort({ riskScore: -1 })
      .lean()
      .cursor();
    await streamCursor(res, cursor, format, TX_COLUMNS);
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    res.end();
  }
});

// ── FR-16: export network graph data (edges between accounts of flagged txns) ─
// GET /api/analysis/job/:jobId/export/network?format=csv|json
const EDGE_COLUMNS = [
  "source",
  "target",
  "transactionId",
  "amountPaid",
  "paymentCurrency",
  "paymentFormat",
  "riskScore",
  "riskLevel",
  "fraudCategory",
];
router.get("/job/:jobId/export/network", authenticate, async (req, res) => {
  try {
    const format = parseFormat(req, res);
    if (!format) return;
    const jobId = str(req.params.jobId);
    setDownload(res, format, `deepguard_network_${safeName(jobId)}`);
    const cursor = Transaction.aggregate([
      { $match: { jobId, isFraud: true } },
      { $sort: { riskScore: -1 } },
      { $limit: 50000 },
      {
        $project: {
          _id: 0,
          source: "$account",
          target: "$toAccount",
          transactionId: 1,
          amountPaid: 1,
          paymentCurrency: 1,
          paymentFormat: 1,
          riskScore: 1,
          riskLevel: 1,
          fraudCategory: 1,
        },
      },
    ]).cursor();
    await streamCursor(res, cursor, format, EDGE_COLUMNS);
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    res.end();
  }
});

// ── FR-16: export performance analytics for a job ─────────────────────────
// GET /api/analysis/job/:jobId/export/analytics?format=csv|json
router.get("/job/:jobId/export/analytics", authenticate, async (req, res) => {
  try {
    const format = parseFormat(req, res);
    if (!format) return;
    const jobId = str(req.params.jobId);
    const job = await Job.findOne({ jobId }).lean();
    if (!job) return res.status(404).json({ error: "Job not found" });
    const row = {
      jobId: job.jobId,
      fileName: job.originalName,
      status: job.status,
      totalTransactions: job.totalTransactions,
      flaggedCount: job.flaggedCount,
      criticalCount: job.criticalCount,
      cleanCount: job.cleanCount,
      averageRiskScore: job.averageRiskScore,
      processingTimeMs: job.processingTimeMs,
      createdAt: job.createdAt,
    };
    setDownload(res, format, `deepguard_analytics_${safeName(jobId)}`);
    if (format === "json") return res.json(row);
    const cols = Object.keys(row);
    res.send(
      cols.join(",") + "\n" + cols.map((c) => csvCell(row[c])).join(",") + "\n",
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
