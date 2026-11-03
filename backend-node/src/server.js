/**
 * DeepGuard — Node.js API Gateway
 * Handles file uploads, auth, graph queries, PDF reports, job queue
 */

require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const {
  generalLimiter,
  authLimiter,
} = require("./middleware/rateLimit.middleware");
const http = require("http");
const { Server } = require("socket.io");

const connectMongoDB = require("./config/mongodb");
const authRoutes = require("./routes/auth.routes");
const uploadRoutes = require("./routes/upload.routes");
const analysisRoutes = require("./routes/analysis.routes");
const graphRoutes = require("./routes/graph.routes");
const reportRoutes = require("./routes/report.routes");
const adminRoutes = require("./routes/admin.routes");
const dashboardRoutes = require("./routes/dashboard.routes");

const {
  initUploadQueue,
  recoverInterruptedJobs,
} = require("./controllers/upload.controller");
const { auditTrail } = require("./middleware/audit.middleware");
const { verifyToken } = require("./middleware/auth.middleware");
const { createBackupService } = require("./services/backup.service");
const {
  dropRedundantTransactionIndexes,
} = require("./services/indexMaintenance");
const { backfillMissingSummaries } = require("./services/jobSummary.service");
const Job = require("./models/Job.model");
const Transaction = require("./models/Transaction.model");

const { errorHandler } = require("./middleware/error.middleware");

const app = express();
const server = http.createServer(app);

// ── Socket.IO for real-time progress ──
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
  // a busy backend (big file being saved) may answer a ping late; don't drop the live-progress connection for it
  pingInterval: 25000,
  pingTimeout: 60000,
});

app.set("io", io);

// Only authenticated users may open a socket / subscribe to job progress.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const user = token ? await verifyToken(token) : null;
    if (!user) return next(new Error("Authentication required"));
    socket.data.userId = user.id;
    next();
  } catch (e) {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  socket.on("join_job", (jobId) => {
    if (typeof jobId === "string" && jobId.length <= 64)
      socket.join(`job_${jobId}`);
  });
  socket.on("disconnect", () =>
    console.log(`🔌 Client disconnected: ${socket.id}`),
  );
});

// ── Security Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }),
);

// ── Rate Limiting (see middleware/rateLimit.middleware.js for why the old 200-per-15-min limit looked like a disconnect) ──
app.use("/api", auditTrail);
app.use("/api/auth", authLimiter);
app.use("/api/", generalLimiter);

// ── Body Parsing ──
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(morgan("dev"));

// ── Routes ──
app.use("/api/auth", authRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/analysis", analysisRoutes);
app.use("/api/graph", graphRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/dashboard", dashboardRoutes);

// ── Health Check ──
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "deepguard-node",
    timestamp: new Date().toISOString(),
  });
});

// ── Error Handler ──
app.use(errorHandler);

// ── FR-20: Backup service, shared by admin.routes.js and the daily scheduler ──
const backupService = createBackupService({
  models: { jobs: Job, transactions: Transaction },
  dir: process.env.BACKUP_DIR || path.join(__dirname, "../backups"),
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || "30", 10),
});
app.set("backupService", backupService);

// ── Start Server ──
const PORT = process.env.PORT || 4000;

async function startServer() {
  try {
    await connectMongoDB();

    // FR-18: queue must exist before the upload route can accept files
    await initUploadQueue(io);
    await recoverInterruptedJobs();

    // Faster inserts: remove index duplicates that older versions of the schema created (one-off, instant)
    await dropRedundantTransactionIndexes();
    // Dashboard speed: give analyses done before summaries existed their one-time summary, in the background
    setTimeout(() => backfillMissingSummaries().catch(() => {}), 8000);

    // FR-20: daily backups, unless explicitly disabled (e.g. in tests)
    if (process.env.BACKUP_ENABLED !== "false") {
      backupService.startScheduler();
    }

    server.listen(PORT, () => {
      console.log(`\n🚀 DeepGuard Node.js Backend running on port ${PORT}`);
      console.log(`📡 Socket.IO ready`);
      console.log(
        `🌍 Frontend URL: ${process.env.FRONTEND_URL || "http://localhost:5173"}`,
      );
      console.log(
        `🤖 AI Engine: ${process.env.AI_ENGINE_URL || "http://127.0.0.1:8000"}\n`,
      );
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
