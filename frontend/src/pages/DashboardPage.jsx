import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSelector } from "react-redux";
import { dashboardAPI, uploadAPI } from "../utils/api";
import {
  AreaChart,
  Area,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  AlertTriangle,
  Loader2,
  TrendingUp,
  Activity,
  FileUp,
  ChevronRight,
  Clock,
  Flame,
  Gauge,
  Layers,
  Briefcase,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import ChartTooltip from "../components/viz/ChartTooltip";
import { LEVEL_COLORS } from "../components/viz/riskBands";
import { formatDuration, getJobTiming } from "../utils/duration";
import { breakdownText } from "../components/JobTime";

const AXIS = { fill: "#64748b", fontSize: 11 };
const nf = (n) => Number(n || 0).toLocaleString();
const short = (s, n = 14) =>
  s && s.length > n ? s.slice(0, n - 1) + "…" : s || "";

/* ───────────────────────── building blocks ───────────────────────── */

function Sparkline({ data, color }) {
  if (!data || data.length < 2) return <div className="h-10" />;
  const id = `sp-${color.replace("#", "")}`;
  return (
    <ResponsiveContainer width="100%" height={40}>
      <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.45} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${id})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function KpiCard({ icon: Icon, label, value, sub, color, spark, delay = 0 }) {
  return (
    <div
      className="card-glass relative overflow-hidden fade-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className="absolute -top-10 -right-10 w-32 h-32 rounded-full blur-3xl opacity-20"
        style={{ background: color }}
      />
      <div className="flex items-start justify-between relative">
        <div className="min-w-0">
          <p className="eyebrow">{label}</p>
          <p className="text-[28px] leading-tight font-bold text-white mt-1 tabular-nums">
            {value}
          </p>
          {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
        </div>
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: `${color}22`, border: `1px solid ${color}44` }}
        >
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
      </div>
      <div className="mt-2 -mx-1">
        <Sparkline data={spark} color={color} />
      </div>
    </div>
  );
}

