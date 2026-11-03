# 🛡️ DeepGuard — AI-Driven Financial Forensics Platform

> Final Year Project | Iqra University, Karachi — Computer Science, Batch 2023
> Supervisor: Dr. Dure e Jabeen

A full-stack Anti-Money-Laundering (AML) detection platform. Transactions are scored by a
**PyTorch Autoencoder → XGBoost** detector (with an **Isolation Forest** anomaly signal and **SHAP**
explanations), served by a Python AI microservice, orchestrated by a Node.js API gateway and shown in a
React dashboard with an interactive transaction-network graph. An optional **Graph Neural Network** module
is included as an advanced extra.

Trained on IBM's synthetic AML dataset (`HI-Small_Trans.csv`, 5,078,345 transactions, 0.10 % laundering) with a
**time-based train / validation / test split** and **past-only features** (no information from the future).

---

## 📁 Project Structure

```
Last_DeepGuard/
├── notebooks/                                  # Google Colab training notebooks (already run — results are committed)
│   ├── DeepGuard_Training_Final.ipynb          # Isolation Forest + Autoencoder + XGBoost + SHAP, full metrics, figures, tables
│   └── DeepGuard_GNN_Extra_Final.ipynb         # OPTIONAL extra: Graph Neural Network (+ XGBoost reference & blend)
│
├── ai-engine/                                  # Python FastAPI — AI microservice (port 8000)
│   ├── main.py                                 # API + model registry + scoring pipeline (v2)
│   ├── features.py                             # the 47 past-only features (verbatim copy of the notebook code)
│   ├── tests/test_engine.py                    # end-to-end check against the real saved models
│   ├── requirements.txt · start.sh · .env.example
│   └── saved_models/
│       ├── deepguard_training_results/         # ← output of DeepGuard_Training_Final.ipynb
│       │   ├── models/                         #   xgboost_final.json (+ _trainval), autoencoder.pt, ae_prep.pkl,
│       │   │                                   #   isolation_forest.pkl, feature_cols.pkl, metadata.json
│       │   ├── tables/                         #   T00…T12 CSVs: metrics of every model, classification reports,
│       │   │                                   #   bootstrap CIs, operating points, SHAP importance …
│       │   ├── figures/                        #   fig01…fig17 PNGs for the report (PR/ROC, confusion matrices, SHAP …)
│       │   └── RESULTS_SUMMARY.md · metadata.json
│       └── deepguard_gnn_results/              # ← output of DeepGuard_GNN_Extra_Final.ipynb (optional)
│           ├── models/                         #   gnn_best.pt, gnn_config.json, gnn_model_def.py, gnn_edge_scaler.pkl,
│           │                                   #   gnn_account_risk.csv, cytoscape_top_alerts.json …
│           ├── tables/ · figures/ · summary.json
│
├── backend-node/                               # Node.js + Express — API gateway (port 4000)
│   └── src/ (config, controllers, middleware, models, queue, routes, services, server.js) · scripts/ · backups/
│
├── frontend/                                   # React + Vite + Tailwind (port 5173)
│   └── src/ (components, pages, store, utils)
│
├── start-all.sh · SETUP_GUIDE.md · README.md · logs/
```

---

## 🧠 How detection works

```
uploaded CSV/XLSX ──► Node gateway (sorts by time, sends 20 000-row chunks with one job id)
                              │
                              ▼
                   AI Engine (FastAPI)
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │ 1. 47 past-only behavioural features  (sender/receiver history, 1 h / 24 h   │
   │    activity windows, pass-through patterns …)   → features.py               │
   │ 2. Autoencoder (PyTorch, trained on NORMAL rows only) → reconstruction error │
   │    + 8-d code  = 9 extra features                                           │
   │ 3. XGBoost (56 features) → fraud probability  ◄── THE decision model         │
   │    flagged when probability ≥ 0.481 (best-F1 threshold, tuned on validation)│
   │ 4. SHAP (exact TreeSHAP) → which features pushed this transaction up/down    │
   │ Also reported per transaction: Isolation Forest + Autoencoder anomaly scores │
   │ Optional: GNN score from the account graph of the uploaded file              │
   └─────────────────────────────────────────────────────────────────────────────┘
```

**Account history across chunks.** The features need each account's *earlier* transactions. The gateway sends a job in
time-ordered chunks with the same `job_id`; the engine keeps a rolling per-job history (last 200 000 rows, `CONTEXT_ROWS`)
and computes every chunk on *history + chunk*. `tests/test_engine.py` proves that chunked scoring gives **exactly** the same
scores as scoring the whole file at once (max difference 0.0).

