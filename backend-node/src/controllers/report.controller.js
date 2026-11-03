const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
const Transaction = require("../models/Transaction.model");
const Job = require("../models/Job.model");

const SHARED_HISTORY = process.env.SHARED_HISTORY !== "false";

// Everything that comes from an uploaded file (account ids, formats, file name...) is
// untrusted and ends up inside HTML rendered by headless Chromium: escape it.
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n) =>
  (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) : "0.0");

// HMAC key: a server-side secret, so a signature can't be forged by someone who can only edit the DB.
const SIGNING_KEY =
  process.env.REPORT_SIGNING_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  "deepguard-dev-signing-key";
const sign = (hash, at) =>
  crypto
    .createHmac("sha256", SIGNING_KEY)
    .update(`${hash}|${new Date(at).toISOString()}`)
    .digest("hex");

// Chromium is heavy: render one PDF at a time, queue the rest.
let pdfChain = Promise.resolve();
const exclusive = (fn) => {
  const run = pdfChain.then(fn, fn);
  pdfChain = run.catch(() => {});
  return run;
};

const REPORTS_DIR = path.join(__dirname, "../../reports");
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ─────────────────────────────────────────────
// FREE AI: Groq (free tier) or Ollama (local)
// Falls back gracefully if unavailable
// ─────────────────────────────────────────────
async function generateAISummary(jobSummary, topFrauds) {
  const prompt = `You are a financial forensics AI assistant. Write a professional, concise audit summary (150 words max) for the following fraud detection results:

Total Transactions: ${jobSummary.totalTransactions}
Flagged as Fraud: ${jobSummary.flaggedCount} (${pct(jobSummary.flaggedCount, jobSummary.totalTransactions)}%)
Critical Risk: ${jobSummary.criticalCount}
Average Risk Score: ${jobSummary.averageRiskScore}/100

Top Fraud Categories: ${topFrauds.map((f) => f.fraudCategory).join(", ")}

Write a professional forensic audit summary with key findings and recommendations.`;

  // Option 1: Groq (FREE — fastest)
  if (process.env.GROQ_API_KEY) {
    try {
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 250,
          temperature: 0.3,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );
      return response.data.choices[0].message.content;
    } catch (err) {
      console.warn("Groq API failed:", err.message);
    }
  }

  // Option 2: Ollama (local, completely free)
  if (process.env.OLLAMA_URL) {
    try {
      const response = await axios.post(
        `${process.env.OLLAMA_URL}/api/generate`,
        {
          model: process.env.OLLAMA_MODEL || "llama3",
          prompt,
          stream: false,
          options: { num_predict: 250, temperature: 0.3 },
        },
        { timeout: 60000 },
      );
      return response.data.response;
    } catch (err) {
      console.warn("Ollama failed:", err.message);
    }
  }

  // Option 3: OpenAI (paid, optional)
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 250,
          temperature: 0.3,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        },
      );
      return response.data.choices[0].message.content;
    } catch (err) {
      console.warn("OpenAI failed:", err.message);
    }
  }

  // Fallback: rule-based summary
  const riskRating =
    jobSummary.averageRiskScore > 60
      ? "HIGH"
      : jobSummary.averageRiskScore > 30
        ? "MEDIUM"
        : "LOW";
  return `FORENSIC AUDIT SUMMARY — DeepGuard AI Analysis

Overall Risk Rating: ${riskRating}

This analysis examined ${jobSummary.totalTransactions.toLocaleString()} financial transactions. ${jobSummary.flaggedCount} transactions (${((jobSummary.flaggedCount / Math.max(jobSummary.totalTransactions, 1)) * 100).toFixed(1)}%) were flagged as potentially fraudulent, with ${jobSummary.criticalCount} classified as critical risk.

${jobSummary.flaggedCount > 0 ? "The flagged transactions, their risk scores, the model features that drove each decision (SHAP) and the accounts they connect are listed in the sections below." : "No transaction exceeded the fraud threshold in this batch."}\n\nRecommendation: ${jobSummary.criticalCount > 0 ? "investigate all critical-risk transactions first. Use the interactive network view in DeepGuard to trace connected accounts." : "review the highest-scoring transactions listed below; no critical-risk items were found."}\n\nThis report was generated by DeepGuard AI (Autoencoder + XGBoost detector with an Isolation Forest anomaly signal) with SHAP explainability.`;
}

