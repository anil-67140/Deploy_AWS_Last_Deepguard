import { useEffect } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { supabase, fetchRole } from "./utils/api";
import { setUser, clearUser, setAuthReady } from "./store";

import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import UploadPage from "./pages/UploadPage";
import AnalysisPage from "./pages/AnalysisPage";
import GraphPage from "./pages/GraphPage";
import ReportsPage from "./pages/ReportsPage";
import PerformancePage from "./pages/PerformancePage";
import AdminPage from "./pages/AdminPage";
import Layout from "./components/Layout";

function ProtectedRoute({ children, adminOnly = false, auditorOnly = false }) {
  const { user, role, ready } = useSelector((s) => s.auth);
  // Wait for the stored session to be restored before deciding — otherwise every page refresh
  // redirects to /login (and /admin to /dashboard) before the user/role have loaded.
  if (!ready)
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>
        Loading…
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && role !== "admin")
    return <Navigate to="/dashboard" replace />;
  // FR-17: Analysts are view-only
  if (auditorOnly && !["admin", "auditor"].includes(role))
    return <Navigate to="/dashboard" replace />;
  return children;
}

// FR-3: end the session after a period of inactivity (default 30 min, VITE_IDLE_TIMEOUT_MIN to change).
const IDLE_MS =
  (parseInt(import.meta.env.VITE_IDLE_TIMEOUT_MIN, 10) || 30) * 60 * 1000;

function useIdleLogout(active) {
  useEffect(() => {
    if (!active) return;
    let timer;
    let last = 0;
    const expire = () => {
      supabase.auth.signOut();
    };
    const reset = () => {
      const now = Date.now();
      if (now - last < 1000) return; // throttle noisy events
      last = now;
      clearTimeout(timer);
      timer = setTimeout(expire, IDLE_MS);
    };
    const events = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "click",
    ];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [active]);
}

export default function App() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const loggedIn = useSelector((s) => !!s.auth.user);
  useIdleLogout(loggedIn);

  useEffect(() => {
    // Restore session on mount
    const applySession = async (session) => {
      let role = null;
      try {
        role = await fetchRole(session.access_token);
      } catch {
        /* backend down: fall back to least privilege */
      }
      dispatch(setUser({ user: session.user, session, role })); // role from the profiles table
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) applySession(session);
      else dispatch(setAuthReady());
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) {
        setTimeout(() => applySession(session), 0); // don't await Supabase/network calls inside this callback
      } else if (event === "SIGNED_OUT") {
        dispatch(clearUser());
        navigate("/login");
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route
          path="upload"
          element={
            <ProtectedRoute auditorOnly>
              <UploadPage />
            </ProtectedRoute>
          }
        />
        <Route path="analysis/:jobId" element={<AnalysisPage />} />
        <Route path="graph/:transactionId" element={<GraphPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="performance" element={<PerformancePage />} />
        <Route
          path="admin"
          element={
            <ProtectedRoute adminOnly>
              <AdminPage />
            </ProtectedRoute>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
