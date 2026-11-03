import { useState, useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import { supabase, fetchRole } from "../utils/api";
import { setUser } from "../store";
import toast from "react-hot-toast";
import { Shield, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState(null); // set after sign-up -> shows the "check your email" screen
  const authUser = useSelector((s) => s.auth.user);
  const dispatch = useDispatch();
  const navigate = useNavigate();

  // Already signed in (e.g. just came back from the email-confirmation link) -> go to the dashboard.
  useEffect(() => {
    if (authUser) navigate("/dashboard", { replace: true });
  }, [authUser]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return toast.error("Please fill all fields");
    setLoading(true);
    try {
      if (isRegister) {
        // No role is sent: new accounts are always 'auditor'. The database trigger creates the
        // row in the `profiles` table; admins are promoted only by an existing admin.
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          // Where the link in the confirmation email sends the user back to (must be allowed in
          // Supabase -> Authentication -> URL Configuration -> Redirect URLs).
          options: { emailRedirectTo: `${window.location.origin}/login` },
        });
        if (error) throw error;
        if (data.user && data.user.identities?.length === 0) {
          throw new Error("This email is already registered");
        }
        if (data.session) {
          // Email confirmation is switched OFF in Supabase: the user is already signed in.
          toast.success("Account created!");
        } else {
          setConfirmEmail(email); // show the "check your email" screen
          setPassword("");
          setIsRegister(false);
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        const role = await fetchRole(data.session.access_token);
        dispatch(setUser({ user: data.user, session: data.session, role }));
        toast.success("Welcome back!");
        navigate("/dashboard");
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Demo accounts are OFF unless VITE_ENABLE_DEMO=true at build time (never enable in production:
  // the demo credentials ship inside the JavaScript bundle). Signs in to REAL Supabase demo accounts —
  // there is no fake/mock session any more; if the sign-in fails the user sees the error.
  const DEMO_ENABLED = import.meta.env.VITE_ENABLE_DEMO === "true";
  const demoLogin = async (role) => {
    setLoading(true);
    const credentials = {
      admin: {
        email: "admin@deepguard.demo",
        password: import.meta.env.VITE_DEMO_PASSWORD || "",
      },
      auditor: {
        email: "auditor@deepguard.demo",
        password: import.meta.env.VITE_DEMO_PASSWORD || "",
      },
    };
    const { email: e, password: p } = credentials[role];
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: e,
        password: p,
      });
      if (error) throw error;
      const realRole = await fetchRole(data.session.access_token);
      dispatch(
        setUser({ user: data.user, session: data.session, role: realRole }),
      );
      navigate("/dashboard");
    } catch (err) {
      toast.error(`Demo sign-in failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex">
      {/* Left — Branding */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-between p-12 bg-gradient-to-br from-slate-900 via-slate-800 to-sky-900/30 border-r border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500/20 border border-sky-500/30 flex items-center justify-center">
            <Shield className="w-6 h-6 text-sky-400" />
          </div>
          <div>
            <h1 className="font-bold text-white text-lg">DeepGuard</h1>
            <p className="text-xs text-slate-400">
              AI Financial Forensics Platform
            </p>
          </div>
        </div>

        <div>
          <h2 className="text-4xl font-bold text-white leading-tight mb-4">
            Detect. Explain.
            <br />
            <span className="shimmer-text">Trace.</span>
          </h2>
          <p className="text-slate-400 text-base leading-relaxed max-w-sm">
            Multi-model AI fraud detection using Isolation Forest, Deep
            Autoencoders and XGBoost with SHAP explainability and interactive
            network graph analysis.
          </p>

          <div className="mt-8 grid grid-cols-2 gap-4">
            {[
              { label: "AI Models", value: "2" },
              { label: "Explainability", value: "SHAP" },
              { label: "Graph Depth", value: "L1–L5" },
              { label: "Report Format", value: "PDF" },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-slate-800/50 border border-slate-700 rounded-lg p-3"
              >
                <div className="text-sky-400 font-bold text-lg">{value}</div>
                <div className="text-slate-400 text-xs mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-slate-600 text-xs">
          Iqra University · CS Batch 2023 · Supervised by Dr. Dure e Jabeen
        </p>
      </div>

      {/* Right — Form */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <Shield className="w-6 h-6 text-sky-400" />
            <span className="font-bold text-white">DeepGuard</span>
          </div>

          {confirmEmail && (
            <div className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm mb-1">
                <MailCheck className="w-4 h-4" /> Check your email
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                We sent a confirmation link to{" "}
                <span className="text-white font-medium">{confirmEmail}</span>.
                Click it, then sign in below. (Check your spam folder if you
                don't see it.)
              </p>
              <button
                type="button"
                onClick={() => setConfirmEmail(null)}
                className="mt-2 text-xs text-slate-400 hover:text-slate-200"
              >
                Dismiss
              </button>
            </div>
          )}

          <h2 className="text-2xl font-bold text-white mb-1">
            {isRegister ? "Create account" : "Sign in"}
          </h2>
          <p className="text-slate-400 text-sm mb-7">
            {isRegister
              ? "Register as a financial auditor"
              : "Access your forensics dashboard"}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs text-slate-400 font-medium block mb-1.5">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="auditor@bank.com"
                className="input w-full"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 font-medium block mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="input w-full pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  {showPass ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {isRegister ? "Create Account" : "Sign In"}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={() => setIsRegister(!isRegister)}
              className="text-xs text-sky-400 hover:text-sky-300 transition-colors"
            >
              {isRegister
                ? "Already have an account? Sign in"
                : "Don't have an account? Register"}
            </button>
          </div>

          {/* Demo Buttons (only when VITE_ENABLE_DEMO=true) */}
          {DEMO_ENABLED && (
            <div className="mt-6 border-t border-slate-700 pt-6">
              <p className="text-xs text-slate-500 text-center mb-3">
                Quick demo access
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => demoLogin("auditor")}
                  disabled={loading}
                  className="btn-secondary text-xs py-2"
                >
                  Demo Auditor
                </button>
                <button
                  onClick={() => demoLogin("admin")}
                  disabled={loading}
                  className="btn-secondary text-xs py-2"
                >
                  Demo Admin
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
