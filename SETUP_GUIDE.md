# 🛡️ DeepGuard — Complete Setup Guide

> **Iqra University FYP 2023** |

---

## ✅ Prerequisites

| Tool    | Version    | Download                                       |
| ------- | ---------- | ---------------------------------------------- |
| Node.js | 18+        | https://nodejs.org                             |
| Python  | 3.10+      | https://python.org                             |
| MongoDB | 7+ (local) | https://www.mongodb.com/try/download/community |
| Git     | any        | https://git-scm.com                            |

---

## 🗂️ Project Structure Summary

```
Last_DeepGuard/
├── 📓 notebooks/          ← Google Colab: DeepGuard_Training_Final + DeepGuard_GNN_Extra_Final
├── 🤖 ai-engine/          ← Python FastAPI (AI microservice) + saved_models/ (trained models, tables, figures)
├── ⚙️  backend-node/      ← Node.js Express (API gateway)
└── 🌐 frontend/           ← React.js (dashboard)
```

---

## 📋 STEP-BY-STEP SETUP

### STEP 1 — Supabase (Free Auth + Database)

1. Go to **https://supabase.com** → Create account → New project
2. Go to **Project Settings → API**
3. Copy:
   - `Project URL` → used as `SUPABASE_URL` / `VITE_SUPABASE_URL`
   - `anon public` key → used as `VITE_SUPABASE_ANON_KEY`
   - `service_role` key → used as `SUPABASE_SERVICE_KEY`
4. Create the demo accounts — **do NOT use raw SQL `INSERT INTO auth.users`** (see
   warning below). Instead, after setting up `backend-node/.env` (Step 3 below), run:

```bash
cd backend-node
npm install
node scripts/create-demo-users.js
```

This creates `admin@deepguard.demo` / `auditor@deepguard.demo` (password
`deepguard123` for both) using Supabase's Admin API, which correctly sets up
everything a raw SQL insert misses.

> ⚠️ **Why not raw SQL?** An earlier version of this guide had you run
> `INSERT INTO auth.users (...) VALUES (...)` directly in the SQL Editor. **Don't do
> this.** Supabase's auth server (GoTrue) requires a matching row in
> `auth.identities` to log a user in with email+password — a raw `INSERT` into
> `auth.users` only creates half of what's needed, so `signInWithPassword()` will
> fail with `"Invalid login credentials"` even though the password hash is
> technically correct. Always create users via `supabase.auth.admin.createUser()`
> (the script above), `supabase.auth.signUp()` (your app's own `/api/auth/register`
> route), or the Supabase Dashboard's **Authentication → Users → Add User** button —
> all three correctly create the identity row too. If you already ran the broken SQL
> and users exist but can't log in, delete them (`DELETE FROM auth.users WHERE
> email IN (...)`) and re-run the script above.

---

### STEP 2 — Free AI for Reports (choose ONE)

#### Option A: Groq API (RECOMMENDED — Free, Fast, No credit card)

1. Go to **https://console.groq.com**
2. Sign up → Create API key (completely free)
3. Add to `backend-node/.env`:
   ```
   GROQ_API_KEY=gsk_your_key_here
   ```

#### Option B: Ollama (100% Local — No internet needed)

1. Download from **https://ollama.ai**
2. Install and run:
   ```bash
   ollama serve          # starts Ollama server
   ollama pull llama3    # download model (~4GB)
   ```
3. Add to `backend-node/.env`:
   ```
   OLLAMA_URL=http://localhost:11434
   OLLAMA_MODEL=llama3
   ```

#### Option C: OpenAI (Paid — optional)

```
OPENAI_API_KEY=sk-your-key-here
```

> **Note:** If none are set, DeepGuard generates reports with a built-in rule-based summary. Everything else still works perfectly.

---

### STEP 3 — AI models (already trained — retrain only if you want to)

**The trained models are already in the repo** (`ai-engine/saved_models/`), so you can skip straight to Step 4.

```
ai-engine/saved_models/
├── deepguard_training_results/          ← core detector (from DeepGuard_Training_Final.ipynb)
│   ├── models/   xgboost_final.json · autoencoder.pt · ae_prep.pkl · isolation_forest.pkl · feature_cols.pkl · metadata.json
│   ├── tables/   T00…T12 .csv (all metrics, classification reports, CIs, operating points, SHAP importance)
│   └── figures/  fig01…fig17 .png (for your report)
└── deepguard_gnn_results/               ← OPTIONAL GNN extra (from DeepGuard_GNN_Extra_Final.ipynb)
    ├── models/   gnn_best.pt · gnn_config.json · gnn_model_def.py · gnn_edge_scaler.pkl · gnn_account_risk.csv · …
    └── tables/ · figures/
