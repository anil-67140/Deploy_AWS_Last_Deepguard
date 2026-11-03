const router = require("express").Router();
const { engineGet } = require("../services/engineInfo");
const {
  authenticate,
  requireAuditor,
} = require("../middleware/auth.middleware");
const {
  uploadFile,
  getJobStatus,
  getUserJobs,
} = require("../controllers/upload.controller");

// Is the GNN option usable? Open to ANY logged-in user (the upload page needs it).
// The full diagnostic route (/api/admin/gnn/status) is admin-only, which is why auditors
// always saw the checkbox disabled. This returns only a yes/no and a reason.
router.get("/gnn-status", authenticate, async (req, res) => {
  try {
    // cached + stale-on-error, so the checkbox doesn't flip to "engine offline" while a file is being scored
    const data = await engineGet("/models/gnn/status", { timeoutMs: 8000 });
    res.json({
      available: !!data.available,
      reason: data.available ? null : "not_installed",
    });
  } catch (err) {
    res.json({ available: false, reason: "engine_offline" });
  }
});

// FR-17: Analysts are view-only; only Auditor/Admin may upload.
router.post("/", authenticate, requireAuditor, uploadFile);
router.get("/jobs", authenticate, getUserJobs);
router.get("/jobs/:jobId", authenticate, getJobStatus);

module.exports = router;
