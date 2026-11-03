const router = require("express").Router();
const {
  authenticate,
  requireAuditor,
} = require("../middleware/auth.middleware");
const {
  generateReport,
  verifyReport,
} = require("../controllers/report.controller");

// FR-17: report generation is Auditor/Admin; verification stays open to all roles.
router.get("/generate/:jobId", authenticate, requireAuditor, generateReport);
router.get("/verify/:jobId", authenticate, verifyReport); // FR-11 — integrity check

module.exports = router;
