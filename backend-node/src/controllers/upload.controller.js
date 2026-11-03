const multer = require("multer");
const csv = require("csv-parser");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const http = require("http");
const Transaction = require("../models/Transaction.model");
const Job = require("../models/Job.model");
const { createUploadQueue } = require("../queue/uploadQueue");
const {
  createAccumulator,
  addResults,
  finalize: finalizeSummary,
} = require("../services/jobSummary.service");
const overviewCache = require("../services/overviewCache");
const {
  notifyJobCompleted,
  notifyJobFailed,
} = require("../services/email.service");

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || "http://127.0.0.1:8000";
// Send to the AI engine in chunks. The v2 models use each account's PAST activity as features; the engine keeps a rolling
// per-job history, so chunks must be sent in TIME ORDER with the same jobId (done below).
// Every chunk makes the engine rebuild the features over its whole rolling history (up to CONTEXT_ROWS rows) plus the
// new rows, so FEWER, LARGER chunks cut that repeated work (measured on features.py: a 300k-row file spends ~14 s on it
// at 20k per chunk but ~6 s at 50k). Override with BATCH_SIZE in .env if memory is tight.
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50000", 10);
// Mongo writes are split into chunks of this many documents so no single insert freezes the event loop for long.
const INSERT_CHUNK = parseInt(process.env.INSERT_CHUNK || "10000", 10);

// Shared history: every signed-in user can see the analyses done so far (the analysis / graph / report routes
// already work that way). Set SHARED_HISTORY=false in .env to restrict jobs to the account that uploaded them.
const SHARED_HISTORY = process.env.SHARED_HISTORY !== "false";

// Dedicated axios client for the AI Engine with HTTP keep-alive DISABLED.
// WHY: between batches this process does heavy synchronous work (building 20k documents + Mongo insertMany), which blocks
// the event loop. uvicorn closes idle keep-alive connections after ~5 s, but while the loop is blocked Node cannot notice
// the closed socket, so the next batch is written to a dead connection -> "read ECONNRESET" / "socket hang up".
// This only shows up on multi-batch (large) files. A fresh connection per batch avoids it.
const aiClient = axios.create({
  baseURL: AI_ENGINE_URL,
  httpAgent: new http.Agent({ keepAlive: false }),
  timeout: 300000, // 5 min timeout for large batches
  maxBodyLength: Infinity, // a 50k-row request is ~15 MB and its response ~30 MB
  maxContentLength: Infinity,
});

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../../uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = [".csv", ".xlsx", ".xls"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only CSV, XLSX, and XLS files are allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
}).single("file");

/**
 * The original Kaggle IBM-AML files have TWO columns literally named "Account"
 * (sender, then receiver). csv-parser silently overwrites the first with the
 * second, which loses the sender and makes the file fail validation. Rename
 * repeated headers pandas-style ("Account", "Account.1", ...) and strip any BOM.
 */
function csvOptions() {
  const seen = {};
  return {
    mapHeaders: ({ header }) => {
      const h = String(header)
        .replace(/^\uFEFF/, "")
        .trim();
      seen[h] = (seen[h] || 0) + 1;
      return seen[h] === 1 ? h : `${h}.${seen[h] - 1}`;
    },
  };
}

/**
 * Excel stores dates as serial numbers (e.g. 44805.0138). Convert those (and
 * Date objects) to "YYYY/MM/DD HH:mm" which the AI engine and Mongo both parse.
 */
