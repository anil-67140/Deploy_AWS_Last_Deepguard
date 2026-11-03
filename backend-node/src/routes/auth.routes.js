// ── auth.routes.js ──
const router1 = require("express").Router();
const {
  supabase,
  createAuthClient,
  authenticate,
  upsertProfile,
  getRole,
  invalidateToken,
} = require("../middleware/auth.middleware");

// Login — uses a throwaway client so the shared admin client keeps its service-role token.
router1.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await createAuthClient().auth.signInWithPassword({
      email,
      password,
    });
    if (error) return res.status(401).json({ error: error.message });
    const role = await getRole(data.user);
    res.json({ user: data.user, session: data.session, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register — public sign-up. The role is ALWAYS 'auditor' here; any "role" sent by the
// client is ignored (otherwise anyone could register themselves as admin).
router1.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const { data, error } = await createAuthClient().auth.signUp({
      email,
      password,
    });
    if (error) return res.status(400).json({ error: error.message });

    // Supabase returns an obfuscated user with no identities when the email already exists.
    if (
      !data.user ||
      (data.user.identities && data.user.identities.length === 0)
    ) {
      return res
        .status(400)
        .json({ error: "This email is already registered" });
    }

    // Save the user in the profiles table (the DB trigger normally does this already;
    // the upsert makes it work even if the trigger was not installed).
    try {
      await upsertProfile({ id: data.user.id, email: data.user.email });
    } catch (e) {
      console.error(
        "⚠️  Registered, but saving the profile row failed:",
        e.message,
      );
    }
    res.json({
      user: data.user,
      role: "auditor",
      message: "Registration successful",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Who am I? — returns the authoritative role from the profiles table (used by the frontend).
router1.get("/me", authenticate, (req, res) => {
  res.json({ id: req.userId, email: req.user.email, role: req.userRole });
});

router1.post("/logout", async (req, res) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (token) {
      invalidateToken(token); // stop honouring it right away
      await supabase.auth.admin.signOut(token).catch(() => {}); // best-effort
    }
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router1;
