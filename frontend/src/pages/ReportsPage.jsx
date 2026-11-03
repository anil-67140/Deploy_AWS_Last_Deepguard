// ReportsPage.jsx
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSelector } from "react-redux";
import { uploadAPI, reportAPI } from "../utils/api";
import { Download, FileText, Loader2, CheckCircle, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import toast from "react-hot-toast";

export default function ReportsPage() {
  const navigate = useNavigate();
  const role = useSelector((s) => s.auth.role);
  const canGenerate = ["admin", "auditor"].includes(role); // FR-17: analysts are view-only
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState({});

  useEffect(() => {
    uploadAPI
      .getJobs()
      .then((r) => setJobs(r.data || []))
      .catch((err) => setJobs(err?.response ? [] : MOCK_JOBS))
      .finally(() => setLoading(false));
  }, []);

  const downloadReport = async (jobId) => {
    setGenerating((g) => ({ ...g, [jobId]: true }));
    try {
      const res = await reportAPI.generateReport(jobId);
      const blob = new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DeepGuard_Report_${jobId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("PDF report downloaded!");
    } catch (err) {
      toast.error("Could not generate report: " + err.message);
    } finally {
      setGenerating((g) => ({ ...g, [jobId]: false }));
    }
  };

  const completedJobs = jobs.filter((j) => j.status === "completed");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Forensic Reports</h1>
        <p className="text-slate-400 text-sm mt-1">
          Generate tamper-proof PDF forensic reports for completed analysis jobs
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-sky-400 animate-spin" />
        </div>
      ) : completedJobs.length === 0 ? (
        <div className="card text-center py-16">
          <FileText className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400">No completed jobs yet.</p>
          <button
            onClick={() => navigate("/upload")}
            className="btn-primary mt-4 text-sm"
          >
            Upload Dataset
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {completedJobs.map((job) => (
            <div
              key={job.jobId}
              className="card hover:border-slate-600 transition-colors"
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-sky-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-200 text-sm truncate">
                    {job.originalName}
                  </p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Clock className="w-3 h-3 text-slate-500" />
                    <p className="text-xs text-slate-500">
                      {formatDistanceToNow(new Date(job.createdAt), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </div>
                <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-1" />
              </div>

              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="text-center bg-slate-700/40 rounded-lg p-2">
                  <p className="text-sm font-bold text-white">
                    {(job.totalTransactions || 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-400">Total</p>
                </div>
                <div className="text-center bg-red-500/10 border border-red-500/20 rounded-lg p-2">
                  <p className="text-sm font-bold text-red-400">
                    {(job.flaggedCount || 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-400">Flagged</p>
                </div>
                <div className="text-center bg-amber-500/10 border border-amber-500/20 rounded-lg p-2">
                  <p className="text-sm font-bold text-amber-400">
                    {(job.criticalCount || 0).toLocaleString()}
                  </p>
                  <p className="text-xs text-slate-400">Critical</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => navigate(`/analysis/${job.jobId}`)}
                  className="btn-secondary flex-1 text-xs"
                >
                  View Analysis
                </button>
                {canGenerate && (
                  <button
                    onClick={() => downloadReport(job.jobId)}
                    disabled={generating[job.jobId]}
                    className="btn-primary flex-1 text-xs flex items-center justify-center gap-1.5"
                  >
                    {generating[job.jobId] ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Download className="w-3 h-3" />
                    )}
                    PDF Report
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MOCK_JOBS = [
  {
    jobId: "demo-1",
    originalName: "HI_Small_Trans.csv",
    status: "completed",
    totalTransactions: 52000,
    flaggedCount: 1842,
    criticalCount: 289,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    jobId: "demo-2",
    originalName: "LI_Small_Trans.csv",
    status: "completed",
    totalTransactions: 73430,
    flaggedCount: 2000,
    criticalCount: 412,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
];
