const AuditLog = require("../models/AuditLog.model");
const router = require("express").Router();
const axios = require("axios");
const {
  authenticate,
  requireAdmin,
  supabase,
  upsertProfile,
  invalidateRoleCache,
  VALID_ROLES,
} = require("../middleware/auth.middleware");
const Job = require("../models/Job.model");
const Transaction = require("../models/Transaction.model");
const { engineGet } = require("../services/engineInfo");
const overviewCache = require("../services/overviewCache");

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || "http://127.0.0.1:8000";

// All jobs (admin only)
router.get("/jobs", authenticate, requireAdmin, async (req, res) => {
  try {
    // -summary: the pre-computed dashboard roll-up is not needed in this list
    const jobs = await Job.find()
      .select("-summary")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// System stats
router.get("/stats", authenticate, requireAdmin, async (req, res) => {
  try {
    // These used to be Transaction.countDocuments() and countDocuments({ isFraud: true }): two FULL scans of the
    // transactions collection on every load (4-7 s once a few 300k-row files were saved). The Job collection already
    // holds the same totals (one small document per file), so sum those instead; cached for 30 s.
    const cached = overviewCache.get("admin:stats");
    if (cached) return res.json(cached);
    const [totalJobs, sums] = await Promise.all([
      Job.countDocuments(),
      Job.aggregate([
        { $match: { status: "completed" } },
        {
          $group: {
            _id: null,
            tx: { $sum: "$totalTransactions" },
            fraud: { $sum: "$flaggedCount" },
          },
        },
      ]),
    ]);
    const payload = {
      totalJobs,
      totalTransactions: sums[0]?.tx || 0,
      totalFraud: sums[0]?.fraud || 0,
    };
    overviewCache.set("admin:stats", payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-13: Manage Users (Admin) ──
// Uses Supabase's admin API (service role key — already configured in
// middleware/auth.middleware.js) to list/update users. Requires the
// SUPABASE_SERVICE_KEY in .env to actually be a *service_role* key, not
// the anon key, or these calls will 401/403 against Supabase.

// List all users
router.get("/users", authenticate, requireAdmin, async (req, res) => {
  try {
    // Roles come from the public.profiles table; sign-in/confirmation info from Supabase Auth.
    const [authRes, profRes] = await Promise.all([
      supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      supabase.from("profiles").select("id, role"),
    ]);
    if (authRes.error)
      return res.status(500).json({ error: authRes.error.message });
    if (profRes.error) {
      return res.status(500).json({
        error: `profiles table not available (${profRes.error.message}). Run supabase/001_profiles.sql in the Supabase SQL Editor.`,
      });
    }
    const roleById = new Map(profRes.data.map((p) => [p.id, p.role]));
    const users = authRes.data.users.map((u) => ({
      id: u.id,
      email: u.email,
      role: roleById.get(u.id) || "auditor",
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at,
      confirmed: !!u.email_confirmed_at,
    }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new user account (uses the Admin API — correctly creates the
// auth.identities row too, unlike a raw SQL INSERT into auth.users).
router.post("/users", authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, password, role = "auditor" } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "password must be at least 6 characters" });
    }
    if (!VALID_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ error: "role must be admin, auditor, or analyst" });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // no confirmation email needed for admin-created accounts
      user_metadata: { role },
    });

    if (error) return res.status(400).json({ error: error.message });

    // Save the user + chosen role in the profiles table.
    try {
      await upsertProfile({ id: data.user.id, email: data.user.email, role });
    } catch (e) {
      return res.status(500).json({
        error: `User was created in Supabase Auth but saving the profile failed: ${e.message}. Run supabase/001_profiles.sql.`,
      });
    }

    res.status(201).json({
      id: data.user.id,
      email: data.user.email,
      role,
      createdAt: data.user.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a user's role (admin | auditor | analyst)
router.patch(
  "/users/:userId/role",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { role } = req.body;
      if (!VALID_ROLES.includes(role)) {
        return res
          .status(400)
          .json({ error: "role must be admin, auditor, or analyst" });
      }
      // Don't let an admin lock themselves (and possibly everyone) out of administration.
      if (userId === req.userId && role !== "admin") {
        return res.status(400).json({
          error: "You cannot remove your own admin role — ask another admin.",
        });
      }
      // Source of truth: the profiles table.
      const { data: target, error: getErr } =
        await supabase.auth.admin.getUserById(userId);
      if (getErr || !target?.user)
        return res.status(404).json({ error: "User not found" });
      try {
        await upsertProfile({ id: userId, email: target.user.email, role });
      } catch (e) {
        return res
          .status(500)
          .json({ error: `Could not save role: ${e.message}` });
      }
      // Keep user_metadata in sync for display only — it is never used for permissions.
      await supabase.auth.admin
        .updateUserById(userId, { user_metadata: { role } })
        .catch(() => {});
      invalidateRoleCache(userId);
      res.json({ id: userId, email: target.user.email, role });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// Remove a user account
router.delete(
  "/users/:userId",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { userId } = req.params;
      if (userId === req.userId) {
        return res
          .status(400)
          .json({ error: "Cannot delete your own account" });
      }
      const { error } = await supabase.auth.admin.deleteUser(userId); // profile row is removed by ON DELETE CASCADE
      if (error) return res.status(500).json({ error: error.message });
      invalidateRoleCache(userId);
      res.json({ message: "User removed" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── FR-15: View System Logs (Admin) — full audit trail of jobs/uploads ──
router.get("/logs", authenticate, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      200,
    );
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const query = {};
    if (status) query.status = status;

    const [logs, total] = await Promise.all([
      Job.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .select(
          "jobId userId originalName status progress totalTransactions flaggedCount errorMessage processingTimeMs timings createdAt completedAt",
        )
        .lean(),
      Job.countDocuments(query),
    ]);

    res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-15: security audit trail (logins, uploads, reports, admin actions) — read-only ──
router.get("/audit", authenticate, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      200,
    );
    const query = {};
    if (typeof req.query.action === "string" && req.query.action)
      query.action = req.query.action;
    if (typeof req.query.userId === "string" && req.query.userId)
      query.userId = req.query.userId;
    const [entries, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(query),
    ]);
    res.json({ entries, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-14: Manage AI Models (Admin) ──
// The AI Engine itself has no auth (matching the rest of that service), so
// requireAdmin here is what actually protects these routes end-to-end.
router.get("/model-config", authenticate, requireAdmin, async (req, res) => {
  try {
    const { data } = await axios.get(`${AI_ENGINE_URL}/models/config`, {
      timeout: 10000,
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "AI Engine unreachable: " + err.message });
  }
});

router.patch("/model-config", authenticate, requireAdmin, async (req, res) => {
  try {
    const { data } = await axios.patch(
      `${AI_ENGINE_URL}/models/config`,
      req.body,
      { timeout: 10000 },
    );
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 502;
    res
      .status(status)
      .json({ error: err.response?.data?.detail || err.message });
  }
});

// ── FR-18: Queue status (Admin) ──
router.get("/queue/status", authenticate, requireAdmin, async (req, res) => {
  try {
    const { getQueueStatus } = require("../controllers/upload.controller");
    res.json(await getQueueStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FR-20: Data Backup & Recovery (Admin) ──
router.get("/backups", authenticate, requireAdmin, (req, res) => {
  try {
    res.json(req.app.get("backupService").listBackups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/backups/run", authenticate, requireAdmin, async (req, res) => {
  try {
    res.status(201).json(await req.app.get("backupService").runBackup());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get(
  "/backups/:name/download",
  authenticate,
  requireAdmin,
  (req, res) => {
    try {
      const svc = req.app.get("backupService");
      svc
        .verifyBackup(req.params.name)
        .then(() =>
          res.download(svc.getBackupPath(req.params.name), req.params.name),
        )
        .catch((err) =>
          res.status(err.status || 500).json({ error: err.message }),
        );
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.post(
  "/backups/:name/restore",
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      res.json(
        await req.app.get("backupService").restoreBackup(req.params.name),
      );
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.delete("/backups/:name", authenticate, requireAdmin, (req, res) => {
  try {
    req.app.get("backupService").deleteBackup(req.params.name);
    res.json({ message: "Backup deleted" });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── GNN status (Admin) — proxies the AI Engine's own diagnostic endpoint ──
router.get("/gnn/status", authenticate, requireAdmin, async (req, res) => {
  try {
    // cached + stale-on-error: stays answerable while the engine is busy scoring a file
    const data = await engineGet("/models/gnn/status", { timeoutMs: 10000 });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "AI Engine unreachable: " + err.message });
  }
});

module.exports = router;
