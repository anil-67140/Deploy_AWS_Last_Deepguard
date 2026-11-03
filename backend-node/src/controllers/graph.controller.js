const Transaction = require("../models/Transaction.model");

const MAX_EDGES = 800; // keep the browser responsive on hub accounts

/**
 * Trace the money trail around one transaction's sender account (the "origin").
 *
 *   direction=in    who funded the origin  (follows senders backwards)
 *   direction=out   where the money went   (follows receivers forwards)
 *   direction=both  both of the above (default)
 *   depth           number of hops (transfers) to follow in each direction
 *
 * Uses MongoDB $graphLookup. The edges are returned nearest-first, then
 * riskiest-first, so if a hub account forces us to truncate, what is dropped is
 * the far, low-risk part of the trail. `truncated` tells the UI when that happened.
 */
const getTransactionGraph = async (req, res) => {
  try {
    const transactionId = String(req.params.transactionId);
    // Coerce to a plain string: ?jobId[$ne]=x must never reach Mongo as an operator.
    const jobId =
      req.query.jobId === undefined
        ? undefined
        : String(
            Array.isArray(req.query.jobId)
              ? req.query.jobId[0]
              : req.query.jobId,
          );
    const hops = Math.min(Math.max(parseInt(req.query.depth) || 3, 1), 6);
    const direction = ["in", "out", "both"].includes(req.query.direction)
      ? req.query.direction
      : "both";

    // transactionId is only unique within a job, so scope by jobId when given.
    const startTx = await Transaction.findOne(
      jobId ? { transactionId, jobId } : { transactionId },
    );
    if (!startTx)
      return res.status(404).json({ error: "Transaction not found" });

    // $graphLookup's maxDepth is 0-based (0 = one hop), so hops - 1 makes
    // "depth 3" in the UI mean exactly three transfers away from the origin.
    const trace = (connectFromField, connectToField) =>
      Transaction.aggregate([
        { $match: { _id: startTx._id } },
        {
          $graphLookup: {
            from: "transactions",
            startWith: "$account",
            connectFromField,
            connectToField,
            as: "trail",
            maxDepth: hops - 1,
            depthField: "hop",
            restrictSearchWithMatch: { jobId: startTx.jobId },
          },
        },
        { $project: { "trail.shapValues": 0, "trail.graphLinks": 0 } },
      ]);

    const [inbound, outbound] = await Promise.all([
      direction !== "out" ? trace("account", "toAccount") : [], // transfers INTO the origin, then into those senders...
      direction !== "in" ? trace("toAccount", "account") : [], // transfers OUT of the origin, then out of those receivers...
    ]);

    // A transaction can appear in both trails (e.g. a self-transfer): keep one copy.
    const seen = new Map();
    for (const group of [inbound, outbound]) {
      for (const tx of group[0]?.trail || []) {
        if (!seen.has(tx.transactionId)) seen.set(tx.transactionId, tx);
      }
    }
    // The transaction the person clicked must always be on the graph.
    seen.set(startTx.transactionId, { ...startTx.toObject(), hop: -1 });
    const totalTransactions = seen.size;

    const edges = Array.from(seen.values())
      .filter((tx) => tx.account && tx.toAccount)
      .sort(
        (a, b) =>
          (a.hop ?? 0) - (b.hop ?? 0) ||
          (b.riskScore || 0) - (a.riskScore || 0),
      )
      .slice(0, MAX_EDGES)
      .map((tx) => ({
        id: tx.transactionId,
        source: tx.account,
        target: tx.toAccount,
        fromBank: tx.fromBank,
        toBank: tx.toBank,
        amount: tx.amountPaid,
        currency: tx.paymentCurrency,
        format: tx.paymentFormat,
        timestamp: tx.timestamp,
        riskScore: tx.riskScore,
        riskLevel: tx.riskLevel,
        isFraud: tx.isFraud,
        fraudCategory: tx.fraudCategory,
        hop: (tx.hop ?? -1) + 1, // 0 = the clicked transaction, 1 = first hop, ...
      }));

    // Full detail of the clicked transaction, so the page can explain *why* it was flagged.
    const { __v, graphLinks, ...focus } = startTx.toObject();

    res.json({
      originAccount: startTx.account,
      originBank: startTx.fromBank,
      depth: hops,
      direction,
      totalTransactions,
      truncated: totalTransactions > edges.length,
      edges,
      focus,
    });
  } catch (err) {
    console.error("Graph error:", err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get top suspicious networks across a job
 */
const getJobNetworks = async (req, res) => {
  try {
    const { jobId } = req.params;

    // Aggregate top suspicious accounts
    const suspiciousAccounts = await Transaction.aggregate([
      { $match: { jobId, isFraud: true } },
      {
        $group: {
          _id: "$account",
          txCount: { $sum: 1 },
          totalAmount: { $sum: "$amountPaid" },
          maxRiskScore: { $max: "$riskScore" },
          fraudCategories: { $addToSet: "$fraudCategory" },
          banks: { $addToSet: "$fromBank" },
        },
      },
      { $sort: { maxRiskScore: -1 } },
      { $limit: 20 },
      {
        $project: {
          account: "$_id",
          txCount: 1,
          totalAmount: { $round: ["$totalAmount", 2] },
          maxRiskScore: 1,
          fraudCategories: 1,
          banks: 1,
          _id: 0,
        },
      },
    ]);

    res.json({
      jobId,
      suspiciousAccounts,
      count: suspiciousAccounts.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getTransactionGraph, getJobNetworks };
