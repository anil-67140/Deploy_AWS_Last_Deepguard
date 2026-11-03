const mongoose = require("mongoose");

const TransactionSchema = new mongoose.Schema(
  {
    // No standalone index on jobId: it is the prefix of the three compound indexes below, so a separate one only
    // slowed every insert (each index costs one B-tree write per document).
    jobId: { type: String, required: true },
    transactionId: { type: String, required: true, index: true },

    // IBM AML fields
    timestamp: { type: Date, default: Date.now },
    fromBank: { type: String }, // never used as a filter, so no index
    account: { type: String }, // sender account — indexed through the compound { account, toAccount } below
    toBank: { type: String },
    toAccount: { type: String, index: true }, // receiver account (for graphLookup)
    amountPaid: { type: Number, default: 0 },
    paymentCurrency: { type: String, default: "USD" },
    amountReceived: { type: Number, default: 0 },
    receivingCurrency: { type: String, default: "USD" },
    paymentFormat: { type: String, default: "Wire" },
    isLaundering: { type: Number, default: 0 }, // original label (if available)

    // AI Results
    riskScore: { type: Number, default: 0 }, // 0-100
    riskLevel: {
      type: String,
      enum: ["Low", "Medium", "High", "Critical"],
      default: "Low",
    },
    isFraud: { type: Boolean, default: false },
    isolationForestScore: { type: Number, default: 0 },
    autoencoderScore: { type: Number, default: 0 },
    gnnScore: { type: Number, default: null }, // 0-100, only when the job was run with the GNN option
    fraudCategory: { type: String, default: "Clean" },
    shapValues: { type: mongoose.Schema.Types.Mixed, default: {} }, // unsigned share of influence (sums to 1) — kept for older UI/exports
    shapSigned: { type: mongoose.Schema.Types.Mixed, default: {} }, // signed TreeSHAP (log-odds): + pushed risk UP, − pulled it DOWN

    // Graph metadata
    graphLinks: [{ type: String }], // list of connected account IDs

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

// Compound index for graph traversal
TransactionSchema.index({ account: 1, toAccount: 1 });
TransactionSchema.index({ jobId: 1, riskScore: -1 });
TransactionSchema.index({ jobId: 1, isFraud: 1 });
// Uniqueness is scoped to (jobId, transactionId) rather than transactionId
// alone — transactionId is often an auto-generated "TX-1, TX-2, ..." sequence
// (see upload.controller.js's parseIBMAMLRow) when the source file has no
// real ID column, which is true of the real IBM-AML dataset. A global unique
// constraint on transactionId meant the SECOND job ever uploaded without a
// real ID column would collide with the first and silently fail to insert
// ANY transactions (masked further by upload.controller.js's old
// `.catch(() => {})`). Scoping to the pair fixes this while still preventing
// true duplicate rows within the same job.
TransactionSchema.index({ jobId: 1, transactionId: 1 }, { unique: true });

module.exports = mongoose.model("Transaction", TransactionSchema);
