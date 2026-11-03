import React, { useState, useEffect } from "react";
import { adminAPI } from "../utils/api";
import toast from "react-hot-toast";
import {
  Users,
  Database,
  Activity,
  Shield,
  Loader2,
  Trash2,
  Save,
  Sliders,
  ScrollText,
  LayoutGrid,
  UserPlus,
  Network,
  ListOrdered,
  Download,
  RotateCcw,
} from "lucide-react";
import { formatDuration, getJobTiming } from "../utils/duration";
import { breakdownText } from "../components/JobTime";
import { formatDistanceToNow } from "date-fns";

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "users", label: "Users", icon: Users },
  { id: "models", label: "AI Models", icon: Sliders },
  { id: "queue", label: "Queue", icon: ListOrdered },
  { id: "backups", label: "Backups", icon: Database },
  { id: "logs", label: "System Logs", icon: ScrollText },
];

// Catches any render-time crash in whatever tab is currently showing (e.g. an
// API response in an unexpected shape) and shows the actual error instead of
// a silent blank page — React unmounts the WHOLE surrounding tree on an
// uncaught render error by default, and without this boundary one tab's bug
// could blank out the tab bar too, making it look like the entire Admin
// panel (not just that tab) had simply vanished. `resetKey` forces a fresh
// mount (another chance to render) when the admin switches tabs.
class TabErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card border border-red-800/40">
          <p className="text-sm text-red-300 font-semibold mb-1">
            This tab couldn't render
          </p>
          <p className="text-xs text-red-400 font-mono mb-2">
            {this.state.error.message}
          </p>
          <p className="text-xs text-slate-500">
            Usually means the backend returned something unexpected (check the
            Node console for the actual API response). Other tabs are
            unaffected.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AdminPage() {
  const [tab, setTab] = useState("overview");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Admin Panel</h1>
        <p className="text-slate-400 text-sm mt-1">
          System overview and management
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-slate-800">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors
              ${tab === id ? "border-sky-400 text-sky-400" : "border-transparent text-slate-400 hover:text-slate-200"}`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <TabErrorBoundary resetKey={tab}>
        {tab === "overview" && <OverviewTab />}
        {tab === "users" && <UsersTab />}
        {tab === "models" && <ModelsTab />}
        {tab === "queue" && <QueueTab />}
        {tab === "backups" && <BackupsTab />}
        {tab === "logs" && <LogsTab />}
      </TabErrorBoundary>
    </div>
  );
}

// ─────────────────────────────────────────────
// Overview
// ─────────────────────────────────────────────
function OverviewTab() {
  const [stats, setStats] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [demoReason, setDemoReason] = useState(null); // set when the numbers shown are NOT live data

  useEffect(() => {
    Promise.all([adminAPI.getStats(), adminAPI.getAllJobs()])
      .then(([s, j]) => {
        setStats(s.data);
        setJobs(Array.isArray(j.data) ? j.data : []);
      })
      .catch((e) => {
        setStats(MOCK_STATS);
        setJobs(MOCK_JOBS);
        setDemoReason(
          e.response?.status === 429
            ? "the API rate limit was hit"
            : "the backend could not be reached",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
      </div>
    );

  return (
    <div className="space-y-6">
      {demoReason && (
        <div className="px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          Showing <b>sample data</b>, not real results — {demoReason}. Refresh
          in a few seconds.
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          {
            icon: Database,
            label: "Total Jobs",
            value: stats?.totalJobs || 0,
            color: "sky",
          },
          {
            icon: Activity,
            label: "Total Transactions",
            value: (stats?.totalTransactions || 0).toLocaleString(),
            color: "green",
          },
          {
            icon: Shield,
            label: "Total Fraud Found",
            value: (stats?.totalFraud || 0).toLocaleString(),
            color: "red",
          },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} className="card flex items-center gap-4">
            <div
              className={`w-10 h-10 rounded-lg flex items-center justify-center
              ${color === "sky" ? "bg-sky-500/10 text-sky-400" : color === "green" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}
            >
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-400">{label}</p>
              <p className="text-xl font-bold text-white">{value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-4">All Jobs</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700">
                {[
                  "Job ID",
                  "File",
                  "User",
                  "Total",
                  "Flagged",
                  "Status",
                  "Took",
                  "Created",
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-2 text-slate-400 font-semibold"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.jobId}
                  className="border-b border-slate-800/50 hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2 font-mono text-slate-300">
                    {job.jobId?.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2 text-slate-200 max-w-36 truncate">
                    {job.originalName}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-400">
                    {job.userId?.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2 text-slate-200">
                    {(job.totalTransactions || 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-red-400 font-semibold">
                    {(job.flaggedCount || 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        job.status === "completed"
                          ? "bg-green-500/10 text-green-400"
                          : job.status === "failed"
                            ? "bg-red-500/10 text-red-400"
                            : "bg-amber-500/10 text-amber-400"
                      }`}
                    >
                      {job.status}
                    </span>
                  </td>
                  <td
                    className="px-3 py-2 text-slate-300 tabular-nums whitespace-nowrap"
                    title={breakdownText(job) || undefined}
                  >
                    {job.status === "completed" || job.status === "failed"
                      ? formatDuration(getJobTiming(job).tookMs)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {formatDistanceToNow(new Date(job.createdAt), {
                      addSuffix: true,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FR-13: Manage Users
// ─────────────────────────────────────────────
function UsersTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    email: "",
    password: "",
    role: "auditor",
  });

  const load = () => {
    setLoading(true);
    adminAPI
      .getUsers()
      .then((r) => {
        setUsers(Array.isArray(r.data) ? r.data : []);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.email || !form.password) {
      toast.error("Email and password are required");
      return;
    }
    if (form.password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setCreating(true);
    try {
      await adminAPI.createUser(form);
      toast.success(`User ${form.email} created`);
      setForm({ email: "", password: "", role: "auditor" });
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(
        "Failed to create user: " + (err.response?.data?.error || err.message),
      );
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (userId, role) => {
    setSavingId(userId);
    try {
      await adminAPI.updateUserRole(userId, role);
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role } : u)),
      );
      toast.success("Role updated");
    } catch (err) {
      toast.error("Failed to update role: " + err.message);
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (userId, email) => {
    if (!window.confirm(`Remove user ${email}? This cannot be undone.`)) return;
    try {
      await adminAPI.deleteUser(userId);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      toast.success("User removed");
    } catch (err) {
      toast.error("Failed to remove user: " + err.message);
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">User Accounts</h3>
          <div className="flex items-center gap-3">
            <p className="text-xs text-slate-500">
              {users.length} user{users.length !== 1 ? "s" : ""}
            </p>
            <button
              onClick={() => setShowForm((s) => !s)}
              className="btn-primary text-xs flex items-center gap-1.5"
            >
              <UserPlus className="w-3.5 h-3.5" />
              Add User
            </button>
          </div>
        </div>

        {showForm && (
          <form
            onSubmit={handleCreate}
            className="mt-4 p-4 bg-slate-800/50 rounded-lg flex flex-wrap items-end gap-3"
          >
            <div>
              <label className="block text-xs text-slate-400 mb-1">Email</label>
              <input
                type="email"
                required
                value={form.email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, email: e.target.value }))
                }
                placeholder="user@example.com"
                className="input text-xs h-8 w-56"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Password
              </label>
              <input
                type="text"
                required
                value={form.password}
                onChange={(e) =>
                  setForm((f) => ({ ...f, password: e.target.value }))
                }
                placeholder="min. 6 characters"
                className="input text-xs h-8 w-40"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) =>
                  setForm((f) => ({ ...f, role: e.target.value }))
                }
                className="bg-slate-700 border border-slate-600 rounded-lg text-xs px-2 py-1.5 h-8 text-white"
              >
                <option value="admin">admin</option>
                <option value="auditor">auditor</option>
                <option value="analyst">analyst</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={creating}
              className="btn-primary text-xs flex items-center gap-1.5 h-8"
            >
              {creating ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <UserPlus className="w-3 h-3" />
              )}
              Create
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="btn-secondary text-xs h-8"
            >
              Cancel
            </button>
          </form>
        )}
      </div>

      <div className="card">
        {error && (
          <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg p-3 mb-4">
            <p className="text-xs text-amber-300">
              Could not reach Supabase admin API: {error}. Make sure{" "}
              <code className="font-mono">SUPABASE_SERVICE_KEY</code> in the
              backend's <code className="font-mono">.env</code> is the{" "}
              <strong>service_role</strong> key, not the anon key.
            </p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700">
                {[
                  "Email",
                  "Role",
                  "Confirmed",
                  "Last Sign-in",
                  "Created",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-2 text-slate-400 font-semibold"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  className="border-b border-slate-800/50 hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2 text-slate-200">{u.email}</td>
                  <td className="px-3 py-2">
                    <select
                      value={u.role}
                      disabled={savingId === u.id}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      className="bg-slate-700 border border-slate-600 rounded-lg text-xs px-2 py-1 text-white"
                    >
                      <option value="admin">admin</option>
                      <option value="auditor">auditor</option>
                      <option value="analyst">analyst</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    {u.confirmed ? (
                      <span className="text-green-400">✓ Confirmed</span>
                    ) : (
                      <span className="text-slate-500">Pending</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {u.lastSignInAt
                      ? formatDistanceToNow(new Date(u.lastSignInAt), {
                          addSuffix: true,
                        })
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {u.createdAt
                      ? formatDistanceToNow(new Date(u.createdAt), {
                          addSuffix: true,
                        })
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => handleDelete(u.id, u.email)}
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && !error && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-slate-500"
                  >
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FR-14: Manage AI Models
// ─────────────────────────────────────────────
function ModelsTab() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [threshold, setThreshold] = useState(0.48);
  const [weights, setWeights] = useState({
    xgboost: 1.0,
    autoencoder: 0,
    isolation_forest: 0,
  });
  const [gnnStatus, setGnnStatus] = useState(null);
  const [gnnLoading, setGnnLoading] = useState(true);

  useEffect(() => {
    adminAPI
      .getModelConfig()
      .then((r) => {
        setConfig(r.data);
        setThreshold(r.data.ensemble_threshold);
        setWeights(r.data.ensemble_weights);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    adminAPI
      .getGnnStatus()
      .then((r) => setGnnStatus(r.data))
      .catch(() => setGnnStatus({ available: false }))
      .finally(() => setGnnLoading(false));
  }, []);

  const weightSum = Object.values(weights).reduce(
    (a, b) => a + Number(b || 0),
    0,
  );

  const handleSaveThreshold = async () => {
    setSaving(true);
    try {
      const res = await adminAPI.updateModelConfig({
        ensemble_threshold: parseFloat(threshold),
      });
      setConfig((c) => ({ ...c, ...res.data }));
      toast.success("Threshold updated");
    } catch (err) {
      toast.error("Failed: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWeights = async () => {
    if (Math.abs(weightSum - 1) > 0.01) {
      toast.error(
        `Weights must sum to 1.0 (currently ${weightSum.toFixed(2)})`,
      );
      return;
    }
    setSaving(true);
    try {
      const res = await adminAPI.updateModelConfig({
        ensemble_weights: weights,
      });
      setConfig((c) => ({ ...c, ...res.data }));
      toast.success("Ensemble weights updated");
    } catch (err) {
      toast.error("Failed: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleGnnWeight = (enable) => {
    setWeights((w) => {
      const next = { ...w };
      if (enable) {
        // Carve out 20% for the GNN from xgboost's share, rather than just
        // appending a weight that would push the sum above 1.0 and force
        // the admin to manually rebalance everything before they can save.
        const take = Math.min(0.2, Number(next.xgboost || 0));
        next.xgboost = Number((Number(next.xgboost || 0) - take).toFixed(2));
        next.gnn = take;
      } else {
        next.xgboost = Number(
          (Number(next.xgboost || 0) + Number(next.gnn || 0)).toFixed(2),
        );
        delete next.gnn;
      }
      return next;
    });
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
      </div>
    );

  if (error) {
    return (
      <div className="card">
        <p className="text-xs text-amber-300">
          Could not reach the AI Engine config endpoint: {error}. Make sure the
          AI Engine (FastAPI, port 8000) is running.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-1">
          Fraud Threshold
        </h3>
        <p className="text-xs text-slate-400 mb-4">
          A transaction is flagged as fraud when its risk score is at or above
          this value. The default (0.48) is the F1-optimal threshold tuned on
          the validation period for the final XGBoost + Autoencoder model. Lower
          = more sensitive (more flags, more false positives); higher =
          stricter. See Performance Analytics → Operating points for the
          precision/recall trade-offs.
        </p>
        <div className="flex items-center gap-4 max-w-lg">
          <input
            type="range"
            min="0.05"
            max="0.9"
            step="0.01"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="flex-1"
          />
          <span className="text-sm font-bold text-white w-16 text-right">
            {Number(threshold).toFixed(2)}
          </span>
          <button
            onClick={handleSaveThreshold}
            disabled={saving}
            className="btn-primary text-xs flex items-center gap-1.5 flex-shrink-0"
          >
            {saving ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Save className="w-3 h-3" />
            )}
            Save
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-1">
          Ensemble Weights
        </h3>
        <p className="text-xs text-slate-400 mb-4">
          How much each model contributes to the final risk score. Must sum to
          1.0. The default is 100% XGBoost (the Autoencoder is already an input
          feature of it, and the ablation showed extra blending adds nothing).
          If you change the weights, re-tune the threshold above — the Isolation
          Forest / Autoencoder scores use a different 0–1 scale than the XGBoost
          probability. Current sum:{" "}
          <span
            className={
              Math.abs(weightSum - 1) > 0.01
                ? "text-red-400 font-bold"
                : "text-green-400 font-bold"
            }
          >
            {weightSum.toFixed(2)}
          </span>
        </p>
        <div className="space-y-3 max-w-lg">
          {Object.entries(weights).map(([model, val]) => (
            <div key={model} className="flex items-center gap-3">
              <span className="text-xs text-slate-300 w-32 capitalize">
                {model.replace("_", " ")}
              </span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={val}
                onChange={(e) =>
                  setWeights((w) => ({ ...w, [model]: e.target.value }))
                }
                className="input text-xs h-8 w-24"
              />
            </div>
          ))}
        </div>
        {gnnStatus?.available && !("gnn" in weights) && (
          <button
            onClick={() => toggleGnnWeight(true)}
            className="btn-secondary text-xs mt-3 flex items-center gap-1.5"
          >
            <Network className="w-3 h-3" /> Add GNN to the ensemble
          </button>
        )}
        {"gnn" in weights && (
          <button
            onClick={() => toggleGnnWeight(false)}
            className="text-xs text-slate-500 hover:text-red-400 mt-2 underline"
          >
            Remove GNN from the ensemble
          </button>
        )}
        <button
          onClick={handleSaveWeights}
          disabled={saving}
          className="btn-primary text-xs flex items-center gap-1.5 mt-4"
        >
          {saving ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Save className="w-3 h-3" />
          )}
          Save Weights
        </button>
        {"gnn" in weights && (
          <p className="text-xs text-slate-500 mt-2">
            A "gnn" weight here only takes effect for jobs uploaded with the GNN
            option checked (Upload page) — it has no effect on jobs that didn't
            request it.
          </p>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Network className="w-4 h-4 text-purple-400" /> Graph Neural Network
            (GNN)
          </h3>
          {!gnnLoading && (
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-semibold
              ${gnnStatus?.available ? "bg-purple-500/10 text-purple-300" : "bg-slate-700 text-slate-400"}`}
            >
              {gnnStatus?.available ? "Available" : "Not loaded"}
            </span>
          )}
        </div>

        {gnnLoading ? (
          <Loader2 className="w-4 h-4 text-slate-500 animate-spin mt-2" />
        ) : gnnStatus?.available ? (
          <div className="space-y-3 mt-3">
            <p className="text-xs text-slate-400">
              An optional extra: an edge-aware graph neural network, trained
              separately from the core detector, that scores transactions using
              the account-connection graph. It works on a whole batch/period
              graph (batch analysis, not real-time), so use it as an
              investigation aid next to the network graph. Selectable per-upload
              from the Upload page, or blended into the score above.
            </p>
            <div className="grid grid-cols-2 gap-3 max-w-md">
              {[
                ["Architecture", gnnStatus.architecture || "GINE"],
                ["Layers", gnnStatus.n_layers],
                ["Hidden dim", gnnStatus.hidden_dim],
                ["Decision threshold", gnnStatus.threshold?.toFixed(4)],
                ["Edge features", gnnStatus.edge_feature_count],
                ["Node features", gnnStatus.node_feature_count],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex justify-between text-xs bg-slate-800/50 rounded-lg px-3 py-2"
                >
                  <span className="text-slate-400">{label}</span>
                  <span className="text-slate-200 font-medium">
                    {value ?? "—"}
                  </span>
                </div>
              ))}
            </div>
            {gnnStatus.test_performance && (
              <div className="text-xs text-slate-500">
                Test performance (from training):{" "}
                {Object.entries(gnnStatus.test_performance)
                  .map(
                    ([k, v]) =>
                      `${k}=${typeof v === "number" ? v.toFixed(4) : v}`,
                  )
                  .join(", ")}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-3 bg-slate-800/50 rounded-lg p-3 space-y-2">
            <p className="text-xs text-slate-400">
              The GNN isn't loaded on the AI Engine right now — the rest of the
              platform (Autoencoder + XGBoost + Isolation Forest signal) is
              completely unaffected by this.
            </p>
            <p className="text-xs text-slate-500">
              It needs no extra packages beyond PyTorch (already required). Make
              sure the folder
              <code className="mx-1">
                ai-engine/saved_models/deepguard_gnn_results/models/
              </code>
              (from the GNN notebook) exists, then restart the AI Engine and
              look for the startup line "✅ GNN loaded" (or the specific error).
            </p>
          </div>
        )}
      </div>

      {config?.model_performance && (
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-3">
            Model Performance (from training)
          </h3>
          <p className="text-xs text-slate-500">
            Full evaluation tables and figures:
            ai-engine/saved_models/deepguard_training_results/ (tables/ and
            figures/).
          </p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// FR-18: Bulk Processing Queue
// ─────────────────────────────────────────────
function QueueTab() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  // Live-ish view without a websocket. This used to poll every 4 s (15 requests a minute, even from a background tab),
  // which on its own used up the old 200-requests-per-15-minutes API limit. Now: every 8 s, only while the tab is
  // visible, never two requests at once, and it backs off (up to 60 s) when the backend is struggling.
  useEffect(() => {
    let alive = true,
      inFlight = false,
      delay = 8000,
      timer;
    const schedule = () => {
      if (alive) timer = setTimeout(tick, delay);
    };
    const tick = async () => {
      if (document.hidden || inFlight) return schedule();
      inFlight = true;
      try {
        const r = await adminAPI.getQueueStatus();
        if (alive) {
          setStatus(r.data);
          setError(null);
          delay = 8000;
        }
      } catch (e) {
        if (alive)
          setError(
            e.response?.status === 429
              ? "Too many requests — slowing down"
              : e.message,
          );
        delay = Math.min(delay * 2, 60000);
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (error)
    return (
      <div className="card">
        <p className="text-xs text-amber-300">
          Could not reach the backend: {error}
        </p>
      </div>
    );
  if (!status)
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
      </div>
    );

  const cards = [
    { label: "Waiting", value: status.waiting, color: "amber" },
    { label: "Active", value: status.active, color: "sky" },
    { label: "Completed", value: status.completed, color: "green" },
    { label: "Failed", value: status.failed, color: "red" },
  ];

  return (
    <div className="space-y-6">
      <div className="card flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">
            Upload Processing Queue
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Backed by{" "}
            <b className="text-slate-300">
              {status.mode === "redis" ? "Redis (Bull)" : "in-process memory"}
            </b>
            , concurrency {status.concurrency} — {status.concurrency} file
            {status.concurrency === 1 ? "" : "s"} can be analyzed at once, the
            rest wait their turn automatically.
          </p>
        </div>
        {status.mode !== "redis" && (
          <span className="text-xs text-amber-300 bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-1.5 max-w-xs">
            Set <code className="font-mono">REDIS_URL</code> in the backend's
            .env for a persistent, Redis-backed queue. Works fine without it for
            typical use.
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ label, value, color }) => (
          <div key={label} className="card text-center">
            <p
              className={`text-3xl font-bold ${
                color === "amber"
                  ? "text-amber-400"
                  : color === "sky"
                    ? "text-sky-400"
                    : color === "green"
                      ? "text-green-400"
                      : "text-red-400"
              }`}
            >
              {value ?? 0}
            </p>
            <p className="text-xs text-slate-400 mt-1">{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FR-20: Data Backup and Recovery
// ─────────────────────────────────────────────
function BackupsTab() {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busyName, setBusyName] = useState(null);
  const [error, setError] = useState(null);

  // NOTE: must not be `useEffect(load, [])` with `load` as a single-expression
  // arrow function — that returns the promise chain itself, and React treats
  // whatever a useEffect callback returns as its cleanup function. Calling a
  // Promise as if it were a function throws "destroy is not a function" —
  // most visibly under React.StrictMode (main.jsx), which deliberately
  // mounts/unmounts/remounts once in development to catch bugs like this one.
  // Wrapping in a block-bodied effect fixes it: the effect now returns
  // undefined, as useEffect requires.
  const load = () =>
    adminAPI
      .getBackups()
      .then((r) => {
        setBackups(Array.isArray(r.data) ? r.data : []);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);

  const handleRun = async () => {
    setRunning(true);
    try {
      await adminAPI.runBackup();
      toast.success("Backup created");
      load();
    } catch (err) {
      toast.error(
        "Backup failed: " + (err.response?.data?.error || err.message),
      );
    } finally {
      setRunning(false);
    }
  };

  const handleRestore = async (name) => {
    if (
      !window.confirm(
        `Restore "${name}"? Existing records with matching IDs will be overwritten. Nothing is deleted.`,
      )
    )
      return;
    setBusyName(name);
    try {
      const res = await adminAPI.restoreBackup(name);
      toast.success(`Restored: ${JSON.stringify(res.data.restored)}`);
    } catch (err) {
      toast.error(
        "Restore failed: " + (err.response?.data?.error || err.message),
      );
    } finally {
      setBusyName(null);
    }
  };

  const handleDownload = async (name) => {
    try {
      const res = await adminAPI.downloadBackup(name);
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(
        "Download failed: " + (err.response?.data?.error || err.message),
      );
    }
  };

  const handleDelete = async (name) => {
    if (!window.confirm(`Delete backup "${name}"? This cannot be undone.`))
      return;
    try {
      await adminAPI.deleteBackup(name);
      setBackups((prev) => prev.filter((b) => b.name !== name));
    } catch (err) {
      toast.error(
        "Delete failed: " + (err.response?.data?.error || err.message),
      );
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 className="w-7 h-7 text-sky-400 animate-spin" />
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="card flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Backups</h3>
          <p className="text-xs text-slate-400 mt-1">
            Automatic daily backup at 2:00 AM, retained 30 days. Covers all jobs
            and transaction records — verified for corruption before every
            restore, and restoring never deletes anything (it only
            adds/overwrites by ID).
          </p>
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          className="btn-primary text-xs flex items-center gap-1.5 flex-shrink-0"
        >
          {running ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Database className="w-3 h-3" />
          )}
          Back Up Now
        </button>
      </div>

      {error && (
        <div className="card">
          <p className="text-xs text-amber-300">
            Could not reach the backend: {error}
          </p>
        </div>
      )}

      <div className="card">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-700">
              {["Created", "Jobs", "Transactions", "Size", ""].map((h) => (
                <th
                  key={h}
                  className="text-left px-3 py-2 text-slate-400 font-semibold"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr
                key={b.name}
                className="border-b border-slate-800/50 hover:bg-slate-800/40"
              >
                <td className="px-3 py-2 text-slate-200">
                  {formatDistanceToNow(new Date(b.createdAt), {
                    addSuffix: true,
                  })}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {b.counts?.jobs ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {b.counts?.transactions ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-400">
                  {(b.size / 1024).toFixed(1)} KB
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDownload(b.name)}
                      title="Download"
                      className="p-1.5 rounded-lg hover:bg-sky-500/10 text-slate-400 hover:text-sky-400"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleRestore(b.name)}
                      disabled={busyName === b.name}
                      title="Restore"
                      className="p-1.5 rounded-lg hover:bg-green-500/10 text-slate-400 hover:text-green-400 disabled:opacity-40"
                    >
                      {busyName === b.name ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(b.name)}
                      title="Delete"
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {backups.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-slate-500"
                >
                  No backups yet — click "Back Up Now" or wait for the 2:00 AM
                  schedule.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// FR-15: System Logs
// ─────────────────────────────────────────────
function LogsTab() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    setLoading(true);
    adminAPI
      .getLogs({ status: statusFilter || undefined })
      .then((r) => setLogs(Array.isArray(r.data?.logs) ? r.data.logs : []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">
          System Logs — Upload & Processing Audit Trail
        </h3>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-slate-700 border border-slate-600 rounded-lg text-xs px-2 py-1 text-white"
        >
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="analyzing">Analyzing</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700">
                {[
                  "Job ID",
                  "File",
                  "User",
                  "Status",
                  "Total",
                  "Flagged",
                  "Took",
                  "Error",
                  "Created",
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left px-3 py-2 text-slate-400 font-semibold"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.jobId}
                  className="border-b border-slate-800/50 hover:bg-slate-800/40"
                >
                  <td className="px-3 py-2 font-mono text-slate-300">
                    {log.jobId?.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2 text-slate-200 max-w-36 truncate">
                    {log.originalName}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-400">
                    {log.userId?.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        log.status === "completed"
                          ? "bg-green-500/10 text-green-400"
                          : log.status === "failed"
                            ? "bg-red-500/10 text-red-400"
                            : "bg-amber-500/10 text-amber-400"
                      }`}
                    >
                      {log.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-200">
                    {(log.totalTransactions || 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-red-400">
                    {(log.flaggedCount || 0).toLocaleString()}
                  </td>
                  <td
                    className="px-3 py-2 text-slate-300 tabular-nums whitespace-nowrap"
                    title={breakdownText(log) || undefined}
                  >
                    {log.status === "completed" || log.status === "failed"
                      ? formatDuration(getJobTiming(log).tookMs)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-red-400 max-w-48 truncate">
                    {log.errorMessage || "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-400">
                    {formatDistanceToNow(new Date(log.createdAt), {
                      addSuffix: true,
                    })}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-8 text-center text-slate-500"
                  >
                    No logs found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const MOCK_STATS = {
  totalJobs: 12,
  totalTransactions: 520000,
  totalFraud: 18420,
};
const MOCK_JOBS = [
  {
    jobId: "abc123",
    originalName: "HI_Small_Trans.csv",
    userId: "user001",
    totalTransactions: 52000,
    flaggedCount: 1842,
    status: "completed",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    jobId: "def456",
    originalName: "LI_Small_Trans.csv",
    userId: "user002",
    totalTransactions: 73430,
    flaggedCount: 2000,
    status: "completed",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
];
