import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { useDropzone } from "react-dropzone";
import { io } from "socket.io-client";
import { uploadAPI, adminAPI, supabase } from "../utils/api";
import { addJob, updateJob } from "../store";
import toast from "react-hot-toast";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Clock,
  TrendingUp,
  Activity,
  ChevronDown,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import JobTime, { TimeBreakdown, useNow } from "../components/JobTime";
import { formatDuration, getJobTiming, isActive } from "../utils/duration";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:4000";

function StatusBadge({ status }) {
  const map = {
    queued: "text-slate-400 bg-slate-500/10",
    parsing: "text-sky-400 bg-sky-500/10",
    analyzing: "text-amber-400 bg-amber-500/10",
    saving: "text-purple-400 bg-purple-500/10",
    completed: "text-green-400 bg-green-500/10",
    failed: "text-red-400 bg-red-500/10",
  };
  return (
    <span
      className={`text-xs font-semibold px-2.5 py-0.5 rounded-full capitalize ${map[status] || ""}`}
    >
      {status}
    </span>
  );
}

function ProgressBar({ value, status }) {
  const color =
    status === "failed"
      ? "bg-red-500"
      : status === "completed"
        ? "bg-green-500"
        : "bg-sky-500";
  return (
    <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} transition-all duration-500 ease-out`}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

export default function UploadPage() {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const jobs = useSelector((s) => s.jobs.list);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [localJobs, setLocalJobs] = useState([]);
  const [socket, setSocket] = useState(null);
  const [useGnn, setUseGnn] = useState(false);
  const [gnnAvailable, setGnnAvailable] = useState(null); // null = still checking
  const [gnnReason, setGnnReason] = useState(null); // 'engine_offline' | 'not_installed' | null

  useEffect(() => {
    // Uses the upload-scoped endpoint so auditors (not just admins) get the real answer.
    uploadAPI
      .getGnnStatus()
      .then((r) => {
        setGnnAvailable(!!r.data.available);
        setGnnReason(r.data.reason || null);
      })
      .catch(() => {
        setGnnAvailable(false);
        setGnnReason("engine_offline");
      });
  }, []);

  // Live updates for EVERY running job — including ones started earlier or in another tab. Before, the page only
  // listened for the job uploaded during this visit, so after navigating away and back a running card froze and
  // you never saw it finish. Now: one set of listeners for all jobs, and every active job's room is (re)joined after
  // a page load and after any reconnect (a backend restart forgets the rooms).
  const socketRef = useRef(null);
  const jobsRef = useRef([]);
  const joinedRef = useRef(new Set());
  useEffect(() => {
    jobsRef.current = localJobs;
  }, [localJobs]);

  const joinJob = (s, jobId) => {
    if (!s || joinedRef.current.has(jobId)) return;
    joinedRef.current.add(jobId);
    s.emit("join_job", jobId);
  };

  useEffect(() => {
    // The backend only accepts authenticated sockets; the token is re-read on every (re)connect.
    const s = io(SOCKET_URL, {
      auth: async (cb) => {
        const { data } = await supabase.auth.getSession();
        cb({ token: data.session?.access_token });
      },
    });
    socketRef.current = s;
    setSocket(s);
    const patch = (jobId, fn) =>
      setLocalJobs((prev) => prev.map((j) => (j.jobId === jobId ? fn(j) : j)));

    // A crash/restart drops the connection and socket.io reconnects by itself; but if the SERVER ends the session
    // ('io server disconnect') the client never retries unless asked to.
    s.on("disconnect", (reason) => {
      if (reason === "io server disconnect") s.connect();
    });
    s.on("connect", () => {
      joinedRef.current.clear();
      jobsRef.current.filter(isActive).forEach((j) => joinJob(s, j.jobId));
    });
    s.on("progress", (data) => patch(data.jobId, (j) => ({ ...j, ...data })));
    s.on("completed", (data) => {
      patch(data.jobId, (j) => ({
        ...j,
        status: "completed",
        progress: 100,
        ...data.summary,
      }));
      const took = data.summary?.processingTimeMs;
      toast.success(
        `Analysis complete${took ? ` in ${formatDuration(took)}` : ""} — ${(data.summary?.flagged || 0).toLocaleString()} transactions flagged.`,
      );
    });
    s.on("error", (data) => {
      patch(data.jobId, (j) => ({
        ...j,
        status: "failed",
        errorMessage: data.error || j.errorMessage,
        processingTimeMs: data.processingTimeMs ?? j.processingTimeMs,
      }));
      toast.error(
        `Job failed${data.processingTimeMs ? ` after ${formatDuration(data.processingTimeMs)}` : ""}: ${data.error}`,
      );
    });

    loadJobs();
    return () => s.disconnect();
  }, []);

  const loadJobs = async () => {
    try {
      const res = await uploadAPI.getJobs();
      const list = res.data || [];
      setLocalJobs(list);
      list.filter(isActive).forEach((j) => joinJob(socketRef.current, j.jobId));
    } catch {
      setLocalJobs([]);
    }
  };

  const subscribeToJob = (jobId, s) => joinJob(s || socketRef.current, jobId);

  // one clock for the whole list, ticking only while something is running
  const now = useNow(localJobs.some(isActive));
  const [openTimes, setOpenTimes] = useState({}); // jobId -> "where did the time go" panel open?

  const onDrop = useCallback(
    async (acceptedFiles) => {
      const file = acceptedFiles[0];
      if (!file) return;

      const maxSize = 100 * 1024 * 1024;
      if (file.size > maxSize) return toast.error("File too large. Max 100MB.");

      const ext = file.name.split(".").pop().toLowerCase();
      if (!["csv", "xlsx", "xls"].includes(ext))
        return toast.error("Only CSV, XLSX, XLS files allowed");

      setUploading(true);
      setUploadProgress(0);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("useGnn", String(useGnn && gnnAvailable));

      try {
        const res = await uploadAPI.uploadFile(formData, setUploadProgress);
        const { jobId, position, queue } = res.data;

        const newJob = {
          jobId,
          originalName: file.name,
          fileSize: file.size,
          status: "queued",
          progress: 5,
          createdAt: new Date().toISOString(),
        };
        setLocalJobs((prev) => [newJob, ...prev]);
        subscribeToJob(jobId, socket);
        toast.success(
          position > 1
            ? `File uploaded! ${position - 1} job${position - 1 === 1 ? "" : "s"} ahead in the ${queue === "redis" ? "Redis" : ""} queue…`
            : "File uploaded! Processing started…",
        );
      } catch (err) {
        toast.error(err.message || "Upload failed");
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    },
    [socket, useGnn, gnnAvailable],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "text/csv": [".csv"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
        ".xlsx",
      ],
      "application/vnd.ms-excel": [".xls"],
    },
    multiple: false,
    disabled: uploading,
  });

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">
          Upload Transaction Dataset
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Upload IBM AML format CSV or Excel files for batch AI analysis
        </p>
      </div>

      {/* Drop Zone */}
      <div
        {...getRootProps()}
        className={`relative border-2 border-dashed rounded-2xl p-10 text-center transition-all cursor-pointer
          ${isDragActive ? "border-sky-400 bg-sky-500/10" : "border-slate-600 hover:border-slate-500 bg-slate-800/40"}
          ${uploading ? "pointer-events-none opacity-60" : ""}`}
      >
        <input {...getInputProps()} />

        {uploading ? (
          <div className="space-y-4">
            <Loader2 className="w-12 h-12 text-sky-400 animate-spin mx-auto" />
            <p className="text-white font-semibold">Uploading file…</p>
            <div className="max-w-xs mx-auto">
              <ProgressBar value={uploadProgress} status="analyzing" />
              <p className="text-xs text-slate-400 mt-1">{uploadProgress}%</p>
            </div>
          </div>
        ) : isDragActive ? (
          <div className="space-y-3">
            <Upload className="w-12 h-12 text-sky-400 mx-auto animate-bounce" />
            <p className="text-sky-400 font-semibold">Drop it here!</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="w-16 h-16 rounded-2xl bg-slate-700 border border-slate-600 flex items-center justify-center mx-auto">
              <FileSpreadsheet className="w-8 h-8 text-slate-400" />
            </div>
            <div>
              <p className="text-white font-semibold">
                Drag & drop your transaction file
              </p>
              <p className="text-slate-400 text-sm mt-1">or click to browse</p>
            </div>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              {["CSV", "XLSX", "XLS"].map((t) => (
                <span
                  key={t}
                  className="text-xs bg-slate-700 border border-slate-600 text-slate-300 px-2.5 py-1 rounded-full"
                >
                  {t}
                </span>
              ))}
              <span className="text-xs text-slate-500">· Max 100MB</span>
            </div>
          </div>
        )}
      </div>

      {/* GNN option */}
      <div
        className={`flex items-center gap-3 mt-4 p-3 rounded-xl border
        ${gnnAvailable ? "border-purple-800/40 bg-purple-950/20" : "border-slate-700 bg-slate-800/30"}`}
      >
        <input
          type="checkbox"
          id="useGnn"
          checked={useGnn && gnnAvailable}
          disabled={!gnnAvailable || uploading}
          onChange={(e) => setUseGnn(e.target.checked)}
          className="w-4 h-4 rounded accent-purple-500 disabled:opacity-40"
        />
        <label
          htmlFor="useGnn"
          className={`text-sm flex-1 ${gnnAvailable ? "text-slate-200" : "text-slate-500"} ${gnnAvailable && !uploading ? "cursor-pointer" : ""}`}
        >
          Also score with the Graph Neural Network
          <span className="block text-xs text-slate-500 mt-0.5">
            {gnnAvailable === null
              ? "Checking availability…"
              : gnnAvailable
                ? "Builds a transaction graph from this file and adds a GNN fraud probability per transaction (optional extra, batch network analysis), alongside the Autoencoder / XGBoost / Isolation Forest scores."
                : gnnReason === "engine_offline"
                  ? "The AI Engine is offline or unreachable — start it (cd ai-engine, uvicorn main:app --port 8000) and refresh this page."
                  : "Not installed on the AI Engine — see Admin → AI Models → GNN, or SETUP_GUIDE.md, to enable it."}
          </span>
        </label>
      </div>

      {/* IBM AML Format Hint */}
      <div className="card bg-sky-950/30 border-sky-800/40">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-sky-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-xs font-semibold text-sky-300 mb-1">
              IBM AML Dataset Format
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">
              Expected columns:{" "}
              <span className="text-slate-200 font-mono">
                Timestamp, From Bank, Account, To Bank, Account.1, Amount
                Received, Receiving Currency, Amount Paid, Payment Currency,
                Payment Format, Is Laundering
              </span>
            </p>
            <p className="text-xs text-slate-500 mt-1.5">
              Download from Kaggle:{" "}
              <span className="text-sky-400">
                ealtman2019/ibm-transactions-for-anti-money-laundering-aml
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* Jobs List */}
      {localJobs.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-4">
            Analysis Jobs
          </h3>
          <div className="space-y-3">
            {localJobs.map((job) => (
              <div
                key={job.jobId}
                className="bg-slate-700/30 rounded-xl p-4 border border-slate-700/60"
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-200 truncate">
                      {job.originalName}
                    </p>
                    <div className="flex items-center gap-x-3 gap-y-1 mt-1 flex-wrap">
                      <StatusBadge status={job.status} />
                      <JobTime job={job} now={now} />
                      <span className="text-xs text-slate-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDistanceToNow(new Date(job.createdAt), {
                          addSuffix: true,
                        })}
                      </span>
                    </div>
                  </div>

                  {job.status === "completed" && (
                    <button
                      onClick={() => navigate(`/analysis/${job.jobId}`)}
                      className="btn-primary text-xs py-1.5 flex-shrink-0"
                    >
                      View Results
                    </button>
                  )}
                </div>

                <ProgressBar value={job.progress || 0} status={job.status} />

                {job.status === "completed" && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                    <div className="text-center">
                      <p className="text-lg font-bold text-white">
                        {(job.totalTransactions || 0).toLocaleString()}
                      </p>
                      <p className="text-xs text-slate-400">Total</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-red-400">
                        {(job.flaggedCount || 0).toLocaleString()}
                      </p>
                      <p className="text-xs text-slate-400">Flagged</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-amber-400">
                        {(job.criticalCount || 0).toLocaleString()}
                      </p>
                      <p className="text-xs text-slate-400">Critical</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-emerald-300">
                        {formatDuration(getJobTiming(job).tookMs)}
                      </p>
                      <p className="text-xs text-slate-400">Time taken</p>
                    </div>
                  </div>
                )}

                {job.status === "completed" && getJobTiming(job).parts && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() =>
                        setOpenTimes((o) => ({
                          ...o,
                          [job.jobId]: !o[job.jobId],
                        }))
                      }
                      aria-expanded={!!openTimes[job.jobId]}
                      className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1"
                    >
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${openTimes[job.jobId] ? "rotate-180" : ""}`}
                      />
                      Where did the time go?
                    </button>
                    {openTimes[job.jobId] && (
                      <div className="mt-2 fade-up">
                        <TimeBreakdown job={job} />
                      </div>
                    )}
                  </div>
                )}

                {job.status === "failed" && (
                  <p className="text-xs text-red-400 mt-2 flex items-center gap-1">
                    <XCircle className="w-3 h-3" />
                    {job.errorMessage || "Processing failed"}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