```

If the core folder is missing the AI engine starts in **DEMO MODE** (random scores — fine for testing the UI).

**To retrain (optional, Google Colab):**

1. Go to **https://colab.research.google.com** → upload the two notebooks from `notebooks/`.
2. Runtime → Change runtime type → **T4 GPU** and **High-RAM**.
3. The notebooks download `HI-Small_Trans.csv` from Kaggle themselves — upload your `kaggle.json` (Kaggle → Settings → API → Create New Token)
   when asked, or put the CSV in `MyDrive/fyp-projects/final_model/`.
   Dataset: https://www.kaggle.com/datasets/ealtman2019/ibm-transactions-for-anti-money-laundering-aml (use `HI-Small_Trans.csv`).
4. **`DeepGuard_Training_Final.ipynb`** → *Run all* (≈ 40–55 min). It trains Isolation Forest, Autoencoder and four XGBoost variants,
   prints every metric + classification report, saves all figures/tables, and downloads `DeepGuard_Training_Results.zip`.
5. Unzip it into `ai-engine/saved_models/deepguard_training_results/` (so `models/`, `tables/`, `figures/` sit directly inside).
6. *(Optional)* **`DeepGuard_GNN_Extra_Final.ipynb`** → first set `QUICK_TEST = True` and *Run all* (≈ 2 min, only checks that it runs),
   then `QUICK_TEST = False`, *Restart session and run all* (≈ 40–60 min). Unzip `deepguard_gnn_results.zip` into
   `ai-engine/saved_models/deepguard_gnn_results/`.
7. Restart the AI Engine. `GET /health` → `"demo_mode": false`; `GET /models/gnn/status` → `"available": true` if the GNN folder is present.

> Retraining produces new numbers — update the results tables in `README.md` from the notebook's `RESULTS_SUMMARY.md`.

---

### STEP 4 — Configure Environment Variables

#### `ai-engine/.env`

```env
MODEL_PATH=./saved_models
PORT=8000
# optional: CONTEXT_ROWS=200000   (account history kept between upload chunks)
# optional: USE_TRAINVAL_MODEL=false
```

#### `backend-node/.env`

```env
PORT=4000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/deepguard
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
AI_ENGINE_URL=http://localhost:8000
FRONTEND_URL=http://localhost:5173
GROQ_API_KEY=gsk_your_key_here        # OR
# OLLAMA_URL=http://localhost:11434    # OR
# OPENAI_API_KEY=sk-...               # optional
```

#### `frontend/.env`

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
VITE_API_URL=http://localhost:4000/api
VITE_SOCKET_URL=http://localhost:4000
```

---

### STEP 5 — Start MongoDB

```bash
# Windows
net start MongoDB

# macOS
brew services start mongodb-community

# Linux
sudo systemctl start mongod
```

---

### STEP 6 — Start All Services

#### Option A: One command (recommended)

```bash
cd Last_DeepGuard
bash start-all.sh
```

#### Option B: Manual (3 separate terminals)

**Terminal 1 — AI Engine**

```bash
cd Last_DeepGuard/ai-engine
python3 -m venv venv              # Python 3.10+ required
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt   # Windows: install CPU torch first (see requirements.txt)
uvicorn main:app --reload --port 8000
```

