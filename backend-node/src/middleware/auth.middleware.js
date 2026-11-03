const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};

// ADMIN client (service_role). Used for the Admin API and for reading/writing the
// `profiles` table. IMPORTANT: never call signInWithPassword()/signUp() on this
// client — doing so replaces its service-role token with that user's token, and
// every later table query would then run as that user (blocked by RLS).
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  clientOptions,
);

// Throwaway client for sign-in / sign-up calls (one per request, never shared).
const createAuthClient = () =>
  createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, clientOptions);

const VALID_ROLES = ["admin", "auditor", "analyst"];

// ── profiles table helpers ──────────────────────────────────────────────────
// public.profiles is the single source of truth for roles (see
// supabase/001_profiles.sql). user_metadata is NOT trusted for permissions
// because users can edit it themselves from the browser.

const ROLE_TTL_MS = 30 * 1000; // avoid one DB hit per request (the dashboard polls a lot)
const roleCache = new Map(); // userId -> { role, expires }
const invalidateRoleCache = (userId) => roleCache.delete(userId);

let warnedMissingTable = false;
const warnMissingTable = (error) => {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  console.error(
    `❌ Could not use the Supabase "profiles" table: ${error.message}\n` +
      "   → Run supabase/001_profiles.sql in Supabase Dashboard → SQL Editor. " +
      'Until then every user is treated as "auditor".',
  );
};

/**
 * Create/update a user's row in public.profiles.
 * `role` is optional: when omitted, an existing row keeps its role and a new row gets 'auditor'.
 */
async function upsertProfile({ id, email, role, full_name }) {
  const row = { id, email, updated_at: new Date().toISOString() };
  if (role) row.role = role;
  if (full_name) row.full_name = full_name;
  const { data, error } = await supabase
    .from("profiles")
    .upsert(row, { onConflict: "id" })
    .select("id, email, role")
    .single();
  if (error) throw error;
  invalidateRoleCache(id);
  return data;
}

/** Read the role from public.profiles (creates an 'auditor' row if the user has none yet). */
async function getRole(user) {
  const cached = roleCache.get(user.id);
  if (cached && cached.expires > Date.now()) return cached.role;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (error) throw error;

    let role = data?.role;
    if (!role) {
      const created = await upsertProfile({ id: user.id, email: user.email }); // self-heal
      role = created.role;
    }
    roleCache.set(user.id, { role, expires: Date.now() + ROLE_TTL_MS });
    return role;
  } catch (err) {
    warnMissingTable(err);
    return "auditor"; // fail closed: never fall back to user-editable metadata
  }
}

// ── token verification cache ────────────────────────────────────────────────
// supabase.auth.getUser(token) is a NETWORK call to Supabase's servers. It used to run on EVERY API request, so each
// call paid a full round trip (hundreds of ms from Pakistan) and a page that fires 6 requests waited on 6 round trips.
// A verified token is now remembered for up to 60 s (never past the JWT's own expiry), and concurrent requests that
// arrive with the same unverified token share ONE verification.
// Trade-off: a token revoked at Supabase (sign-out elsewhere, deleted user) keeps working here for up to 60 s.
const TOKEN_TTL_MS = 60 * 1000;
const tokenCache = new Map(); // token -> { user, expires }
const verifying = new Map(); // token -> Promise<user|null>

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return payload.exp ? payload.exp * 1000 : Infinity;
  } catch {
    return 0;
  } // not a decodable JWT → don't cache
}

async function verifyToken(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;
  if (verifying.has(token)) return verifying.get(token);

  const p = (async () => {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) return null; // failures are never cached
    const expires = Math.min(Date.now() + TOKEN_TTL_MS, jwtExpiryMs(token));
    if (expires > Date.now()) {
      if (tokenCache.size > 500) {
        // keep the map small
        for (const [k, v] of tokenCache)
          if (v.expires <= Date.now()) tokenCache.delete(k);
      }
      tokenCache.set(token, { user, expires });
    }
    return user;
  })().finally(() => verifying.delete(token));

  verifying.set(token, p);
  return p;
}

const invalidateToken = (token) => {
  tokenCache.delete(token);
};

/**
 * Verify Supabase JWT token — protect routes
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const user = await verifyToken(token);

    if (!user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = user;
    req.userId = user.id;
    req.userRole = await getRole(user); // from the profiles table

    next();
  } catch (err) {
    return res.status(401).json({ error: "Authentication failed" });
  }
};

/**
 * Require admin role
 */
const requireAdmin = (req, res, next) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

/**
 * Require auditor or admin role
 */
const requireAuditor = (req, res, next) => {
  if (!["admin", "auditor"].includes(req.userRole)) {
    return res.status(403).json({ error: "Auditor access required" });
  }
  next();
};

module.exports = {
  authenticate,
  verifyToken,
  requireAdmin,
  requireAuditor,
  supabase,
  createAuthClient,
  upsertProfile,
  getRole,
  invalidateRoleCache,
  invalidateToken,
  VALID_ROLES,
};
