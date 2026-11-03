const mongoose = require("mongoose");

/**
 * FR-15 audit trail: who did what, when. Append-only from the application's
 * point of view (no update/delete routes exist) and auto-expired after
 * AUDIT_RETENTION_DAYS (default 90) by a MongoDB TTL index.
 */
const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || "90", 10);

const auditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: { expireAfterSeconds: RETENTION_DAYS * 86400 } },
    userId: { type: String, index: true },
    email: String,
    role: String,
    action: { type: String, index: true },
    target: String,
    details: mongoose.Schema.Types.Mixed,
    ip: String,
    statusCode: Number,
  },
  { versionKey: false },
);

module.exports = mongoose.model("AuditLog", auditLogSchema);