**Terminal 2 — Node.js Backend**

```bash
cd Last_DeepGuard/backend-node
npm install
npm run dev
```

**Terminal 3 — React Frontend**

```bash
cd Last_DeepGuard/frontend
npm install
npm run dev
```

---

### STEP 7 — Access the App

| Service               | URL                        |
| --------------------- | -------------------------- |
| 🌐 Frontend Dashboard | http://localhost:5173      |
| ⚙️ Backend API        | http://localhost:4000/api  |
| 🤖 AI Engine          | http://localhost:8000      |
| 📖 AI API Docs        | http://localhost:8000/docs |

**Login credentials (demo):**

- Admin: `admin@deepguard.demo` / `deepguard123`
- Auditor: `auditor@deepguard.demo` / `deepguard123`

---

## 🧪 Testing Without Real Data

1. Login with demo credentials
2. Click **"Demo Auditor"** or **"Demo Admin"** on login page
3. Dashboard shows mock data immediately
4. Upload a CSV in the IBM AML layout (columns: Timestamp, From Bank, Account, To Bank, Account.1, Amount Received, Receiving Currency, Amount Paid, Payment Currency, Payment Format, Is Laundering) — with real models loaded the scores are real; in demo mode they are random.
   The model uses account *history*, so use a file with many transactions per account (e.g. a few thousand rows sliced from `HI-Small_Trans.csv` in time order), not 5–10 isolated rows.
5. Network graph shows demo circular transaction pattern
6. PDF report generates with rule-based summary

---

## 🐛 Common Issues

| Issue                    | Fix                                                                     |
| ------------------------ | ----------------------------------------------------------------------- |
| MongoDB connection error | Make sure MongoDB is running: `mongod --dbpath /data/db`                |
| Supabase auth error      | Check SUPABASE_URL and keys in `.env` files                             |
| AI Engine 503            | Start `uvicorn main:app --reload` in `ai-engine/`                       |
| `/health` says `demo_mode: true` | Core models not found — check `ai-engine/saved_models/deepguard_training_results/models/xgboost_final.json` exists, or torch isn't installed |
| `pip install` fails for xgboost 3.4.1 | Use Python 3.10+ (xgboost 3.x does not support older Python)       |
| Scores look odd for a tiny file | The detector needs account history — upload thousands of rows, not a handful |
| CORS error               | Make sure FRONTEND_URL in backend `.env` matches port 5173              |
| Port in use              | Change PORT in `.env` files                                             |
| Puppeteer error on PDF   | `npm install puppeteer` or use `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false` |

---

## 🏗️ Architecture Summary

```
React Frontend (5173)
    ↕ REST + Socket.IO
Node.js Backend (4000)
    ↕ REST API          ↕ MongoDB ($graphLookup)
Python FastAPI (8000)   features.py → Autoencoder (PyTorch) → XGBoost → SHAP  (+ Isolation Forest signal, optional GNN)
    ↕ joblib / torch / xgboost
Trained models (ai-engine/saved_models/…)
```

---

## 📊 IBM AML Dataset Info

| File                                          | Size                                      | Transactions                          |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| **HI-Small_Trans.csv** (used by this project) | 476 MB                                    | ~5.08M (~0.10% flagged as laundering) |
| LI-Small_Trans.csv                            | check the Kaggle page — not verified here | —                                     |
| HI-Medium_Trans.csv                           | check the Kaggle page — not verified here | —                                     |

Use **HI-Small_Trans.csv** (note the hyphen — Kaggle's actual filename, not an underscore).
This is the only file this project's notebooks, `.gitignore`, and the numbers quoted throughout
this repo assume; the other variants are a different synthetic "world" with different account
IDs, not just a bigger sample of the same one, so don't mix them with the trained models here.

---

_DeepGuard — Iqra University CS Batch 2023 | Supervised by Dr. Dure e Jabeen_