function normalizeTimestamp(v) {
  if (v === undefined || v === null || v === "")
    return new Date().toISOString();
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) =>
    `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (v instanceof Date) return fmt(v);
  const n =
    typeof v === "number"
      ? v
      : /^\d+(\.\d+)?$/.test(String(v).trim())
        ? Number(v)
        : NaN;
  if (!Number.isNaN(n) && n > 20000 && n < 80000) {
    return fmt(new Date(Math.round((n - 25569) * 86400 * 1000)));
  }
  return String(v);
}

/** Read a column by any of several header spellings (CSV "Account.1", XLSX "Account_1"). */
const pick = (row, keys) => {
  for (const k of keys)
    if (row[k] !== undefined && row[k] !== "") return row[k];
  return undefined;
};

/**
 * Parse IBM AML CSV/XLSX into transaction objects
 */
function parseIBMAMLRow(row, idx) {
  // IBM AML columns: Timestamp, From Bank, Account, To Bank, Account.1,
  // Amount Received, Receiving Currency, Amount Paid, Payment Currency,
  // Payment Format, Is Laundering
  // Excel hands back numbers for cells like From Bank / all-digit account ids, but the AI engine
  // expects text there (it would reject the WHOLE batch with a 422) — so ids are always strings.
  // Amounts must be finite and >= 0 for the same reason (one bad row must not sink a 100 MB job).
  const text = (v, def = "") =>
    v === undefined || v === null || v === "" ? def : String(v).trim();
  const amount = (v) => {
    const n = parseFloat(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const flag = parseInt(pick(row, ["Is Laundering", "is_laundering"]), 10);
  return {
    transaction_id: text(pick(row, ["Transaction ID", "Id"]), `TX-${idx + 1}`),
    timestamp: normalizeTimestamp(pick(row, ["Timestamp", "timestamp"])),
    from_bank: text(pick(row, ["From Bank", "from_bank"])),
    account: text(pick(row, ["Account", "account"])),
    to_bank: text(pick(row, ["To Bank", "to_bank"])),
    to_account: text(
      pick(row, ["Account.1", "Account_1", "to_account", "ToAccount"]),
    ),
    amount_paid: amount(pick(row, ["Amount Paid", "amount_paid"])),
    payment_currency: text(
      pick(row, ["Payment Currency", "payment_currency"]),
      "USD",
    ),
    amount_received: amount(pick(row, ["Amount Received", "amount_received"])),
    receiving_currency: text(
      pick(row, ["Receiving Currency", "receiving_currency"]),
      "USD",
    ),
    payment_format: text(
      pick(row, ["Payment Format", "payment_format"]),
      "Wire",
    ),
    is_laundering: Number.isFinite(flag) ? flag : 0,
  };
}

/**
 * Validate that an uploaded file actually looks like IBM-AML-style transaction
 * data before we spend any time processing it. Catches the "wrong dataset
 * entirely" case (e.g. someone uploads a hotel-bookings CSV, a sales CSV, etc.)
 * up front with a clear, specific error — instead of silently defaulting every
 * unrecognized column to 0/empty and producing a job that "completes" with
 * meaningless all-zero transactions.
 */
function validateAMLSchema(rawRows) {
  if (!rawRows || rawRows.length === 0) {
    return {
      valid: false,
      error: "The file is empty — no rows were found to process.",
    };
  }

  const headers = Object.keys(rawRows[0]);
  const has = (aliases) => aliases.some((a) => headers.includes(a));

  const checks = [
    { label: "a sender account column", aliases: ["Account", "account"] },
    {
      label: "a receiver account column",
      aliases: ["Account.1", "Account_1", "to_account", "ToAccount"],
    },
    {
      label: "an amount column",
      aliases: [
        "Amount Paid",
        "amount_paid",
        "Amount Received",
        "amount_received",
      ],
    },
  ];

  const missing = checks.filter((c) => !has(c.aliases));

  if (missing.length > 0) {
    const missingLabels = missing.map((m) => m.label).join(", ");
    const foundPreview =
      headers.slice(0, 8).join(", ") + (headers.length > 8 ? ", …" : "");
    return {
      valid: false,
      error:
        `This doesn't look like an IBM-AML-style transaction file — missing ${missingLabels}. ` +
        `Expected columns like "Account", "Account.1", "Amount Paid", "Amount Received", "Payment Format". ` +
        `Found instead: ${foundPreview}. Make sure you're uploading the transaction dataset ` +
        `(e.g. HI-Small_Trans.csv), not a different file.`,
    };
  }

  return { valid: true, error: null };
}

/**
 * Order transactions by timestamp (stable) before they are sent to the AI engine in chunks.
 *
 * WHY: the DeepGuard models (see ai-engine/features.py) score each transaction using the earlier activity of its
 * sender/receiver. The engine computes those history features itself — it keeps a rolling per-job context — but that only
 * works if chunks arrive in chronological order. (The old per-account aggregates that used to be computed here are no longer
 * needed: the v1 model took them as inputs, the v2 engine ignores them.)
 *
 * Unparseable timestamps inherit the previous valid one so those rows keep their position in the file.
 */
