const rateLimit = require("express-rate-limit");

/**
 * Rate limiting.
 *
 * BEFORE: one bucket of 200 requests / 15 minutes for EVERYTHING under /api. The Admin "Queue" tab polls every 4 s
 * (15 requests/min), and every page makes several calls on load, so a long file upload (the exact moment people
 * watch the dashboards) used the whole allowance in ~10 minutes. After that every call returned 429, and the UI
 * looked like "the backend disconnected" while the job was in fact still running.
 *
 * NOW:
 *   - general API:  RATE_LIMIT_PER_MIN requests per minute (default 600) — generous for dashboards/polling, still
 *                   stops runaway loops. The window is short, so a burst recovers in seconds, not 15 minutes.
 *   - auth routes:  a separate, STRICT limit (default 50 / 15 min) — this is the part that actually needs
 *                   brute-force protection.
 *   - /api/health and CORS pre-flight (OPTIONS) are never counted.
 */
const perMinute = parseInt(process.env.RATE_LIMIT_PER_MIN || "600", 10);
const authPer15 = parseInt(process.env.AUTH_RATE_LIMIT_PER_15MIN || "50", 10);

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: perMinute,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS" || req.path === "/health",
  message: { error: "Too many requests — please slow down for a few seconds." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: authPer15,
  standardHeaders: true,
  legacyHeaders: false,
  // /me and /logout are session housekeeping (called on every page load), not sign-in attempts.
  skip: (req) =>
    req.method === "OPTIONS" || req.path === "/me" || req.path === "/logout",
  message: {
    error: "Too many sign-in attempts — please try again in a few minutes.",
  },
});

module.exports = { generalLimiter, authLimiter };
