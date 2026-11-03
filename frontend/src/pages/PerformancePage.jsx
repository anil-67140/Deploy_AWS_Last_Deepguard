import { useEffect, useState } from "react";
import { dashboardAPI } from "../utils/api";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  Cell,
} from "recharts";
import { describeFeature } from "../utils/featureLabels";
import {
  Gauge,
  Clock,
  Database,
  Cpu,
  Loader2,
  Info,
  Network,
  Target,
} from "lucide-react";

/**
 * FR-12 — View Performance Analytics.
 *
 * Two distinct things live on this page, deliberately kept separate:
 *   1. MODEL performance — how good is the AI? (ROC-AUC, Average Precision,
 *      F1, SHAP feature importance) — sourced from the AI Engine's own
 *      evaluated training outputs via GET /dashboard/performance (AI Engine /models/info).
 *   2. SYSTEM performance — how fast is the pipeline? (processing time,
 *      throughput, job history trend) — computed from Job records.
 */

function StatCard({ icon: Icon, label, value, sub, color = "sky" }) {
  const colorMap = {
    sky: "text-sky-400 bg-sky-500/10 border-sky-500/20",
    violet: "text-violet-400 bg-violet-500/10 border-violet-500/20",
    green: "text-green-400 bg-green-500/10 border-green-500/20",
    amber: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  };
  return (
    <div className="card flex items-start gap-4">
      <div
        className={`w-10 h-10 rounded-lg border flex items-center justify-center flex-shrink-0 ${colorMap[color]}`}
      >
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-xs text-slate-400 mb-0.5">{label}</p>
        <p className="text-2xl font-bold text-white">{value}</p>
        {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// Display order of the model keys. Labels come from the AI Engine (metadata.model_labels); anything not listed is appended.
const MODEL_ORDER = [
  "isolation_forest",
  "autoencoder",
  "ae_if_unsupervised",
  "xgboost",
  "xgboost_ae",
  "xgboost_if",
  "xgboost_ae_if",
  "gnn",
  "xgboost_gnn_blend",
];
const FALLBACK_LABELS = {
  isolation_forest: "Isolation Forest",
  autoencoder: "Autoencoder",
  ae_if_unsupervised: "AE + IF (unsupervised)",
  xgboost: "XGBoost (base)",
  xgboost_ae: "XGBoost + AE",
  xgboost_if: "XGBoost + IF",
  xgboost_ae_if: "XGBoost + AE + IF",
  gnn: "GNN (optional extra)",
  xgboost_gnn_blend: "XGBoost + GNN blend (extra)",
};

/**
 * model_metadata stores performance as FLAT scalar keys, e.g.
 *   { isolation_forest_roc_auc: 0.673, isolation_forest_avg_prec: 0.0026, xgboost_ae_f1: 0.736, xgboost_ae_precision: 0.865, ... }
 * — NOT nested per-model objects. This groups those flat keys back into one row per model so they can be charted and tabulated.
 */
function buildModelRows(perf, labels = {}) {
  const byModel = {};
  for (const [key, value] of Object.entries(perf || {})) {
    if (typeof value !== "number") continue;
    const m = key.match(/^(.+)_(roc_auc|avg_prec|f1|precision|recall|mcc)$/);
    if (!m) continue;
    const [, modelKey, metric] = m;
    if (!byModel[modelKey]) {
      const idx = MODEL_ORDER.indexOf(modelKey);
      byModel[modelKey] = {
        key: modelKey,
        name:
          labels[modelKey] ||
          FALLBACK_LABELS[modelKey] ||
          modelKey
            .split("_")
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join(" "),
        order: idx >= 0 ? idx : 99,
      };
    }
    const field = {
      roc_auc: "rocAuc",
      avg_prec: "avgPrecision",
      f1: "f1",
      precision: "precision",
      recall: "recall",
      mcc: "mcc",
    }[metric];
    byModel[modelKey][field] = value;
  }
  return Object.values(byModel).sort((a, b) => a.order - b.order);
}

const f3 = (v) => (typeof v === "number" ? v.toFixed(3) : "—");

export default function PerformancePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await dashboardAPI.getPerformance();
      setData(res.data);
    } catch {
      setData(MOCK_PERFORMANCE);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-sky-400 animate-spin" />
      </div>
    );
  }

  const perf = data?.modelPerformance || {};
  const shap = data?.shapFeatureImportance || {};
  const sys = data?.systemStats || {};

  // Model comparison bars (ROC-AUC + Average Precision per model)
  const modelRows = buildModelRows(perf, data?.modelLabels || {});
  const finalModel = data?.finalModel || null;
  const fm = finalModel?.test_metrics || {};
  const finalKey = finalModel?.key;
  const ops = data?.operatingPoints || [];

  const shapRows = Object.entries(shap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([feature, importance]) => {
      const d = describeFeature(feature);
      return {
        feature,
        label: d.label,
        desc: d.desc,
        groupLabel: d.groupLabel,
        color: d.color,
        importance: Number(
          importance.toFixed ? importance.toFixed(4) : importance,
        ),
      };
    });

  const trend = (data?.recentJobsTrend || []).map((j, i) => ({
    name: `#${i + 1}`,
    seconds: j.processingTimeMs ? +(j.processingTimeMs / 1000).toFixed(1) : 0,
    transactions: j.totalTransactions || 0,
  }));

  const avgSeconds = sys.avgProcessingTimeMs
    ? (sys.avgProcessingTimeMs / 1000).toFixed(1)
    : "—";

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Gauge className="w-5 h-5 text-sky-400" /> Performance Analytics
        </h1>
        <p className="text-slate-400 text-sm mt-0.5">
          Model accuracy and system throughput — FR-12
        </p>
      </div>

      {data?.demoMode && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center gap-2 text-xs text-amber-300">
          <Info className="w-4 h-4 flex-shrink-0" />
          AI Engine is offline or in demo mode — the figures below are a saved
          snapshot of the last training run, not live data.
        </div>
      )}

      {/* System stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Database}
          label="Jobs Processed"
          value={(sys.totalJobsRun || 0).toLocaleString()}
          color="sky"
        />
        <StatCard
          icon={Target}
          label="Transactions Analyzed"
          value={(sys.totalTransactionsProcessed || 0).toLocaleString()}
          color="green"
        />
        <StatCard
          icon={Clock}
          label="Avg. Processing Time"
          value={`${avgSeconds}s`}
          sub={
            sys.maxProcessingTimeMs
              ? `max ${(sys.maxProcessingTimeMs / 1000).toFixed(1)}s`
              : undefined
          }
          color="amber"
        />
        <StatCard
          icon={Cpu}
          label="GNN Status"
          value={data?.gnnAvailable ? "Available" : "Not loaded"}
          sub={
            data?.gnnAvailable ? "Optional extra module" : "Core models only"
          }
          color="violet"
        />
      </div>

      {/* Final model headline */}
      {finalModel && (
        <div className="card">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <h3 className="text-sm font-semibold text-white">
              Final detector:{" "}
              <span className="text-sky-300">{finalModel.label}</span>
            </h3>
            <span className="text-xs text-slate-400">
              decision threshold{" "}
              {typeof finalModel.threshold === "number"
                ? finalModel.threshold.toFixed(3)
                : "—"}{" "}
              (tuned on validation) · {finalModel.n_features} features
            </span>
          </div>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 text-center">
            {[
              ["Precision", fm.Precision],
              ["Recall", fm.Recall],
              ["F1", fm.F1],
              ["Avg. Precision", fm.AP_PR_AUC],
              ["ROC-AUC", fm.ROC_AUC],
              ["MCC", fm.MCC],
            ].map(([k, v]) => (
              <div key={k} className="p-3 rounded-lg bg-slate-700/40">
                <p className="text-xs text-slate-400">{k}</p>
                <p className="text-xl font-bold text-white mt-1">{f3(v)}</p>
              </div>
            ))}
          </div>
          {fm.TP != null && (
            <p className="text-xs text-slate-400 mt-3">
              On the held-out test period it caught{" "}
              <span className="text-slate-200 font-semibold">
                {Number(fm.TP).toLocaleString()}
              </span>{" "}
              of{" "}
              <span className="text-slate-200 font-semibold">
                {(Number(fm.TP) + Number(fm.FN)).toLocaleString()}
              </span>{" "}
              laundering transactions with only{" "}
              <span className="text-slate-200 font-semibold">
                {Number(fm.FP).toLocaleString()}
              </span>{" "}
              false alarms among{" "}
              <span className="text-slate-200 font-semibold">
                {(
                  Number(fm.TP) +
                  Number(fm.FN) +
                  Number(fm.FP) +
                  Number(fm.TN)
                ).toLocaleString()}
              </span>{" "}
              transactions.
            </p>
          )}
        </div>
      )}

      {/* Model performance */}
      <div className="card">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-white">
            Model Comparison (ROC-AUC vs Average Precision)
          </h3>
          <span className="text-xs text-slate-400">
            same untouched, later test period for every model
          </span>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Fraud is only ~0.18% of the test transactions, so accuracy is
          meaningless (≈99.9% for a model that finds nothing). Average
          Precision, precision, recall, F1 and MCC are the honest measures.
          Isolation Forest and the Autoencoder are unsupervised (they never see
          labels), so on their own they are weak; the supervised XGBoost on
          past-behaviour features does the heavy lifting, and the AE score is
          used as extra input features.
        </p>
        {modelRows.length > 0 ? (
          <>
            <ResponsiveContainer
              width="100%"
              height={Math.max(240, modelRows.length * 34)}
            >
              <BarChart
                data={modelRows}
                layout="vertical"
                margin={{ left: 24 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#334155"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  domain={[0, 1]}
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fill: "#cbd5e1", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={150}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1e293b",
                    border: "1px solid #334155",
                    borderRadius: 8,
                  }}
                />
                <Legend
                  formatter={(v) => (
                    <span style={{ color: "#94a3b8", fontSize: 11 }}>{v}</span>
                  )}
                />
                <Bar
                  dataKey="rocAuc"
                  name="ROC-AUC"
                  fill="#38bdf8"
                  radius={[0, 4, 4, 0]}
                />
                <Bar
                  dataKey="avgPrecision"
                  name="Avg. Precision"
                  fill="#a78bfa"
                  radius={[0, 4, 4, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-700">
                    {[
                      "Model",
                      "Precision",
                      "Recall",
                      "F1",
                      "Avg. Prec.",
                      "ROC-AUC",
                      "MCC",
                    ].map((h) => (
                      <th key={h} className="py-2 pr-4 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modelRows.map((r) => (
                    <tr
                      key={r.key}
                      className={`border-b border-slate-800 ${r.key === finalKey ? "bg-sky-500/10 text-sky-200" : "text-slate-300"}`}
                    >
                      <td className="py-2 pr-4 font-medium">
                        {r.name}
                        {r.key === finalKey ? "  ★ final" : ""}
                      </td>
                      <td className="pr-4">{f3(r.precision)}</td>
                      <td className="pr-4">{f3(r.recall)}</td>
                      <td className="pr-4">{f3(r.f1)}</td>
                      <td className="pr-4">{f3(r.avgPrecision)}</td>
                      <td className="pr-4">{f3(r.rocAuc)}</td>
                      <td className="pr-4">{f3(r.mcc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="h-48 flex items-center justify-center text-slate-500 text-sm">
            No evaluated models yet
          </div>
        )}
      </div>

      {ops.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-1">
            Operating points (final model)
          </h3>
          <p className="text-xs text-slate-500 mb-3">
            Thresholds chosen on validation data. Lower thresholds catch more
            fraud but raise more alerts for analysts to review.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700">
                  {[
                    "Operating point",
                    "Threshold",
                    "Precision",
                    "Recall",
                    "F1",
                    "Alerts",
                  ].map((h) => (
                    <th key={h} className="py-2 pr-4 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ops.map((o, i) => (
                  <tr
                    key={i}
                    className="border-b border-slate-800 text-slate-300"
                  >
                    <td className="py-2 pr-4 font-medium">
                      {o["Operating point"]}
                    </td>
                    <td className="pr-4">
                      {typeof o.Threshold === "number"
                        ? o.Threshold.toFixed(4)
                        : "—"}
                    </td>
                    <td className="pr-4">{f3(o.Precision)}</td>
                    <td className="pr-4">{f3(o.Recall)}</td>
                    <td className="pr-4">{f3(o.F1)}</td>
                    <td className="pr-4">
                      {o.Alerts != null
                        ? Number(o.Alerts).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* SHAP feature importance */}
        <div className="card">
          <h3 className="text-sm font-semibold text-white">
            What the model relies on most
          </h3>
          <p className="text-xs text-slate-400 mt-0.5 mb-4">
            Global SHAP importance — the 8 factors with the biggest average
            effect on the fraud score. Colour = type of signal.
          </p>
          {shapRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={shapRows} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#334155"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: "#cbd5e1", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={190}
                />
                <Tooltip
                  cursor={{ fill: "rgba(148,163,184,0.06)" }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const r = payload[0].payload;
                    return (
                      <div className="bg-slate-950/95 border border-slate-600 rounded-lg p-2.5 shadow-xl max-w-xs">
                        <p className="text-xs font-semibold text-white">
                          {r.label}
                        </p>
                        <p className="text-[10px] font-mono text-slate-500 mb-1">
                          {r.feature} · {r.groupLabel}
                        </p>
                        {r.desc && (
                          <p className="text-[11px] text-slate-300 leading-snug mb-1">
                            {r.desc}
                          </p>
                        )}
                        <p className="text-[11px] text-slate-400">
                          Mean |SHAP|:{" "}
                          <b className="text-white">{r.importance}</b>
                        </p>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="importance" radius={[0, 4, 4, 0]}>
                  {shapRows.map((r, i) => (
                    <Cell key={i} fill={r.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">
              No SHAP data yet
            </div>
          )}
        </div>

        {/* Processing time trend */}
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-4">
            Processing Time — Recent Jobs
          </h3>
          {trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  unit="s"
                />
                <Tooltip
                  contentStyle={{
                    background: "#1e293b",
                    border: "1px solid #334155",
                    borderRadius: 8,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="seconds"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  name="Seconds"
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">
              No completed jobs yet
            </div>
          )}
        </div>
      </div>

      {data?.gnnAvailable && data?.gnnPerformance && (
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <Network className="w-4 h-4 text-violet-400" /> GNN Model (optional
            extra — batch network analysis)
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            {Object.entries(data.gnnPerformance).map(([k, v]) => (
              <div key={k} className="p-3 rounded-lg bg-slate-700/40">
                <p className="text-xs text-slate-400 capitalize">
                  {k.replace(/_/g, " ")}
                </p>
                <p className="text-lg font-bold text-white mt-1">
                  {typeof v === "number" ? v.toFixed(3) : String(v)}
                </p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-3">
            The GNN scores a whole period's account graph at once (structure and
            features, never labels), so it is an investigation aid next to the
            graph visualiser — not the real-time scorer. It is reported on the
            same test period as the core models.
          </p>
        </div>
      )}
    </div>
  );
}

// Offline fallback: a snapshot of the REAL results of the last training run (DeepGuard_Training_Final.ipynb / GNN extra notebook),
// shown only when the backend cannot be reached. Live numbers always come from the AI Engine's saved training outputs.
const MOCK_PERFORMANCE = {
  demoMode: true,
  modelAvailable: false,
  gnnAvailable: false,
  modelPerformance: {
    isolation_forest_roc_auc: 0.6726,
    isolation_forest_avg_prec: 0.0026,
    isolation_forest_f1: 0.0059,
    isolation_forest_precision: 0.003,
    isolation_forest_recall: 0.7501,
    autoencoder_roc_auc: 0.8807,
    autoencoder_avg_prec: 0.0164,
    autoencoder_f1: 0.0466,
    autoencoder_precision: 0.0263,
    autoencoder_recall: 0.2087,
    xgboost_roc_auc: 0.9921,
    xgboost_avg_prec: 0.7406,
    xgboost_f1: 0.7337,
    xgboost_precision: 0.895,
    xgboost_recall: 0.6216,
    xgboost_ae_roc_auc: 0.992,
    xgboost_ae_avg_prec: 0.7436,
    xgboost_ae_f1: 0.7363,
    xgboost_ae_precision: 0.8649,
    xgboost_ae_recall: 0.6411,
    xgboost_ae_mcc: 0.7442,
    xgboost_if_roc_auc: 0.992,
    xgboost_if_avg_prec: 0.743,
    xgboost_if_f1: 0.7354,
    xgboost_if_precision: 0.8694,
    xgboost_if_recall: 0.6372,
    xgboost_ae_if_roc_auc: 0.9919,
    xgboost_ae_if_avg_prec: 0.7415,
    xgboost_ae_if_f1: 0.7344,
    xgboost_ae_if_precision: 0.8439,
    xgboost_ae_if_recall: 0.65,
  },
  finalModel: {
    key: "xgboost_ae",
    label: "XGBoost + AE",
    threshold: 0.4811,
    n_features: 56,
    test_metrics: {
      Precision: 0.8649,
      Recall: 0.6411,
      F1: 0.7363,
      AP_PR_AUC: 0.7436,
      ROC_AUC: 0.992,
      MCC: 0.7442,
      TP: 1152,
      FP: 180,
      FN: 645,
      TN: 1013692,
    },
  },
  shapFeatureImportance: {
    S_same_amt: 1.436,
    Payment_Format_enc: 1.133,
    Pair_n: 0.735,
    AE_z0: 0.717,
    S_dt_prev: 0.683,
    AE_err: 0.63,
    S_new_recv_rate: 0.447,
    AE_z6: 0.361,
  },
  systemStats: {
    totalJobsRun: 0,
    totalTransactionsProcessed: 0,
    avgProcessingTimeMs: 0,
    maxProcessingTimeMs: 0,
  },
  recentJobsTrend: [],
};