function sortByTimestamp(transactions) {
  let last = 0;
  const keyed = transactions.map((tx, i) => {
    let t = Date.parse(
      String(tx.timestamp || "")
        .replace(/\//g, "-")
        .replace(" ", "T"),
    );
    if (Number.isNaN(t)) t = Date.parse(tx.timestamp);
    if (Number.isNaN(t)) t = last;
    else last = t;
    return { tx, t, i };
  });
  keyed.sort((a, b) => a.t - b.t || a.i - b.i);
  return keyed.map((k) => k.tx);
}

/**
 * Parse CSV file
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv(csvOptions()))
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

/**
 * Parse XLSX/XLS file
 */
function parseXLSX(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

/**
 * Send batch to AI Engine
 * `useGnn` asks the engine to also score with the GNN (silently ignored by
 * the engine if the GNN isn't installed/loaded — see GET /models/gnn/status).
 */
async function sendToAIEngine(transactions, jobId, useGnn = false) {
  const response = await aiClient.post("/analyze/batch", {
    transactions,
    job_id: jobId,
    use_gnn: !!useGnn,
  });
  return response.data;
}

/**
 * Read just the first few rows of a file — enough to validate its schema
 * without parsing the whole thing twice (the queue worker does the full parse).
 */
function peekRows(filePath, ext, maxRows = 5) {
  if (ext !== ".csv")
    return Promise.resolve(parseXLSX(filePath).slice(0, maxRows));
  return new Promise((resolve, reject) => {
    const rows = [];
    let settled = false;
    const stream = fs.createReadStream(filePath);
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(rows.slice(0, maxRows));
    };
    stream
      .pipe(csv(csvOptions()))
      .on("data", (row) => {
        if (settled) return;
        rows.push(row);
        if (rows.length >= maxRows) finish();
      })
      .on("end", finish)
      .on("error", (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
  });
}

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Turn engine results [from, to) of a batch into Transaction documents. */
function buildDocs(jobId, batch, results, from, to) {
  const docs = new Array(to - from);
  for (let k = from; k < to; k++) {
    const result = results[k];
    const tx = batch[k] || {};
    docs[k - from] = {
      jobId,
      transactionId: result.transaction_id,
      timestamp: tx.timestamp ? new Date(tx.timestamp) : new Date(),
      fromBank: tx.from_bank,
      account: tx.account,
      toBank: tx.to_bank,
      toAccount: tx.to_account,
      amountPaid: tx.amount_paid,
      paymentCurrency: tx.payment_currency,
      amountReceived: tx.amount_received,
      receivingCurrency: tx.receiving_currency,
      paymentFormat: tx.payment_format,
      isLaundering: tx.is_laundering,
      riskScore: result.risk_score,
      riskLevel: result.risk_level,
      isFraud: result.is_fraud,
      isolationForestScore: result.isolation_forest_score,
      autoencoderScore: result.autoencoder_score,
      gnnScore: result.gnn_score ?? null,
      fraudCategory: result.fraud_category,
      shapValues: result.shap_values || {},
      shapSigned: result.shap_signed || {},
      graphLinks: tx.to_account ? [tx.to_account] : [],
      createdAt: new Date(), // lean insert skips schema defaults, so it is set here
    };
  }
  return docs;
}

/**
 * Save one batch of results to MongoDB. NEVER rejects — failures are returned so the job can report them.
 * lean:true = insert plain objects (no per-document Mongoose hydration); ordered:false so one bad document doesn't
 * block the rest. Written in INSERT_CHUNK pieces with a yield in between so HTTP / Socket.IO stay responsive.
 */
async function saveBatch(jobId, batch, results) {
  let inserted = 0;
  let error = null;
  for (let from = 0; from < results.length; from += INSERT_CHUNK) {
    const docs = buildDocs(
      jobId,
      batch,
      results,
      from,
      Math.min(from + INSERT_CHUNK, results.length),
    );
    try {
      const ins = await Transaction.insertMany(docs, {
        ordered: false,
        lean: true,
      });
      inserted += ins.length;
    } catch (insertErr) {
      inserted +=
        insertErr.insertedDocs?.length || insertErr.result?.insertedCount || 0;
      error = error || insertErr.writeErrors?.[0]?.errmsg || insertErr.message;
    }
    await yieldToEventLoop();
  }
  return { inserted, error };
}

// ─────────────────────────────────────────────
// FR-18 — jobs are processed by a bounded-concurrency queue
// (Redis/Bull if REDIS_URL is reachable, otherwise in-process — see
// src/queue/uploadQueue.js). Call initUploadQueue(io) once at startup.
// ─────────────────────────────────────────────
let uploadQueue = null;
let ioRef = null;

async function initUploadQueue(io) {
  ioRef = io;
  uploadQueue = await createUploadQueue({ processor: processUploadJob });
  return uploadQueue;
}

/**
 * In-process queue mode keeps jobs in memory, so a restart/crash orphans any job
 * that was queued or running: it stays "analyzing" forever in the UI. Mark such
 * jobs failed (and drop their partial transactions) so users can simply re-upload.
 * In Redis mode Bull persists and retries jobs itself, so nothing is touched.
 */
async function recoverInterruptedJobs() {
  if (!uploadQueue || uploadQueue.mode !== "memory") return 0;
  const stuck = await Job.find({ status: { $nin: ["completed", "failed"] } })
    .select("jobId")
    .lean();
  for (const j of stuck) {
    await Transaction.deleteMany({ jobId: j.jobId });
    await Job.updateOne(
      { jobId: j.jobId },
      {
        status: "failed",
        errorMessage:
          "Interrupted by a server restart — please upload the file again.",
      },
    );
  }
  if (stuck.length)
    console.warn(
      `♻️  Marked ${stuck.length} interrupted job(s) as failed after restart`,
    );
  return stuck.length;
}

async function getUploadQueue() {
  if (!uploadQueue)
    uploadQueue = await createUploadQueue({ processor: processUploadJob });
  return uploadQueue;
}

async function getQueueStatus() {
  return (await getUploadQueue()).getStatus();
}

/**
 * The actual analysis pipeline for one job: parse -> sort by time -> AI Engine
 * (in batches) -> save -> summarise -> notify. Runs inside a queue worker.
 */
async function processUploadJob({ jobId, filePath, ext, userEmail, useGnn }) {
  const io = ioRef;
  const startTime = Date.now();

  try {
    await Job.findOneAndUpdate({ jobId }, { status: "parsing", progress: 8 });
    io?.to(`job_${jobId}`).emit("progress", {
      jobId,
      status: "parsing",
      progress: 10,
    });

    // Memory note: a 300k-row file used to be held as raw rows + parsed rows + sorted rows + AI results + insert documents
    // at the same time, which exhausted Node's ~2 GB heap. Now each intermediate copy is released as soon as it is no longer
    // needed, and results are saved to MongoDB chunk by chunk instead of all at the end.
    const tParse = Date.now();
    let rawRows =
      ext === ".csv" ? await parseCSV(filePath) : parseXLSX(filePath);
    let parsedTransactions = new Array(rawRows.length);
    for (let i = 0; i < rawRows.length; i++) {
      parsedTransactions[i] = parseIBMAMLRow(rawRows[i], i);
      rawRows[i] = null;
      if (i % 25000 === 24999) await yieldToEventLoop(); // keep the API responsive while a big file is parsed
    }
    rawRows = null;
    const transactions = sortByTimestamp(parsedTransactions);
    parsedTransactions = null;
    const parseMs = Date.now() - tParse;

    await Job.findOneAndUpdate(
      { jobId },
      {
        status: "analyzing",
        progress: 20,
        totalTransactions: transactions.length,
      },
    );

    io?.to(`job_${jobId}`).emit("progress", {
      jobId,
      status: "analyzing",
      progress: 20,
      total: transactions.length,
    });

    // ── Send to the AI engine in batches. While the engine scores batch N+1, batch N is being written to MongoDB ──
    // (before, each step waited for the previous one, so the engine idled during every insert and vice-versa).
    // At most ONE write is in flight, so memory stays bounded. Only running totals + a tiny summary are kept in memory.
    const totalBatches = Math.ceil(transactions.length / BATCH_SIZE);
    let processed = 0,
      flaggedCount = 0,
      criticalCount = 0,
      riskSum = 0,
      usedGnn = false;
    let insertedCount = 0,
      firstInsertError = null;
    let engineMs = 0,
      dbWaitMs = 0;
    let pendingSave = null;
    const summaryAcc = createAccumulator();
    const tag = String(jobId).slice(0, 8);

    for (let i = 0; i < totalBatches; i++) {
      const batch = transactions.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);

      const tEngine = Date.now();
      const response = await sendToAIEngine(batch, jobId, useGnn);
      const engineBatchMs = Date.now() - tEngine;
      engineMs += engineBatchMs;
      const results = response.results || [];

      // The previous batch was written WHILE the engine worked on this one — wait for it only now.
      let waitedMs = 0;
      if (pendingSave) {
        const tWait = Date.now();
        await pendingSave;
        waitedMs = Date.now() - tWait;
        dbWaitMs += waitedMs;
      }
      // Start saving THIS batch in the background and go straight on to the next engine call.
      pendingSave = saveBatch(jobId, batch, results).then(
        ({ inserted, error }) => {
          insertedCount += inserted;
          firstInsertError = firstInsertError || error;
        },
      );

      // cheap in-memory bookkeeping (no database access)
      for (const r of results) {
        if (r.is_fraud) flaggedCount++;
        if (r.risk_level === "Critical") criticalCount++;
        riskSum += r.risk_score;
        if (r.gnn_score !== null && r.gnn_score !== undefined) usedGnn = true;
      }
      addResults(summaryAcc, results, jobId);
      processed += results.length;

      console.log(
        `📦 Job ${tag} batch ${i + 1}/${totalBatches}: ${results.length} rows | engine ${(engineBatchMs / 1000).toFixed(1)}s` +
          ` | waited for previous save ${(waitedMs / 1000).toFixed(1)}s`,
      );

      const progress = 20 + Math.round(((i + 1) / totalBatches) * 75);
      await Job.findOneAndUpdate(
        { jobId },
        { progress, processedTransactions: processed },
      );
      io?.to(`job_${jobId}`).emit("progress", {
        jobId,
        status: "analyzing",
        progress,
        processed,
        total: transactions.length,
      });
    }

    if (pendingSave) {
      const tWait = Date.now();
      await pendingSave; // the last batch's write
      dbWaitMs += Date.now() - tWait;
    }

    if (insertedCount < processed) {
      console.error(
        `⚠️  Job ${jobId}: only ${insertedCount}/${processed} transactions saved. First error: ${firstInsertError}`,
      );
      await Job.findOneAndUpdate(
        { jobId },
        {
          saveWarning:
            `Only ${insertedCount}/${processed} transaction records saved. ` +
            `Analysis/Graph/Report views may be incomplete. Cause: ${firstInsertError}`,
        },
      );
    } else {
      console.log(
        `✅ Job ${jobId}: inserted ${insertedCount}/${processed} transactions`,
      );
    }

    // ── Summary ──
    const avgRisk = riskSum / Math.max(processed, 1);
    const processingTime = Date.now() - startTime;

    const timings = {
      rows: processed,
      batches: totalBatches,
      batchSize: BATCH_SIZE,
      parseMs,
      engineMs,
      dbWaitMs,
      totalMs: processingTime,
      rowsPerSec: Math.round(
        processed / Math.max(processingTime / 1000, 0.001),
      ),
    };
    console.log(
      `⏱️  Job ${tag}: ${processed.toLocaleString()} rows in ${(processingTime / 1000).toFixed(1)}s` +
        ` (${timings.rowsPerSec.toLocaleString()} rows/s) | parse ${(parseMs / 1000).toFixed(1)}s` +
        ` | engine ${(engineMs / 1000).toFixed(1)}s | waiting on database ${(dbWaitMs / 1000).toFixed(1)}s` +
        ` | ${totalBatches} batch(es) of ${BATCH_SIZE.toLocaleString()}`,
    );

    const finalJob = await Job.findOneAndUpdate(
      { jobId },
      {
        status: "completed",
        progress: 100,
        totalTransactions: processed,
        processedTransactions: processed,
        flaggedCount,
        criticalCount,
        cleanCount: processed - flaggedCount,
        averageRiskScore: Math.round(avgRisk * 10) / 10,
        processingTimeMs: processingTime,
        usedGnn,
        summary: finalizeSummary(summaryAcc), // lets the dashboard skip scanning transactions
        timings,
        completedAt: new Date(),
      },
      { new: true },
    ).lean();
    overviewCache.clear(); // a finished job must show up on the dashboard immediately

    io?.to(`job_${jobId}`).emit("completed", {
      jobId,
      status: "completed",
      summary: {
        total: processed,
        flagged: flaggedCount,
        critical: criticalCount,
        clean: processed - flaggedCount,
        avgRisk: Math.round(avgRisk * 10) / 10,
        processingTimeMs: processingTime,
        timings, // where the time went (parse / engine / database wait) — shown on the job card
        completedAt: finalJob?.completedAt,
      },
    });

    // FR-19: email leg of the alert (dashboard leg is the socket event above).
    // notifyJobCompleted never throws and never blocks the job's outcome.
    await notifyJobCompleted(finalJob, userEmail);
  } catch (err) {
    console.error(`❌ Job ${jobId} failed:`, err.message);
    const failedJob = await Job.findOneAndUpdate(
      { jobId },
      {
        status: "failed",
        errorMessage: err.message,
        processingTimeMs: Date.now() - startTime, // "failed after 12 s" — previously not recorded at all
      },
      { new: true },
    ).lean();
    // A failed job must not leave half its transactions behind: they would be
    // counted by dashboard/graph queries but belong to no completed analysis.
    try {
      const del = await Transaction.deleteMany({ jobId });
      if (del.deletedCount)
        console.log(
          `🧹 Removed ${del.deletedCount} partial transactions of failed job ${jobId}`,
        );
    } catch (cleanupErr) {
      console.error(
        `Partial-result cleanup failed for ${jobId}:`,
        cleanupErr.message,
      );
    }
    io?.to(`job_${jobId}`).emit("error", {
      jobId,
      error: err.message,
      processingTimeMs: Date.now() - startTime,
    });
    await notifyJobFailed(
      failedJob || { jobId, errorMessage: err.message },
      userEmail,
    );
  } finally {
    fs.unlink(filePath, () => {});
  }
}

/**
 * Main upload handler — validate quickly, create the job, enqueue it, reply.
 */
const uploadFile = async (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    // ── Validate BEFORE creating a job or responding ──
    // Reject an obviously-wrong file immediately with a clear error instead
    // of accepting it and producing meaningless all-default transactions.
    let sampleRows;
    try {
      sampleRows = await peekRows(filePath, ext);
    } catch (err) {
      fs.unlink(filePath, () => {});
      return res
        .status(400)
        .json({ error: `Could not parse file: ${err.message}` });
    }

    const schemaCheck = validateAMLSchema(sampleRows);
    if (!schemaCheck.valid) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({ error: schemaCheck.error });
    }

    const jobId = uuidv4();
    const useGnn = String(req.body?.useGnn ?? "").toLowerCase() === "true";

    try {
      await Job.create({
        jobId,
        userId: req.userId,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        fileSize: req.file.size,
        status: "queued",
        progress: 2,
      });

      const queue = await getUploadQueue();
      const { position } = await queue.add({
        jobId,
        filePath,
        ext,
        userEmail: req.user?.email,
        useGnn,
      });

      res.status(202).json({
        jobId,
        message:
          position > 1
            ? `File received — queued (${position - 1} ahead of it)`
            : "File received, processing started",
        status: "queued",
        queue: queue.mode,
        position,
      });
    } catch (e) {
      console.error(`❌ Could not enqueue job ${jobId}:`, e.message);
      await Job.findOneAndUpdate(
        { jobId },
        { status: "failed", errorMessage: `Could not queue job: ${e.message}` },
      );
      fs.unlink(filePath, () => {});
      if (!res.headersSent)
        res.status(500).json({ error: `Could not queue job: ${e.message}` });
    }
  });
};

/**
 * Get job status
 */
const getJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    // Previously restricted to the uploader, so older jobs (uploaded under another account) 404'd and the
    // Analysis page fell back to demo data when opened from the Dashboard.
    const job = await Job.findOne(
      SHARED_HISTORY ? { jobId } : { jobId, userId: req.userId },
    ).select("-summary");
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get all jobs for user
 */
const getUserJobs = async (req, res) => {
  try {
    const jobs = await Job.find(SHARED_HISTORY ? {} : { userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("-__v -summary");
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  uploadFile,
  getJobStatus,
  getUserJobs,
  initUploadQueue,
  recoverInterruptedJobs,
  getQueueStatus,
  _internals: { processUploadJob, peekRows, validateAMLSchema, parseIBMAMLRow },
};