/**
 * ─────────────────────────────────────────────
 * FR-11 (Generate Forensic Report) — the SRS's own business rule reads:
 * "Reports include digital signatures and timestamps to ensure
 * non-editability." A plain PDF can't literally be made uneditable, but we
 * CAN give it a verifiable, tamper-evident fingerprint: a SHA-256 hash of
 * the exact evidence data (job summary + every flagged transaction listed
 * in the report), computed BEFORE the PDF is rendered, printed in the PDF
 * footer, AND stored server-side against the job. Anyone holding a copy of
 * the report can call GET /api/reports/verify/:jobId and compare — a
 * mismatch proves the evidence was altered after the fact (or that the PDF
 * they're holding wasn't actually produced by DeepGuard for this job).
 * ─────────────────────────────────────────────
 */
function computeEvidenceHash(job, topFrauds) {
  const evidence = {
    jobId: job.jobId,
    originalName: job.originalName,
    totalTransactions: job.totalTransactions,
    flaggedCount: job.flaggedCount,
    criticalCount: job.criticalCount,
    averageRiskScore: job.averageRiskScore,
    topFrauds: topFrauds.map((t) => ({
      id: t.transactionId,
      risk: t.riskScore,
      level: t.riskLevel,
      category: t.fraudCategory,
    })),
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex");
}

/**
 * Build HTML report template
 */
function buildReportHTML(
  job,
  categoryCounts,
  aiSummary,
  topFrauds,
  evidenceHash,
  extras = {},
) {
  const date = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const categoryRows = categoryCounts
    .map(
      ({ _id: cat, count }) => `
      <tr>
        <td>${esc(cat)}</td>
        <td>${count}</td>
        <td>${pct(count, job.flaggedCount)}%</td>
      </tr>`,
    )
    .join("");

  const transactionRows = topFrauds
    .slice(0, 50)
    .map(
      (tx, i) => `
    <tr class="${tx.riskLevel === "Critical" ? "critical" : tx.riskLevel === "High" ? "high" : ""}">
      <td>${i + 1}</td>
      <td class="mono">${esc(tx.transactionId)}</td>
      <td class="mono">${esc(tx.account) || "—"}</td>
      <td class="mono">${esc(tx.toAccount) || "—"}</td>
      <td>${money(tx.amountPaid)} ${esc(tx.paymentCurrency)}</td>
      <td>${esc(tx.paymentFormat) || "—"}</td>
      <td>
        <span class="badge badge-${esc(tx.riskLevel).toLowerCase()}">
          ${(tx.riskScore || 0).toFixed(1)}/100
        </span>
      </td>
      <td><span class="badge badge-${esc(tx.riskLevel).toLowerCase()}">${esc(tx.riskLevel)}</span></td>
      <td>${esc(tx.fraudCategory)}</td>
    </tr>`,
    )
    .join("");

  // ── SHAP: average share of influence per feature across the listed transactions ──
  const featTotals = {};
  topFrauds.forEach((t) =>
    Object.entries(t.shapValues || {}).forEach(([k, v]) => {
      featTotals[k] = (featTotals[k] || 0) + (Number(v) || 0);
    }),
  );
  const featSum = Object.values(featTotals).reduce((a, b) => a + b, 0) || 1;
  const featTop = Object.entries(featTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxShare = featTop.length ? featTop[0][1] / featSum : 1;
  const shapBars =
    featTop
      .map(
        ([k, v]) => `
      <div style="display:flex;align-items:center;margin:4px 0;font-size:11px;">
        <div style="width:190px;">${esc(k)}</div>
        <div style="flex:1;background:#e5e7eb;height:12px;border-radius:3px;">
          <div style="width:${((v / featSum / maxShare) * 100).toFixed(1)}%;background:#2563eb;height:12px;border-radius:3px;"></div>
        </div>
        <div style="width:54px;text-align:right;">${((v / featSum) * 100).toFixed(1)}%</div>
      </div>`,
      )
      .join("") ||
    "<p>No feature-importance data was stored for this analysis.</p>";

  const driverRows = topFrauds
    .slice(0, 15)
    .map((t, i) => {
      const top = Object.entries(t.shapValues || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${esc(k)} (${(Number(v) * 100).toFixed(0)}%)`)
        .join(", ");
      return `<tr><td>${i + 1}</td><td class="mono">${esc(t.transactionId)}</td><td>${top || "—"}</td></tr>`;
    })
    .join("");

  // ── Network: accounts that appear most among flagged transactions + 2-way flows ──
  const netRows = (extras.accounts || [])
    .map(
      (a) => `
    <tr><td class="mono">${esc(a._id)}</td><td>${a.flaggedCount}</td><td>${a.counterparties}</td><td>${money(a.totalAmount)}</td></tr>`,
    )
    .join("");
  const recip = (extras.reciprocal || [])
    .map(
      (r) =>
        `<tr><td class="mono">${esc(r[0])}</td><td class="mono">${esc(r[1])}</td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepGuard Forensic Audit Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a2e; background: #fff; font-size: 12px; }
  
  .header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); color: white; padding: 32px 40px; }
  .header-top { display: flex; justify-content: space-between; align-items: flex-start; }
  .logo { display: flex; align-items: center; gap: 12px; }
  .logo-shield { font-size: 36px; }
  .logo-text h1 { font-size: 28px; font-weight: 800; letter-spacing: 1px; color: #38bdf8; }
  .logo-text p { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .report-meta { text-align: right; }
  .report-meta p { font-size: 11px; color: #94a3b8; margin-bottom: 3px; }
  .report-meta strong { color: white; }
  .header-divider { border-top: 1px solid #334155; margin: 20px 0; }
  .header h2 { font-size: 16px; color: #e2e8f0; font-weight: 500; }
  
  .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-45deg);
    font-size: 80px; font-weight: 900; color: rgba(56, 189, 248, 0.04); z-index: 0; white-space: nowrap; }
  
  .content { padding: 30px 40px; position: relative; z-index: 1; }
  
  .section { margin-bottom: 28px; }
  .section-title { font-size: 14px; font-weight: 700; color: #0f172a; 
    border-left: 4px solid #38bdf8; padding-left: 10px; margin-bottom: 14px; 
    text-transform: uppercase; letter-spacing: 0.5px; }
  
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px; }
  .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; text-align: center; }
  .stat-card.danger { border-color: #fca5a5; background: #fff5f5; }
  .stat-card.warning { border-color: #fcd34d; background: #fffbeb; }
  .stat-card.success { border-color: #86efac; background: #f0fdf4; }
  .stat-card.info { border-color: #93c5fd; background: #eff6ff; }
  .stat-value { font-size: 28px; font-weight: 800; }
  .stat-value.red { color: #dc2626; }
  .stat-value.yellow { color: #d97706; }
  .stat-value.green { color: #16a34a; }
  .stat-value.blue { color: #2563eb; }
  .stat-label { font-size: 10px; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  
  .ai-summary { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 18px; }
  .ai-summary p { line-height: 1.7; color: #0c4a6e; white-space: pre-wrap; font-size: 11.5px; }
  .ai-badge { display: inline-block; background: #0ea5e9; color: white; padding: 2px 8px; 
    border-radius: 4px; font-size: 9px; margin-bottom: 8px; font-weight: 600; letter-spacing: 1px; }
  
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th { background: #1e3a5f; color: white; padding: 8px 10px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; }
  td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; }
  tr:nth-child(even) { background: #f8fafc; }
  tr.critical td { background: #fff1f2 !important; }
  tr.high td { background: #fffbeb !important; }
  
  .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-weight: 600; font-size: 10px; }
  .badge-critical { background: #fee2e2; color: #dc2626; }
  .badge-high { background: #fef3c7; color: #d97706; }
  .badge-medium { background: #dbeafe; color: #2563eb; }
  .badge-low { background: #dcfce7; color: #16a34a; }
  
  .mono { font-family: 'Courier New', monospace; font-size: 10px; }
  
  .footer { background: #0f172a; color: #64748b; padding: 18px 40px; margin-top: 30px;
    display: flex; justify-content: space-between; align-items: center; font-size: 10px; }
  .footer-logo { color: #38bdf8; font-weight: 700; font-size: 12px; }
  
  .disclaimer { background: #fefce8; border: 1px solid #fde68a; border-radius: 6px; 
    padding: 12px 16px; font-size: 10px; color: #92400e; margin-top: 20px; }
  
  @media print {
    .content { padding: 20px 30px; }
    .header { padding: 20px 30px; }
  }
</style>
</head>
<body>

<div class="watermark">CONFIDENTIAL</div>

<!-- Header -->
<div class="header">
  <div class="header-top">
    <div class="logo">
      <div class="logo-shield">🛡️</div>
      <div class="logo-text">
        <h1>DEEPGUARD</h1>
        <p>AI-Driven Financial Forensics Platform</p>
      </div>
    </div>
    <div class="report-meta">
      <p>Report Type: <strong>Forensic Audit Report</strong></p>
      <p>Generated: <strong>${date}</strong></p>
      <p>File: <strong>${esc(job.originalName)}</strong></p>
      <p>Job ID: <strong>${esc(job.jobId)}</strong></p>
      <p>Classification: <strong style="color:#f87171">CONFIDENTIAL</strong></p>
    </div>
  </div>
  <div class="header-divider"></div>
  <h2>Financial Transaction Anomaly Detection — Automated Forensic Report</h2>
</div>

<div class="content">

  <!-- Executive Summary Stats -->
  <div class="section">
    <div class="section-title">Executive Summary</div>
    <div class="stats-grid">
      <div class="stat-card info">
        <div class="stat-value blue">${job.totalTransactions?.toLocaleString()}</div>
        <div class="stat-label">Total Transactions</div>
      </div>
      <div class="stat-card danger">
        <div class="stat-value red">${job.flaggedCount?.toLocaleString()}</div>
        <div class="stat-label">Flagged as Fraud</div>
      </div>
      <div class="stat-card warning">
        <div class="stat-value yellow">${job.criticalCount?.toLocaleString()}</div>
        <div class="stat-label">Critical Risk</div>
      </div>
      <div class="stat-card success">
        <div class="stat-value green">${job.averageRiskScore?.toFixed(1)}/100</div>
        <div class="stat-label">Avg Risk Score</div>
      </div>
    </div>
  </div>

  <!-- AI Summary -->
  <div class="section">
    <div class="section-title">AI-Generated Forensic Summary</div>
    <div class="ai-summary">
      <div class="ai-badge">✦ AI GENERATED</div>
      <p>${esc(aiSummary).replace(/\n/g, "<br/>")}</p>
    </div>
  </div>

  <!-- Fraud Categories -->
  <div class="section">
    <div class="section-title">Fraud Category Breakdown</div>
    <table>
      <thead>
        <tr><th>Category</th><th>Count</th><th>% of Flagged</th></tr>
      </thead>
      <tbody>${categoryRows}</tbody>
    </table>
  </div>

  <!-- Top Flagged Transactions -->
  <div class="section">
    <div class="section-title">Top Flagged Transactions (Top 50)</div>
    <table>
      <thead>
        <tr>
          <th>#</th><th>Transaction ID</th><th>Sender Account</th><th>Receiver Account</th>
          <th>Amount</th><th>Payment Format</th><th>Risk Score</th><th>Risk Level</th><th>Category</th>
        </tr>
      </thead>
      <tbody>${transactionRows}</tbody>
    </table>
  </div>

  <!-- SHAP -->
  <div class="section">
    <div class="section-title">Explainable AI — What Drove the Flags (SHAP)</div>
    <p style="margin-bottom:6px;">Average share of influence of each feature over the ${topFrauds.length} highest-risk flagged transactions listed in this report.</p>
    ${shapBars}
    <table style="margin-top:10px;">
      <thead><tr><th>#</th><th>Transaction ID</th><th>Top 3 features for this transaction</th></tr></thead>
      <tbody>${driverRows}</tbody>
    </table>
  </div>

  <!-- Network -->
  <div class="section">
    <div class="section-title">Connected Accounts (flagged transactions)</div>
    <table>
      <thead><tr><th>Sender Account</th><th>Flagged Txns</th><th>Distinct Receivers</th><th>Total Amount (mixed currencies)</th></tr></thead>
      <tbody>${netRows || '<tr><td colspan="4">No flagged accounts.</td></tr>'}</tbody>
    </table>
    ${
      recip
        ? `<p style="margin:8px 0 4px;"><strong>Two-way flows</strong> — account pairs that sent flagged funds to each other (possible round-tripping):</p>
    <table><thead><tr><th>Account A</th><th>Account B</th></tr></thead><tbody>${recip}</tbody></table>`
        : ""
    }
    <p style="margin-top:6px;">Use the Network Graph view in DeepGuard to explore the full multi-hop trail for any transaction.</p>
  </div>

  <!-- Disclaimer -->
  <div class="disclaimer">
    <strong>⚠️ Disclaimer:</strong> This report is generated by DeepGuard AI using machine learning models 
    (Autoencoder + XGBoost, with an Isolation Forest anomaly signal). Results are for investigative purposes only and should be reviewed by 
    qualified financial forensics professionals before legal action. AI-detected anomalies are not definitive evidence 
    of fraud without human verification. DeepGuard — Iqra University FYP 2026.
  </div>

  <!-- Evidence Integrity Hash (FR-11) -->
  <div class="disclaimer" style="background:#f0f9ff;border-color:#bae6fd;color:#0c4a6e;">
    <strong>🔒 Evidence Integrity Hash (SHA-256):</strong><br/>
    <span class="mono" style="word-break:break-all;font-size:9.5px;">${evidenceHash}</span><br/>
    <strong>Server signature (HMAC-SHA256):</strong> <span class="mono" style="word-break:break-all;font-size:9.5px;">${esc(extras.signature)}</span><br/>
    Generated at (UTC): <span class="mono">${esc(extras.generatedAtIso)}</span><br/>
    This fingerprint covers the job summary and every flagged transaction listed above, computed at generation time.
    Verify it via <span class="mono">GET /api/reports/verify/${esc(job.jobId)}?hash=&lt;hash&gt;&amp;signature=&lt;signature&gt;</span> — a mismatch
    means the evidence differs from what DeepGuard originally recorded for this job.
  </div>

</div>

<!-- Footer -->
<div class="footer">
  <div>
    <div class="footer-logo">🛡️ DEEPGUARD</div>
    <div>AI Financial Forensics Platform | Iqra University CS Batch 2023</div>
  </div>
  <div style="text-align:right">
    <div>Processing Time: ${job.processingTimeMs ? (job.processingTimeMs / 1000).toFixed(2) + "s" : "N/A"}</div>
    <div>Models: Autoencoder + XGBoost (+ Isolation Forest signal, optional GNN) + SHAP XAI</div>
  </div>
</div>

</body>
</html>`;
}

/** Render HTML → PDF with a locked-down headless Chromium. Always closes the browser. */
async function renderPdf(html, reportPath) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  try {
    const page = await browser.newPage();
    // The report is static HTML: no scripts, and no network / file access at all.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (r) =>
      r.url().startsWith("data:") || r.url() === "about:blank"
        ? r.continue()
        : r.abort(),
    );
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    await page.pdf({
      path: reportPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Data the report needs beyond the top-N table, computed in the database (not in Node memory). */
async function loadReportData(jobId) {
  const [categoryCounts, accounts, edges] = await Promise.all([
    Transaction.aggregate([
      { $match: { jobId, isFraud: true } },
      { $group: { _id: "$fraudCategory", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Transaction.aggregate([
      { $match: { jobId, isFraud: true } },
      {
        $group: {
          _id: "$account",
          flaggedCount: { $sum: 1 },
          receivers: { $addToSet: "$toAccount" },
          totalAmount: { $sum: "$amountPaid" },
        },
      },
      {
        $project: {
          flaggedCount: 1,
          totalAmount: 1,
          counterparties: { $size: "$receivers" },
        },
      },
      { $sort: { flaggedCount: -1, totalAmount: -1 } },
      { $limit: 10 },
    ]).allowDiskUse(true),
    Transaction.find({ jobId, isFraud: true })
      .sort({ riskScore: -1 })
      .limit(5000)
      .select("account toAccount")
      .lean(),
  ]);
  // Reciprocal pairs (A→B and B→A) among the riskiest flagged edges
  const seen = new Set();
  const reciprocal = [];
  const done = new Set();
  for (const e of edges) {
    if (!e.account || !e.toAccount || e.account === e.toAccount) continue;
    if (seen.has(`${e.toAccount}>${e.account}`)) {
      const key = [e.account, e.toAccount].sort().join("|");
      if (!done.has(key)) {
        done.add(key);
        reciprocal.push([e.account, e.toAccount]);
      }
    }
    seen.add(`${e.account}>${e.toAccount}`);
    if (reciprocal.length >= 10) break;
  }
  return { categoryCounts, accounts, reciprocal };
}

/**
 * Generate PDF report for a completed job
 */
const generateReport = async (req, res) => {
  let reportPath;
  try {
    const jobId = String(req.params.jobId);

    // Same visibility rule as the rest of the app (SHARED_HISTORY) — reports used to be
    // limited to the uploader even though everybody could see the job on the dashboard.
    const job = await Job.findOne(
      SHARED_HISTORY ? { jobId } : { jobId, userId: req.userId },
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "completed") {
      return res
        .status(400)
        .json({ error: `Job status is ${job.status}, not completed` });
    }

    const topFrauds = await Transaction.find({ jobId, isFraud: true })
      .sort({ riskScore: -1 })
      .limit(100)
      .lean();
    const data = await loadReportData(jobId);
    const aiSummary = await generateAISummary(job, topFrauds.slice(0, 10));

    // FR-11 — evidence hash (data) + server HMAC signature over hash and timestamp
    const evidenceHash = computeEvidenceHash(job, topFrauds);
    const reportGeneratedAt = new Date();
    const signature = sign(evidenceHash, reportGeneratedAt);

    const html = buildReportHTML(
      job,
      data.categoryCounts,
      aiSummary,
      topFrauds,
      evidenceHash,
      {
        accounts: data.accounts,
        reciprocal: data.reciprocal,
        signature,
        generatedAtIso: reportGeneratedAt.toISOString(),
      },
    );

    const reportFileName = `deepguard_report_${jobId.replace(/[^A-Za-z0-9_-]/g, "")}_${Date.now()}.pdf`;
    reportPath = path.join(REPORTS_DIR, reportFileName);
    await exclusive(() => renderPdf(html, reportPath));

    await Job.findOneAndUpdate(
      { jobId },
      {
        reportUrl: reportFileName,
        reportHash: evidenceHash,
        reportGeneratedAt,
        reportSignature: signature,
      },
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="DeepGuard_Forensic_Report_${jobId.replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`,
    );
    res.setHeader("X-Report-Evidence-SHA256", evidenceHash);
    res.setHeader("X-Report-Signature", signature);
    const stream = fs.createReadStream(reportPath);
    const cleanup = () => fs.unlink(reportPath, () => {});
    stream.on("end", cleanup);
    stream.on("error", cleanup);
    res.on("close", cleanup);
    stream.pipe(res);
  } catch (err) {
    console.error("Report generation error:", err);
    if (reportPath) fs.unlink(reportPath, () => {});
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};

/**
 * FR-11 (continued) — GET /api/reports/verify/:jobId[?hash=...&signature=...]
 *  - recomputes the evidence hash from the CURRENT data and compares it with what was recorded when
 *    the report was generated (detects tampering with the stored findings);
 *  - if the caller passes the hash/signature printed in their PDF copy, also checks those against the
 *    server's records (detects an edited or forged PDF).
 */
const verifyReport = async (req, res) => {
  try {
    const jobId = String(req.params.jobId);
    const job = await Job.findOne({ jobId }).lean();
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!job.reportHash) {
      return res
        .status(404)
        .json({ error: "No report has been generated for this job yet" });
    }
    const topFrauds = await Transaction.find({ jobId, isFraud: true })
      .sort({ riskScore: -1 })
      .limit(100)
      .lean();
    const currentHash = computeEvidenceHash(job, topFrauds);
    const signatureValid =
      !!job.reportSignature &&
      sign(job.reportHash, job.reportGeneratedAt) === job.reportSignature;
    const out = {
      jobId,
      evidenceHash: job.reportHash,
      reportGeneratedAt: job.reportGeneratedAt,
      dataUnchangedSinceReport: currentHash === job.reportHash,
      serverSignatureValid: signatureValid,
    };
    if (typeof req.query.hash === "string")
      out.pdfHashMatches =
        req.query.hash.trim().toLowerCase() === job.reportHash;
    if (typeof req.query.signature === "string")
      out.pdfSignatureMatches =
        req.query.signature.trim().toLowerCase() === job.reportSignature;
    out.note =
      "dataUnchangedSinceReport=false means the stored findings differ from what the report was generated from. pdfHashMatches / pdfSignatureMatches compare the values printed in your PDF copy with the server record.";
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  generateReport,
  verifyReport,
  _internals: { buildReportHTML, esc },
};
