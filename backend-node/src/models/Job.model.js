const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    fileName: { type: String },
    originalName: { type: String },
    fileSize: { type: Number },
    status: {
      type: String,
      enum: ["queued", "parsing", "analyzing", "saving", "completed", "failed"],
      default: "queued",
      index: true,
    },
    progress: { type: Number, default: 0 }, // 0-100
    totalTransactions: { type: Number, default: 0 },
    processedTransactions: { type: Number, default: 0 },
    flaggedCount: { type: Number, default: 0 },
    criticalCount: { type: Number, default: 0 },
    cleanCount: { type: Number, default: 0 },
    averageRiskScore: { type: Number, default: 0 },
    processingTimeMs: { type: Number, default: 0 },
    errorMessage: { type: String },
    saveWarning: { type: String }, // set if Transaction.insertMany partially/fully failed after a successful AI analysis — see upload.controller.js
    usedGnn: { type: Boolean, default: false }, // true if the GNN also scored this job
    // Small pre-computed roll-up (risk levels, typologies, score histogram, top alerts) written when the job finishes,
    // so the dashboard never has to scan the Transaction collection. See services/jobSummary.service.js.
    summary: { type: mongoose.Schema.Types.Mixed },
    // Where the time went (parse / engine / database wait …) — also logged to the console per job.
    timings: { type: mongoose.Schema.Types.Mixed },
    reportUrl: { type: String },
    reportHash: { type: String }, // SHA-256 evidence fingerprint — FR-11
    reportGeneratedAt: { type: Date }, // FR-11
    reportSignature: { type: String }, // HMAC-SHA256(hash + timestamp) — only the server can produce it
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Job", JobSchema);
