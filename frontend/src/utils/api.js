import axios from "axios";
import { createClient } from "@supabase/supabase-js";

// ── Supabase Client ──
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL || "https://placeholder.supabase.co",
  import.meta.env.VITE_SUPABASE_ANON_KEY || "placeholder",
);

// ── Axios API Client ──
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:4000/api",
  timeout: 300000,
});

// Auto-attach Supabase JWT
api.interceptors.request.use(async (config) => {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err.response?.data?.error || err.message || "Network error";
    return Promise.reject(new Error(msg));
  },
);

// Fetch the user's real role (stored in the Supabase `profiles` table, read by the backend).
// Takes the access token explicitly and uses plain axios on purpose: it is called from inside
// supabase.auth.onAuthStateChange, where calling supabase.auth.getSession() (what the `api`
// interceptor does) can deadlock. Returns null if the backend can't be reached.
export async function fetchRole(accessToken) {
  try {
    const { data } = await axios.get(
      `${import.meta.env.VITE_API_URL || "http://localhost:4000/api"}/auth/me`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 },
    );
    return data.role || null;
  } catch {
    return null;
  }
}

// ── API Methods ──
export const authAPI = {
  me: () => api.get("/auth/me"),
  login: (email, password) => api.post("/auth/login", { email, password }),
  register: (email, password, role) =>
    api.post("/auth/register", { email, password, role }),
  logout: () => api.post("/auth/logout"),
};

export const uploadAPI = {
  uploadFile: (formData, onProgress) =>
    api.post("/upload", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: (e) =>
        onProgress?.(Math.round((e.loaded / e.total) * 100)),
    }),
  getJobs: () => api.get("/upload/jobs"),
  getJobStatus: (jobId) => api.get(`/upload/jobs/${jobId}`),
  // Is the GNN option usable? Open to every logged-in user (the admin-only /admin/gnn/status gave auditors a 403).
  getGnnStatus: () => api.get("/upload/gnn-status"),
};

export const analysisAPI = {
  getJobTransactions: (jobId, params) =>
    api.get(`/analysis/job/${jobId}`, { params }),
  getTransaction: (txId) => api.get(`/analysis/transaction/${txId}`),
  exportJob: (jobId, format = "csv", filter) =>
    api.get(`/analysis/job/${jobId}/export`, {
      params: { format, filter },
      responseType: "blob",
    }),
};

export const graphAPI = {
  getTransactionGraph: (txId, depth = 3, jobId, direction = "both") =>
    api.get(`/graph/transaction/${txId}`, {
      params: { depth, jobId, direction },
    }),
  getJobNetworks: (jobId) => api.get(`/graph/job/${jobId}/networks`),
};

export const reportAPI = {
  generateReport: (jobId) =>
    api.get(`/reports/generate/${jobId}`, { responseType: "blob" }),
  // FR-11: verify a report's evidence hash hasn't drifted since generation
  verifyReport: (jobId) => api.get(`/reports/verify/${jobId}`),
};

export const dashboardAPI = {
  getOverview: () => api.get("/dashboard/overview"),
  // FR-12: model accuracy + system/processing-time analytics
  getPerformance: () => api.get("/dashboard/performance"),
};

export const adminAPI = {
  getAllJobs: () => api.get("/admin/jobs"),
  getStats: () => api.get("/admin/stats"),
  // FR-13: Manage Users
  getUsers: () => api.get("/admin/users"),
  createUser: (payload) => api.post("/admin/users", payload),
  updateUserRole: (userId, role) =>
    api.patch(`/admin/users/${userId}/role`, { role }),
  deleteUser: (userId) => api.delete(`/admin/users/${userId}`),
  // FR-14: Manage AI Models
  getModelConfig: () => api.get("/admin/model-config"),
  updateModelConfig: (payload) => api.patch("/admin/model-config", payload),
  // FR-15: System Logs
  getLogs: (params) => api.get("/admin/logs", { params }),
  // FR-18: Bulk Processing Queue
  getQueueStatus: () => api.get("/admin/queue/status"),
  // FR-20: Data Backup & Recovery
  getBackups: () => api.get("/admin/backups"),
  runBackup: () => api.post("/admin/backups/run"),
  restoreBackup: (name) =>
    api.post(`/admin/backups/${encodeURIComponent(name)}/restore`),
  deleteBackup: (name) =>
    api.delete(`/admin/backups/${encodeURIComponent(name)}`),
  downloadBackup: (name) =>
    api.get(`/admin/backups/${encodeURIComponent(name)}/download`, {
      responseType: "blob",
    }),
  // GNN
  getGnnStatus: () => api.get("/admin/gnn/status"),
};

export default api;