---

## 📊 Model Results (real, from the committed training outputs)

Held-out **test period** (the last 20 % of time): 1,015,669 transactions, 1,797 laundering (0.177 %).
Thresholds and the final model were chosen on the validation period only; the test set was used once.

| Model                    | Precision | Recall | F1         | Avg. Precision | ROC-AUC | MCC    |
| ------------------------ | --------- | ------ | ---------- | -------------- | ------- | ------ |
| Isolation Forest (alone) | 0.003     | 0.750  | 0.006      | 0.003          | 0.673   | 0.026  |
| Autoencoder (alone)      | 0.026     | 0.209  | 0.047      | 0.016          | 0.881   | 0.070  |
| Isolation Forest + AE (unsupervised) | 0.005 | 0.663 | 0.011   | 0.004          | 0.792   | 0.045  |
| XGBoost (base, 47 features) | 0.895  | 0.622  | 0.734      | 0.741          | 0.992   | 0.746  |
| **XGBoost + Autoencoder (FINAL)** | **0.865** | **0.641** | **0.736** | **0.744** | **0.992** | **0.744** |
| XGBoost + Isolation Forest | 0.869   | 0.637  | 0.735      | 0.743          | 0.992   | 0.744  |
| XGBoost + AE + IF        | 0.844     | 0.650  | 0.734      | 0.742          | 0.992   | 0.740  |

**Final model — XGBoost + Autoencoder** (56 features, threshold 0.4811): accuracy 99.92 %, balanced accuracy 0.820,
specificity 0.9998, F2 0.676, Cohen's κ 0.736, Brier 0.0007. Confusion matrix: **TP 1,152 · FP 180 · FN 645 · TN 1,013,692**
(1,332 alerts in ~1 M transactions). Bootstrap 95 % CI: AP [0.729, 0.769], F1 [0.717, 0.755].
Refit on train + validation (reported separately, same threshold): precision 0.897, recall 0.658, F1 0.759, AP 0.757.

Operating points of the final model (thresholds from validation): best-F1 0.481 → P 0.865 / R 0.641 · precision ≥ 0.90 →
P 0.894 / R 0.631 · recall ≥ 0.80 → P 0.177 / R 0.869 (8,800 alerts) · recall ≥ 0.90 → P 0.043 / R 0.929 (39,289 alerts).

**How to read this (say this in your viva):**

- Only 1 in ~560 test transactions is laundering, so **accuracy is meaningless** (a model that flags nothing gets 99.8 %).
  Judge **average precision, ROC-AUC, precision, recall, F1, MCC**. An F1 of 0.74 at this imbalance, with about 86 % of alerts
  being real laundering, is a strong result; an F1 above 0.88 is not reachable on this dataset without leaking future data.
- **XGBoost does the heavy lifting.** The unsupervised models (Isolation Forest, Autoencoder) are weak on their own — they
  never see labels. Adding the Autoencoder features to XGBoost gives AP +0.003 and Isolation Forest +0.002; both differences
  are **inside the bootstrap confidence intervals**, i.e. not statistically significant. They are kept because the project
  proposal specifies them, they provide an unsupervised "unusual behaviour" signal for the UI, and they cost nothing.
- The Autoencoder's reconstruction error of *normal* rows is higher on later data (training log: train ≈ 0.084 vs validation ≈ 0.105):
  normal behaviour drifts over time (concept drift). See `figures/fig02_autoencoder_error_drift.png` and `figures/fig01_autoencoder_training_loss.png`.

All figures (`fig01…fig17`) and tables (`T00…T12`) are in `ai-engine/saved_models/deepguard_training_results/`.

---

## 🕸️ Optional extra — Graph Neural Network

`notebooks/DeepGuard_GNN_Extra_Final.ipynb` trains an edge-aware GNN (reverse message passing, port numbering,
GINE-style layers, mean aggregation + LayerNorm) on three temporal graphs (train / train+val / all edges — labels of
validation/test are never used), and compares it with XGBoost on the same split:

| Model (test period)               | Precision | Recall | F1    | Avg. Precision | ROC-AUC |
| --------------------------------- | --------- | ------ | ----- | -------------- | ------- |
| XGBoost (reference)               | 0.895     | 0.622  | 0.734 | 0.741          | 0.992   |
| GNN (edge features only)          | 0.658     | 0.395  | 0.494 | 0.463          | 0.970   |
| GNN + behavioural features        | 0.742     | 0.644  | 0.690 | 0.688          | 0.993   |
| Blend (0.7 XGBoost + 0.3 GNN)     | 0.903     | 0.620  | 0.735 | 0.749          | 0.993   |

