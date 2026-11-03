const router = require("express").Router();
const { authenticate } = require("../middleware/auth.middleware");
const Job = require("../models/Job.model");
const { engineGet } = require("../services/engineInfo");
const overviewCache = require("../services/overviewCache");
const {
  mergeSummaries,
  backfillMissingSummaries,
} = require("../services/jobSummary.service");

// ── Overview ────────────────────────────────────────────────────────────────
// FAST: nothing here touches the Transaction collection any more. Each finished job carries a small pre-computed
// summary (risk levels, typologies, score histogram, top alerts — see services/jobSummary.service.js), so this just
// merges a few hundred bytes per job. It used to scan every transaction ever saved (5-7 s, growing with every file).
//
// SHARED_HISTORY (default on): show EVERY analysis done so far, not only the jobs uploaded by the signed-in account.
// Set SHARED_HISTORY=false in .env to scope the dashboard to the user's own jobs.
const SHARED_HISTORY = process.env.SHARED_HISTORY !== "false";
const EMPTY_TOTALS = {
  jobCount: 0,
  totalTransactions: 0,
  totalFlagged: 0,
  totalCritical: 0,
};

router.get("/overview", authenticate, async (req, res) => {
  try {
    const cacheKey = SHARED_HISTORY ? "overview:all" : `overview:${req.userId}`;
    const cached = overviewCache.get(cacheKey);
    if (cached) return res.json(cached);

    const jobFilter = SHARED_HISTORY ? {} : { userId: req.userId };
    const jobs = await Job.find(jobFilter)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    const completed = jobs.filter((j) => j.status === "completed");

    const totals = { ...EMPTY_TOTALS, jobCount: jobs.length };
    for (const j of completed) {
      totals.totalTransactions += j.totalTransactions || 0;
      totals.totalFlagged += j.flaggedCount || 0;
      totals.totalCritical += j.criticalCount || 0;
    }

    const merged = mergeSummaries(completed);
    // Jobs analysed before summaries existed are filled in once, in the background; the next load includes them.
    const summaryPending = completed.length - merged.withSummary;
    if (summaryPending > 0) backfillMissingSummaries().catch(() => {});

    const payload = {
      recentJobs: jobs.slice(0, 8).map(({ summary, ...rest }) => rest),
      recentAlerts: merged.recentAlerts,
      riskBreakdown: merged.riskBreakdown,
      categoryBreakdown: merged.categoryBreakdown,
      scoreDistribution: merged.scoreDistribution,
      totals,
      scope: SHARED_HISTORY ? "all" : "user",
      summaryPending,
    };
    // while summaries are still being built, keep the cache short so the finished numbers appear quickly
    overviewCache.set(cacheKey, payload, summaryPending > 0 ? 5000 : undefined);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ─────────────────────────────────────────────
 * FR-12 — View Performance Analytics.
 *
 * SRS wording: "The system shall display performance analytics and system
 * health metrics including processing time, number of transactions
 * analyzed, detection accuracy, and model performance statistics."
 *
 * This combines two genuinely different things the old `/overview` route
 * didn't cover:
 *   - MODEL performance (is the AI good?) — proxied straight from the AI
 *     Engine's saved training outputs (metadata.json, tables/) via GET /models/info, so it's
 *     always the real evaluated numbers, never hand-typed into the frontend.
 *   - SYSTEM performance (is the pipeline fast?) — computed here from Job
 *     history: total jobs run, total transactions processed all-time,
 *     average/max processing time, plus a per-job trend for charting.
 *
 * Available to any authenticated user (not just admin) — the SRS doesn't
 * scope FR-12 to a role, and auditors benefit from seeing model accuracy
 * before trusting its flags as much as admins do.
 * ─────────────────────────────────────────────
 */
router.get("/performance", authenticate, async (req, res) => {
  try {
    const [modelInfoResult, jobStatsResult, recentJobsResult] =
      await Promise.allSettled([
        // cached for 30 s (stale-on-error): the engine is busy while a file is processed, and this page must not hang or
        // flip to "offline / demo mode" just because of that
        engineGet("/models/info", { timeoutMs: 8000 }).then((data) => ({
          data,
        })),
        Job.aggregate([
          { $match: { status: "completed" } },
          {
            $group: {
              _id: null,
              totalJobsRun: { $sum: 1 },
              totalTransactionsProcessed: { $sum: "$totalTransactions" },
              totalFlagged: { $sum: "$flaggedCount" },
              totalCritical: { $sum: "$criticalCount" },
              avgProcessingTimeMs: { $avg: "$processingTimeMs" },
              maxProcessingTimeMs: { $max: "$processingTimeMs" },
              minProcessingTimeMs: { $min: "$processingTimeMs" },
              avgRiskScore: { $avg: "$averageRiskScore" },
            },
          },
        ]),
        Job.find({ status: "completed" })
          .sort({ createdAt: -1 })
          .limit(20)
          .select(
            "jobId originalName totalTransactions processingTimeMs averageRiskScore flaggedCount criticalCount createdAt usedGnn -_id",
          )
          .lean(),
      ]);

    const modelInfo =
      modelInfoResult.status === "fulfilled"
        ? modelInfoResult.value.data
        : null;
    const systemStats =
      jobStatsResult.status === "fulfilled" && jobStatsResult.value[0]
        ? jobStatsResult.value[0]
        : {
            totalJobsRun: 0,
            totalTransactionsProcessed: 0,
            totalFlagged: 0,
            totalCritical: 0,
            avgProcessingTimeMs: 0,
            maxProcessingTimeMs: 0,
            minProcessingTimeMs: 0,
            avgRiskScore: 0,
          };
    const trend =
      recentJobsResult.status === "fulfilled"
        ? recentJobsResult.value.reverse()
        : [];

    res.json({
      modelAvailable: !!modelInfo && !modelInfo.demo_mode,
      demoMode: modelInfo?.demo_mode ?? true,
      modelPerformance: modelInfo?.metadata?.model_performance || null,
      modelLabels: modelInfo?.metadata?.model_labels || null,
      finalModel: modelInfo?.metadata?.final_model || null,
      operatingPoints: modelInfo?.metadata?.operating_points || null,
      trainingInfo: modelInfo?.metadata?.training || null,
      shapFeatureImportance:
        modelInfo?.metadata?.shap_feature_importance || null,
      ensembleWeights: modelInfo?.metadata?.ensemble_weights || null,
      ensembleThreshold: modelInfo?.metadata?.ensemble_threshold ?? null,
      gnnAvailable: modelInfo?.gnn_available || false,
      gnnPerformance: modelInfo?.gnn_metadata?.test_performance || null,
      systemStats,
      recentJobsTrend: trend,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