function CardHeader({ title, sub, right }) {
  return (
    <div className="flex items-start justify-between mb-4 gap-3">
      <div>
        <h3 className="section-title">{title}</h3>
        {sub && <p className="section-sub">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function Empty({ children, h = "h-48" }) {
  return (
    <div
      className={`${h} flex items-center justify-center text-slate-500 text-sm text-center px-6`}
    >
      {children}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="skeleton h-10 w-72" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-36" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="skeleton h-72 lg:col-span-2" />
        <div className="skeleton h-72" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="skeleton h-64" />
        <div className="skeleton h-64" />
      </div>
    </div>
  );
}

function RiskChip({ level }) {
  const c = LEVEL_COLORS[level] || "#64748b";
  return (
    <span
      className="chip"
      style={{ color: c, borderColor: `${c}55`, background: `${c}1a` }}
    >
      <i className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />
      {level}
    </span>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function DashboardPage() {
  const { user } = useSelector((s) => s.auth);
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [threshold, setThreshold] = useState(null); // alert threshold 0-1 (from the AI engine)
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  // Earlier analyses get their dashboard summary built once, in the background. While that is happening the charts
  // are partial, so say so and re-check every few seconds (max 10 times) instead of leaving stale numbers.
  const [pending, setPending] = useState(0);
  const retries = useRef(0);
  useEffect(() => {
    if (!pending || retries.current >= 10) return;
    const t = setTimeout(() => {
      retries.current += 1;
      dashboardAPI
        .getOverview()
        .then((r) => {
          setOverview(r.data);
          if (Array.isArray(r.data?.recentJobs)) setJobs(r.data.recentJobs);
          setPending(r.data?.summaryPending || 0);
        })
        .catch(() => {});
    }, 6000);
    return () => clearTimeout(t);
  }, [pending, overview]);

  const loadData = async () => {
    setLoading(true);
    try {
      const ovRes = await dashboardAPI.getOverview();
      setOverview(ovRes.data);
      setPending(ovRes.data?.summaryPending || 0);
      // recentJobs now covers every analysis done so far (not only this account's uploads).
      // Older backends don't send it, so fall back to the user's own job list.
      let list = ovRes.data?.recentJobs;
      if (!Array.isArray(list)) list = (await uploadAPI.getJobs()).data || [];
      setJobs(list);
      setDemo(false);
    } catch (e) {
      setOverview(MOCK_OVERVIEW);
      setJobs(MOCK_JOBS);
      setThreshold(0.481);
      setDemo(e.response?.status === 429 ? "limit" : "offline");
    } finally {
      setLoading(false);
    }
    // optional: only used to colour the alerting buckets of the histogram
    dashboardAPI
      .getPerformance()
      .then((r) => {
        if (r.data?.ensembleThreshold != null)
          setThreshold(r.data.ensembleThreshold);
      })
      .catch(() => {});
  };

  const totals = overview?.totals || {};
  const alerts = overview?.recentAlerts || [];

  const completed = useMemo(
    () =>
      jobs
        .filter((j) => j.status === "completed")
        .slice(0, 8)
        .reverse(),
    [jobs],
  );
  const spark = (key) => completed.map((j) => ({ v: j[key] || 0 }));

  // donut: where the risk is (Low is ~99% of any real file, so it would hide everything else)
  const byLevel = useMemo(() => {
    const m = Object.fromEntries(
      (overview?.riskBreakdown || []).map((r) => [r._id, r.count]),
    );
    return {
      Critical: m.Critical || 0,
      High: m.High || 0,
      Medium: m.Medium || 0,
      Low: m.Low || 0,
    };
  }, [overview]);
  const donutData = ["Critical", "High", "Medium"]
    .map((k) => ({ name: k, value: byLevel[k], color: LEVEL_COLORS[k] }))
    .filter((d) => d.value > 0);
  const attention = byLevel.Critical + byLevel.High + byLevel.Medium;
  const allTx = attention + byLevel.Low;

  const trendData = completed.map((j) => ({
    name: short(j.originalName?.replace(/\.[^.]+$/, ""), 12),
    file: j.originalName,
    flagged: j.flaggedCount || 0,
    critical: j.criticalCount || 0,
  }));

  const categories = (overview?.categoryBreakdown || []).map((c) => ({
    name: c._id || "Unknown",
    count: c.count,
  }));
  const maxCat = Math.max(1, ...categories.map((c) => c.count));

  const hist = useMemo(() => {
    const rows = overview?.scoreDistribution || [];
    if (!rows.length) return [];
    const by = Object.fromEntries(rows.map((b) => [b._id, b.count]));
    return [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((s) => ({
      bucket: s,
      label: `${s}–${s + 10}`,
      count: by[s] || 0,
    }));
  }, [overview]);
  // bucket colour: below the alert threshold = blue, the bucket that CONTAINS it = amber, fully above = red
  const histColor = (s) => {
    if (threshold == null) return "#38bdf8";
    const t = threshold * 100;
    return s >= t ? "#ef4444" : s + 10 > t ? "#f59e0b" : "#38bdf8";
  };

  if (loading) return <Skeleton />;

  const jobCount = totals.jobCount ?? jobs.length; // all-time number of analyses
  const flaggedPct =
    ((totals.totalFlagged || 0) / (totals.totalTransactions || 1)) * 100;
  const avgRisk = completed.length
    ? completed.reduce((a, j) => a + (j.averageRiskScore || 0), 0) /
      completed.length
    : 0;

  return (
    <div className="p-6 space-y-5 max-w-[1500px]">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 fade-up">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Welcome back,{" "}
            <span className="shimmer-text">
              {user?.email?.split("@")[0] || "Auditor"}
            </span>
          </h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
            <span className="mx-2 text-slate-700">•</span>
            Here’s what the models found across all analyses done so far.
          </p>
        </div>
        <button
          onClick={() => navigate("/upload")}
          className="btn-primary flex items-center gap-2 shadow-lg shadow-sky-500/20"
        >
          <FileUp className="w-4 h-4" /> Upload dataset
        </button>
      </div>

      {demo && (
        <div className="px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2 fade-up">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>
            {demo === "limit"
              ? "The API rate limit was hit"
              : "Backend unreachable"}{" "}
            — these numbers are <b>sample demo data</b>, not your real results.
          </span>
        </div>
      )}

      {!demo && pending > 0 && (
        <div className="px-4 py-2.5 rounded-xl bg-sky-500/10 border border-sky-500/30 text-xs text-sky-300 flex items-center gap-2 fade-up">
          <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" />
          <span>
            Indexing {pending} earlier analysis{pending === 1 ? "" : "es"} in
            the background (one-time) — the charts will include{" "}
            {pending === 1 ? "it" : "them"} in a few seconds.
          </span>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <KpiCard
          icon={Activity}
          label="Total transactions"
          color="#38bdf8"
          value={nf(totals.totalTransactions)}
          sub="analysed so far"
          spark={spark("totalTransactions")}
        />
        <KpiCard
          icon={Flame}
          label="Flagged as fraud"
          color="#f59e0b"
          value={nf(totals.totalFlagged)}
          delay={50}
          sub={`${flaggedPct.toFixed(2)}% of all transactions`}
          spark={spark("flaggedCount")}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Critical risk"
          color="#ef4444"
          value={nf(totals.totalCritical)}
          delay={100}
          sub={
            totals.totalFlagged
              ? `${(((totals.totalCritical || 0) / totals.totalFlagged) * 100).toFixed(0)}% of flagged`
              : "none flagged yet"
          }
          spark={spark("criticalCount")}
        />
        <KpiCard
          icon={Briefcase}
          label="Jobs processed"
          color="#22c55e"
          value={nf(jobCount)}
          delay={150}
          sub="All time"
          spark={spark("totalTransactions")}
        />
        <KpiCard
          icon={Gauge}
          label="Avg risk score"
          color="#a78bfa"
          value={avgRisk.toFixed(1)}
          delay={200}
          sub="mean of recent jobs · 0–100"
          spark={spark("averageRiskScore")}
        />
      </div>

      {/* Trend + donut */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card-glass lg:col-span-2 fade-up">
          <CardHeader
            title="Flagged Transactions — Recent Jobs"
            sub="Flagged transactions (bars) and how many were Critical (line) in the latest analyses"
          />
          {trendData.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart
                data={trendData}
                margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="gBar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.95} />
                    <stop offset="100%" stopColor="#b45309" stopOpacity={0.5} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={AXIS}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                />
                <YAxis
                  tick={AXIS}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(148,163,184,0.06)" }}
                  content={
                    <ChartTooltip
                      labelFormat={(_, p) => p?.[0]?.payload?.file}
                      valueFormat={(v) => nf(v)}
                    />
                  }
                />
                <Bar
                  dataKey="flagged"
                  name="Flagged"
                  fill="url(#gBar)"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={44}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="critical"
                  name="Critical"
                  type="monotone"
                  stroke="#ef4444"
                  strokeWidth={2.5}
                  isAnimationActive={false}
                  dot={{
                    r: 4,
                    fill: "#0f172a",
                    stroke: "#ef4444",
                    strokeWidth: 2,
                  }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <Empty>Upload a dataset to see detections over time</Empty>
          )}
        </div>

        <div className="card-glass fade-up">
          <CardHeader
            title="Risk Distribution"
            sub="Transactions needing attention, by level"
          />
          {allTx > 0 ? (
            <>
              <div className="relative">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={
                        donutData.length
                          ? donutData
                          : [{ name: "None", value: 1, color: "#1e293b" }]
                      }
                      dataKey="value"
                      innerRadius={58}
                      outerRadius={82}
                      paddingAngle={donutData.length > 1 ? 3 : 0}
                      stroke="none"
                      cornerRadius={4}
                      isAnimationActive={false}
                    >
                      {(donutData.length
                        ? donutData
                        : [{ color: "#1e293b" }]
                      ).map((d, i) => (
                        <Cell key={i} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={<ChartTooltip valueFormat={(v) => nf(v)} />}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-2xl font-bold text-white tabular-nums">
                    {nf(attention)}
                  </span>
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">
                    need attention
                  </span>
                </div>
              </div>
              <div className="space-y-1.5 mt-2">
                {["Critical", "High", "Medium", "Low"].map((k) => (
                  <div
                    key={k}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="flex items-center gap-2 text-slate-300">
                      <i
                        className="w-2 h-2 rounded-full"
                        style={{ background: LEVEL_COLORS[k] }}
                      />
                      {k}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      <b className="text-white font-semibold">
                        {nf(byLevel[k])}
                      </b>
                      <span className="ml-2 text-slate-600">
                        {allTx ? ((byLevel[k] / allTx) * 100).toFixed(2) : 0}%
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Empty>No data yet</Empty>
          )}
        </div>
      </div>

      {/* Typologies + histogram */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-glass fade-up">
          <CardHeader
            title="What kind of fraud?"
            sub="Flagged transactions by detected typology"
            right={<Layers className="w-4 h-4 text-slate-600" />}
          />
          {categories.length ? (
            <div className="space-y-3">
              {categories.map((c, i) => (
                <div key={c.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-300">{c.name}</span>
                    <span className="text-white font-semibold tabular-nums">
                      {nf(c.count)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full grow-right"
                      style={{
                        width: `${(c.count / maxCat) * 100}%`,
                        animationDelay: `${i * 60}ms`,
                        background: "linear-gradient(90deg,#7c3aed,#ec4899)",
                      }}
                    />
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-slate-600 pt-1">
                Typology is a rule-of-thumb label derived from risk, payment
                type and amounts — not a separate model.
              </p>
            </div>
          ) : (
            <Empty>No flagged transactions to categorise yet</Empty>
          )}
        </div>

        <div className="card-glass fade-up">
          <CardHeader
            title="Risk-score distribution"
            sub={
              threshold != null
                ? `How scores are spread — alerts start at ${(threshold * 100).toFixed(0)}`
                : "How risk scores are spread across all your transactions"
            }
            right={<TrendingUp className="w-4 h-4 text-slate-600" />}
          />
          {hist.length ? (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart
                  data={hist}
                  margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
                >
                  <CartesianGrid stroke="#1e293b" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ ...AXIS, fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                  />
                  <YAxis
                    tick={AXIS}
                    axisLine={false}
                    tickLine={false}
                    scale="sqrt"
                    domain={[0, "auto"]}
                    allowDecimals={false}
                    tickFormatter={(v) =>
                      v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v
                    }
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(148,163,184,0.06)" }}
                    content={
                      <ChartTooltip
                        labelFormat={(l) => `Risk score ${l}`}
                        valueFormat={(v) => `${nf(v)} transactions`}
                      />
                    }
                  />
                  <Bar
                    dataKey="count"
                    name="Transactions"
                    radius={[5, 5, 0, 0]}
                    isAnimationActive={false}
                  >
                    {hist.map((h, i) => (
                      <Cell
                        key={i}
                        fill={histColor(h.bucket)}
                        fillOpacity={0.88}
                      />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
              {threshold != null && (
                <div className="flex items-center gap-4 mt-2 text-[10px] text-slate-500">
                  <span className="flex items-center gap-1.5">
                    <i className="w-2 h-2 rounded-sm bg-sky-400" />
                    below alert threshold
                  </span>
                  <span className="flex items-center gap-1.5">
                    <i className="w-2 h-2 rounded-sm bg-amber-500" />
                    contains the threshold
                  </span>
                  <span className="flex items-center gap-1.5">
                    <i className="w-2 h-2 rounded-sm bg-red-500" />
                    alerting
                  </span>
                </div>
              )}
              <p className="text-[10px] text-slate-600 mt-1">
                Square-root scale, so the few high-risk buckets stay visible
                next to the huge low-risk one.
              </p>
            </>
          ) : (
            <Empty>No score data yet</Empty>
          )}
        </div>
      </div>

      {/* Alerts + jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-glass fade-up">
          <CardHeader
            title="Recent High-Risk Alerts"
            sub="Click to trace the account network"
            right={
              <span className="chip border-red-500/30 text-red-400 bg-red-500/10">
                {alerts.filter((a) => a.riskLevel === "Critical").length}{" "}
                critical
              </span>
            }
          />
          <div className="space-y-2">
            {alerts.length === 0 ? (
              <Empty h="h-32">No alerts yet — upload a dataset.</Empty>
            ) : (
              alerts.slice(0, 6).map((a, i) => {
                const c = LEVEL_COLORS[a.riskLevel] || "#64748b";
                return (
                  <div
                    key={`${a.jobId}-${a.transactionId}-${i}`}
                    onClick={() =>
                      navigate(
                        `/graph/${a.transactionId}${a.jobId ? `?jobId=${a.jobId}` : ""}`,
                      )
                    }
                    className="group flex items-center gap-3 p-3 rounded-xl bg-slate-800/40 hover:bg-slate-700/50 border border-transparent hover:border-slate-600 cursor-pointer transition-all"
                  >
                    <div className="relative w-10 h-10 flex-shrink-0">
                      <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
                        <circle
                          cx="18"
                          cy="18"
                          r="15"
                          fill="none"
                          stroke="#1e293b"
                          strokeWidth="4"
                        />
                        <circle
                          cx="18"
                          cy="18"
                          r="15"
                          fill="none"
                          stroke={c}
                          strokeWidth="4"
                          strokeLinecap="round"
                          strokeDasharray={`${(Math.min(a.riskScore || 0, 100) / 100) * 94.2} 94.2`}
                        />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white">
                        {(a.riskScore || 0).toFixed(0)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-slate-200 truncate">
                        {a.transactionId}
                      </p>
                      <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                        {a.fraudCategory}
                      </p>
                    </div>
                    <RiskChip level={a.riskLevel} />
                    <ChevronRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-300 transition-colors" />
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="card-glass fade-up">
          <CardHeader
            title="Recent Analysis Jobs"
            sub="Every analysis done so far — click a completed one to explore it"
            right={
              <button
                onClick={() => navigate("/upload")}
                className="text-xs text-sky-400 hover:text-sky-300"
              >
                View all
              </button>
            }
          />
          <div className="space-y-2">
            {jobs.length === 0 ? (
              <Empty h="h-32">No jobs yet.</Empty>
            ) : (
              jobs.slice(0, 6).map((job) => {
                const done = job.status === "completed",
                  failed = job.status === "failed";
                const rate = job.totalTransactions
                  ? (job.flaggedCount / job.totalTransactions) * 100
                  : 0;
                const tone = done ? "#22c55e" : failed ? "#ef4444" : "#f59e0b";
                return (
                  <div
                    key={job.jobId}
                    onClick={() => done && navigate(`/analysis/${job.jobId}`)}
                    className={`flex items-center gap-3 p-3 rounded-xl bg-slate-800/40 border border-transparent transition-all ${done ? "hover:bg-slate-700/50 hover:border-slate-600 cursor-pointer" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-200 truncate">
                        {job.originalName}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(new Date(job.createdAt), {
                          addSuffix: true,
                        })}
                        {done && (
                          <span className="text-slate-600">
                            · {nf(job.totalTransactions)} tx
                          </span>
                        )}
                        {(done || failed) &&
                          getJobTiming(job).tookMs !== null && (
                            <span
                              className={
                                failed ? "text-red-300" : "text-emerald-300"
                              }
                              title={breakdownText(job) || undefined}
                            >
                              · {failed ? "failed after" : "took"}{" "}
                              {formatDuration(getJobTiming(job).tookMs)}
                            </span>
                          )}
                      </p>
                      {!done && !failed && (
                        <div className="h-1 rounded-full bg-slate-700 mt-2 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-400 transition-all"
                            style={{ width: `${job.progress || 5}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <span
                        className="chip capitalize"
                        style={{
                          color: tone,
                          borderColor: `${tone}55`,
                          background: `${tone}1a`,
                        }}
                      >
                        {job.status}
                      </span>
                      {done && (
                        <p className="text-[11px] text-slate-400 mt-1 tabular-nums">
                          {nf(job.flaggedCount)} flagged{" "}
                          <span className="text-slate-600">
                            ({rate.toFixed(2)}%)
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── demo data (shown only when the backend is unreachable) ───────────────────────── */
const MOCK_OVERVIEW = {
  totals: { totalTransactions: 125430, totalFlagged: 3842, totalCritical: 289 },
  recentAlerts: [
    {
      transactionId: "TX-00142",
      riskScore: 96.4,
      riskLevel: "Critical",
      fraudCategory: "High-Risk AML Typology",
    },
    {
      transactionId: "TX-00891",
      riskScore: 88.2,
      riskLevel: "Critical",
      fraudCategory: "Circular Transaction",
    },
    {
      transactionId: "TX-02341",
      riskScore: 82.1,
      riskLevel: "High",
      fraudCategory: "Suspicious Layering",
    },
    {
      transactionId: "TX-05621",
      riskScore: 76.3,
      riskLevel: "High",
      fraudCategory: "Unusual Transfer Volume",
    },
    {
      transactionId: "TX-09210",
      riskScore: 71.8,
      riskLevel: "High",
      fraudCategory: "Cryptocurrency Laundering",
    },
  ],
  riskBreakdown: [
    { _id: "Critical", count: 289 },
    { _id: "High", count: 1204 },
    { _id: "Medium", count: 2349 },
    { _id: "Low", count: 121588 },
  ],
  categoryBreakdown: [
    { _id: "High-Risk AML Typology", count: 1210 },
    { _id: "Suspicious Layering", count: 940 },
    { _id: "Circular Transaction", count: 780 },
    { _id: "Unusual Transfer Volume", count: 610 },
    { _id: "Cryptocurrency Laundering", count: 302 },
  ],
  scoreDistribution: [
    { _id: 0, count: 98200 },
    { _id: 10, count: 15400 },
    { _id: 20, count: 5200 },
    { _id: 30, count: 2600 },
    { _id: 40, count: 1500 },
    { _id: 50, count: 980 },
    { _id: 60, count: 640 },
    { _id: 70, count: 520 },
    { _id: 80, count: 260 },
    { _id: 90, count: 130 },
  ],
};
const MOCK_JOBS = [
  {
    jobId: "demo-1",
    originalName: "HI_Small_Trans.csv",
    status: "completed",
    flaggedCount: 1842,
    criticalCount: 120,
    totalTransactions: 52000,
    averageRiskScore: 18.4,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    jobId: "demo-2",
    originalName: "LI_Small_Trans.csv",
    status: "completed",
    flaggedCount: 2000,
    criticalCount: 169,
    totalTransactions: 73430,
    averageRiskScore: 21.1,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
];
