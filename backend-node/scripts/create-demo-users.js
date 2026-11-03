/**
 * create-demo-users.js
 *
 * Creates the DeepGuard demo accounts (admin@deepguard.demo, auditor@deepguard.demo)
 * the CORRECT way, using Supabase's Admin API (supabase.auth.admin.createUser()).
 *
 * WHY THIS EXISTS:
 * Inserting rows directly into `auth.users` via raw SQL (as an earlier version of
 * SETUP_GUIDE.md instructed) does NOT create a matching row in `auth.identities`.
 * Supabase's GoTrue auth server requires that identity row to log a user in with
 * email+password — without it, signInWithPassword() fails with "Invalid login
 * credentials" even though the password hash in auth.users is technically correct.
 * `supabase.auth.admin.createUser()` creates both correctly in one call, and
 * `email_confirm: true` marks the account confirmed immediately (no confirmation
 * email needed — useful for demo/seed accounts).
 *
 * USAGE:
 *   cd backend-node
 *   node scripts/create-demo-users.js
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY to be set in backend-node/.env
 * (the service_role key, not the anon key — this script needs admin privileges).
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_KEY ||
  SUPABASE_SERVICE_KEY.includes("your_service_role_key")
) {
  console.error(
    "❌ SUPABASE_URL / SUPABASE_SERVICE_KEY not set correctly in backend-node/.env",
  );
  console.error(
    "   Get the service_role key from: Supabase Dashboard → Project Settings → API",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USERS = [
  { email: "admin@deepguard.demo", password: "deepguard123", role: "admin" },
  {
    email: "auditor@deepguard.demo",
    password: "deepguard123",
    role: "auditor",
  },
];

async function createOrFixUser({ email, password, role }) {
  // If a broken user (from the old raw-SQL method) already exists, remove it first.
  const { data: existing } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const found = existing?.users?.find((u) => u.email === email);
  if (found) {
    console.log(
      `  ↺ Existing user ${email} found — removing before recreating properly...`,
    );
    const { error: delErr } = await supabase.auth.admin.deleteUser(found.id);
    if (delErr) {
      console.error(
        `  ❌ Failed to remove existing ${email}: ${delErr.message}`,
      );
      return;
    }
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // skip email confirmation for demo accounts
    user_metadata: { role },
  });

  if (error) {
    console.error(`  ❌ Failed to create ${email}: ${error.message}`);
    return;
  }

  // Save the user + role in the public.profiles table (run supabase/001_profiles.sql first).
  const { error: profErr } = await supabase
    .from("profiles")
    .upsert(
      { id: data.user.id, email, role, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );
  if (profErr) {
    console.error(
      `  ⚠️  Created ${email} in Auth, but saving the profile row failed: ${profErr.message}`,
    );
    console.error(
      "     → Run supabase/001_profiles.sql in the Supabase SQL Editor, then re-run this script.",
    );
    return;
  }

  console.log(
    `  ✅ Created ${email} (role: ${role}, id: ${data.user.id}) + saved in profiles table`,
  );
}

(async () => {
  console.log("Creating DeepGuard demo accounts via Supabase Admin API...\n");
  for (const user of DEMO_USERS) {
    await createOrFixUser(user);
  }
  console.log("\nDone. Try logging in with:");
  DEMO_USERS.forEach((u) => console.log(`  ${u.email} / ${u.password}`));
})();