The GNN alone is **below** XGBoost; the blend's gain (AP 0.749 vs 0.741) lies inside the confidence intervals. Its value is
the *network view*: `gnn_account_risk.csv` (a risk score per account) and `cytoscape_top_alerts.json` (the highest-risk
transactions as Cytoscape elements) complement the `$graphLookup` graph visualiser.

**Important:** a GNN scores a whole period graph at once (structure and features — never labels), so it can see transactions
that happen *after* the one being scored. It is therefore a **batch / investigation module, not the real-time scorer**.
In the app it is optional: Upload page → "Also score with the Graph Neural Network", `POST /analyze/gnn`,
`GET /models/gnn/status`, Admin → AI Models. It is a custom PyTorch model — **no `torch_geometric` is required**. Its
threshold (0.977) was tuned on the full 5 M-edge graph, so on a small upload the graph is sparse and scores are less reliable.

---

## 🚀 Quick Start

Full instructions (Supabase, MongoDB, free LLM options for report text) are in **[SETUP_GUIDE.md](./SETUP_GUIDE.md)**.

```bash
# 1. AI Engine  (Python 3.10+; trained models are already in ai-engine/saved_models/)
cd ai-engine
python -m venv venv && source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt                           # Windows CPU torch: see the note inside requirements.txt
uvicorn main:app --reload --port 8000
#   http://localhost:8000/health  →  "demo_mode": false   means the real models are active
python tests/test_engine.py                               # optional: end-to-end self-test against the real models

# 2. Node backend (MongoDB must be running)
cd backend-node && cp .env.example .env && npm install && npm run dev

# 3. React frontend
cd frontend && cp .env.example .env && npm install && npm run dev
```

