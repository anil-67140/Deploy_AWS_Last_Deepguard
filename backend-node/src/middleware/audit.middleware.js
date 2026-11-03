const AuditLog = require("../models/AuditLog.model");

/**
 * Records security-relevant actions (FR-15 / flowchart 5 "log action").
 * Mounted once on /api; after the response is sent it inspects which route
 * matched and writes an AuditLog row. It never blocks or fails a request.
 *
 * Key = "<METHOD> <express route pattern>"  →  action name.
 */
const RULES = {
  "POST /api/auth/login": "login",
  "POST /api/auth/register": "register",
  "POST /api/upload": "file_upload",
  "GET /api/reports/generate/:jobId": "report_generated",
  "GET /api/reports/verify/:jobId": "report_verified",
  "GET /api/analysis/job/:jobId/export": "data_exported",
  "GET /api/analysis/job/:jobId/export/network": "data_exported",
  "GET /api/analysis/job/:jobId/export/analytics": "data_exported",
  "POST /api/admin/users": "user_created",
  "PATCH /api/admin/users/:userId/role": "user_role_changed",
  "DELETE /api/admin/users/:userId": "user_deleted",
  "PATCH /api/admin/model-config": "model_config_changed",
  "POST /api/admin/backups/run": "backup_created",
  "POST /api/admin/backups/:name/restore": "backup_restored",
  "DELETE /api/admin/backups/:name": "backup_deleted",
};

const SENSITIVE = /password|token|secret|key/i;
const safeBody = (b) =>
  b && typeof b === "object"
    ? Object.fromEntries(Object.entries(b).filter(([k]) => !SENSITIVE.test(k)).slice(0, 20))
    : undefined;

function auditTrail(req, res, next) {
  res.on("finish", () => {
    try {
      const pattern = `${req.baseUrl}${req.route?.path === "/" ? "" : req.route?.path || ""}`;
      const action = RULES[`${req.method} ${pattern}`];
      if (!action) return;

      const isLogin = action === "login" || action === "register";
      // Successful actions need an authenticated user; failed logins are logged too (brute-force evidence).
      if (!isLogin && (!req.user || res.statusCode >= 400)) return;
      const finalAction = action === "login" && res.statusCode >= 400 ? "login_failed" : action;

      const params = req.params || {};
      AuditLog.create({
        userId: req.user?.id,
        email: req.user?.email || (isLogin ? String(req.body?.email || "").slice(0, 200) : undefined),
        role: req.userRole,
        action: finalAction,
        target: params.jobId || params.userId || params.id || params.name || (req.file && req.file.originalname) || undefined,
        details: { method: req.method, path: req.originalUrl.split("?")[0], body: safeBody(req.body) },
        ip: req.ip,
        statusCode: res.statusCode,
      }).catch((e) => console.error("audit log write failed:", e.message));
    } catch (e) {
      console.error("audit hook error:", e.message);
    }
  });
  next();
}

module.exports = { auditTrail };