**Retraining (optional).** Open a notebook in Google Colab with a **T4 GPU + High-RAM** runtime and *Run all*
(`DeepGuard_Training_Final.ipynb` ≈ 40–55 min; the GNN notebook has a `QUICK_TEST` switch — try `True` first, ≈ 2 min).
Both download `HI-Small_Trans.csv` from Kaggle ([dataset](https://www.kaggle.com/datasets/ealtman2019/ibm-transactions-for-anti-money-laundering-aml);
the 476 MB CSV is `.gitignore`d). Unzip the results into `ai-engine/saved_models/` using the folder names shown above.

---

## 📋 FYP Functional Requirements — Coverage

Mapped against the 20 functional requirements of Activity #3.

| #     | Requirement                 | Status  | Where                                                                                               |
| ----- | --------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| FR-1  | User Login                  | ✅ Done | `backend-node/src/routes/auth.routes.js`, Supabase Auth                                             |
| FR-2  | Admin Login                 | ✅ Done | Same login route; role from Supabase `user_metadata.role`                                           |
| FR-3  | Session Management          | ✅ Done | Supabase session + JWT, `App.jsx`                                                                   |
| FR-4  | Logout                      | ✅ Done | `auth.routes.js` `/logout`, `Layout.jsx`                                                            |
| FR-5  | Display Dashboard           | ✅ Done | `dashboard.routes.js`, `DashboardPage.jsx`                                                          |
| FR-6  | Upload Transaction File     | ✅ Done | `upload.controller.js` (CSV/XLSX, 100 MB limit)                                                     |
| FR-7  | Run Anomaly Detection       | ✅ Done | `ai-engine/main.py` — Autoencoder + XGBoost (+ Isolation Forest signal, optional GNN)               |
| FR-8  | View Anomaly Results        | ✅ Done | `analysis.routes.js`, `AnalysisPage.jsx` (filter/search/sort/paginate)                              |
| FR-9  | Network Graph Visualization | ✅ Done | `graph.controller.js` (`$graphLookup`), `GraphPage.jsx` (Cytoscape.js)                              |
| FR-10 | SHAP Explainability         | ✅ Done | `shap_for_rows()` in `main.py` (exact TreeSHAP), SHAP bars in `AnalysisPage.jsx`                    |
| FR-11 | Generate Forensic Report    | ✅ Done | `report.controller.js` (Puppeteer PDF + AI summary)                                                 |
| FR-12 | View Performance Analytics  | ✅ Done | `GET /dashboard/performance` → `PerformancePage.jsx` (real model metrics, operating points, system stats) |
| FR-13 | Manage Users                | ✅ Done | `admin.routes.js` `/users*`, Users tab in `AdminPage.jsx`                                           |
| FR-14 | Manage AI Models            | ✅ Done | `GET/PATCH /models/config` in `main.py`, AI Models tab (threshold + weights, persisted to `engine_config.json`) |
| FR-15 | View System Logs            | ✅ Done | `/admin/logs`, System Logs tab (reuses the `Job` collection)                                        |
| FR-16 | Export Data                 | ✅ Done | `/analysis/job/:jobId/export`, CSV/JSON buttons                                                     |
| FR-17 | Role-Based Access Control   | ✅ Done | `requireAdmin`/`requireAuditor`, `ProtectedRoute`                                                   |
| FR-18 | Bulk Processing Queue       | ✅ Done | `src/queue/uploadQueue.js` — Redis/Bull when `REDIS_URL` is reachable, otherwise in-process queue   |
| FR-19 | Alert Notifications         | ✅ Done | Socket.IO in-dashboard + e-mail (`email.service.js`)                                                |
| FR-20 | Data Backup and Recovery    | ✅ Done | `backup.service.js` — daily backup, 30-day retention, integrity-checked restore                     |

---

## 🧰 Tech Stack

| Layer     | Technology                                                                         |
| --------- | ---------------------------------------------------------------------------------- |
| Frontend  | React, Vite, Tailwind CSS, Redux, Cytoscape.js, Recharts                           |
| Backend   | Node.js, Express, Socket.IO, Puppeteer, Mongoose                                   |
| AI Engine | Python, FastAPI, PyTorch (Autoencoder, GNN), XGBoost, scikit-learn (Isolation Forest), SHAP (native TreeSHAP) |
| Database  | MongoDB (`$graphLookup`), Supabase (auth)                                          |
| Report AI | Groq (free) / Ollama (local) / OpenAI (optional)                                   |

---

## ✅ What was verified in this version (and what was not)

Checked by running the code against the **real committed model files**:

- AI Engine boots with the real models (`demo_mode: false`, GNN loaded); `/health`, `/analyze/batch`, `/analyze/single`,
  `/analyze/gnn`, `/models/info`, `/models/config` (GET/PATCH) respond correctly, incl. malformed input.
- **Feature parity:** the engine's 47 features equal the training notebook's (max difference 0.0).
- **Chunk/context correctness:** 3 × 1,000-row chunks with a job id score identically to one 3,000-row batch (difference 0.0);
  without the job context they differ by up to 85 points — which is why the gateway sends one job id in time order.
- The notebooks themselves verify the features against brute-force loops (`T01_feature_bruteforce_check.csv`) and the GNN's
  stand-alone reload (difference < 1e-6).
- `npm run build` (Vite) succeeds for the frontend; syntax checks pass for every changed Node file (`node --check`); `sortByTimestamp` unit-tested.

**Not verified here:** the full MongoDB-/Supabase-backed request flow, PDF generation (Puppeteer), LLM report text and
e-mail (need live credentials), and the accuracy of the model on files that are not from the IBM AML data.

---

## ⚠️ Known Limitations (state these plainly in your report)

1. **The detector needs account history.** `/analyze/single` scores one transaction with no history, so the behavioural
   features are empty and the result is unreliable (the response says so). Upload files for real analysis. History is kept for
   the last 200 000 rows of a job; accounts older than that lose some history.
2. **Trained on one synthetic world.** The model is specific to `HI-Small_Trans.csv`; other IBM files (`LI-*`, `HI-Medium`)
   have different accounts/patterns. Uploaded files must use the IBM column layout; unknown currency/format labels are treated
   as missing values.
3. **Imbalance and drift.** Fraud is 0.1–0.18 %; precision/recall at the chosen threshold are 0.87 / 0.64. Lowering the
   threshold raises recall at the cost of many more alerts (see operating points). Behaviour drifts over time, so periodic
   retraining would be needed in production.
4. **Isolation Forest and the Autoencoder add little** on top of XGBoost on this data (differences are within the confidence
   intervals); the Isolation Forest / Autoencoder numbers in the UI are *display scores* on a 0–100 scale (Autoencoder:
   relative reconstruction error; Isolation Forest: scikit-learn's own anomaly score with 0.5 as the boundary) and are not
   part of the default decision.
5. **GNN is batch-mode and optional** (it sees the whole graph of a period, including later transactions) and is below XGBoost
   on its own.
6. **`/models/config` has no auth inside the AI Engine** — it is protected only by the Node gateway's `requireAdmin`. Do not
   expose port 8000 to the internet.
7. **In-process queue mode** (no `REDIS_URL`) loses queued-but-not-started jobs on restart.

---

_DeepGuard — Iqra University CS Batch 2023 | Supervised by Dr. Dure e Jabeen_
