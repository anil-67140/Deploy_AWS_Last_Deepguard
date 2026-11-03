"""
DeepGuard — AI Engine (FastAPI)  ·  v2.0 (models from DeepGuard_Training_Final.ipynb + DeepGuard_GNN_Extra_Final.ipynb)

Serving pipeline (identical to training):
    uploaded transactions
      -> 47 past-only behavioural features            (features.py == notebook Step 2)
      -> Autoencoder (PyTorch)  : reconstruction error + 8-d code   -> 9 extra features
      -> XGBoost "final" model  : 56 features -> fraud probability  (THE decision model, threshold from validation)
      -> SHAP (XGBoost native TreeSHAP) for the explanation
    Isolation Forest + Autoencoder scores are also reported as unsupervised anomaly signals.
    Optional extra: GNN (custom PyTorch, no torch_geometric needed) scored on the batch's account graph.

Account history: the features need each account's earlier transactions. The Node gateway sends a job in chunks, so the engine
keeps a rolling per-job context (the latest CONTEXT_ROWS rows) and computes every chunk's features on context + chunk.
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from collections import OrderedDict
from datetime import datetime
import importlib.util
import threading
import warnings
import logging
import json
import time
import os

import numpy as np
import pandas as pd
import joblib

import features as FE

logging.basicConfig(level=logging.INFO, format='%(asctime)s — %(levelname)s — %(message)s')
logger = logging.getLogger("deepguard-ai")

# torch is required for the autoencoder (and the optional GNN). If it is missing the engine falls back to demo mode.
try:
    import torch
    import torch.nn as nn
    TORCH_AVAILABLE = True
except Exception as e:  # pragma: no cover
    TORCH_AVAILABLE = False
    logger.warning(f"torch not available ({e}) — AI Engine will run in DEMO mode")

CONTEXT_ROWS = int(os.getenv("CONTEXT_ROWS", "200000"))      # rolling per-job history kept between chunks
CONTEXT_JOBS = int(os.getenv("CONTEXT_JOBS", "8"))           # how many jobs' contexts are kept in memory
MAX_BATCH = int(os.getenv("MAX_BATCH", "100000"))
PIPE_LOCK = threading.Lock()


if TORCH_AVAILABLE:
    class AE(nn.Module):
        """Autoencoder exactly as trained in the notebook: D -> 64 -> 32 -> 8 -> 32 -> 64 -> D."""
        def __init__(s, d, z=8):
            super().__init__()
            s.enc = nn.Sequential(nn.Linear(d, 64), nn.ReLU(), nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, z))
            s.dec = nn.Sequential(nn.Linear(z, 32), nn.ReLU(), nn.Linear(32, 64), nn.ReLU(), nn.Linear(64, d))

        def forward(s, x):
            z = s.enc(x)
            return s.dec(z), z


app = FastAPI(
    title="DeepGuard AI Engine",
    description="AML fraud detection: Autoencoder + XGBoost (+ Isolation Forest signal, optional GNN) with SHAP explanations",
    version="2.0.0",
)
# The engine is an INTERNAL service (only the Node backend calls it); browsers never need direct access.
# Override with ENGINE_CORS_ORIGINS="http://a,http://b" if you really need to.
_origins = [o.strip() for o in os.getenv("ENGINE_CORS_ORIGINS", "http://localhost:5173,http://localhost:4000").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


# ─────────────────────────────────────────────
# Model registry
# ─────────────────────────────────────────────
class ModelRegistry:
    _instance = None
    _models_loaded = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    # ---- paths -------------------------------------------------------------------------------------------------
    @staticmethod
    def _dirs():
        base = os.getenv("MODEL_PATH", "./saved_models")
        core = os.getenv("CORE_MODEL_DIR") or os.path.join(base, "deepguard_training_results", "models")
        if not os.path.exists(os.path.join(core, "xgboost_final.json")) and os.path.exists(os.path.join(base, "xgboost_final.json")):
            core = base                                                     # flat layout also accepted
        gnn = os.getenv("GNN_MODEL_DIR") or os.path.join(base, "deepguard_gnn_results", "models")
        return base, core, gnn

    # ---- loading -----------------------------------------------------------------------------------------------
    def load_models(self):
        if self._models_loaded:
            return
        self.base_dir, self.core_dir, self.gnn_dir = self._dirs()
        self.results_dir = os.path.dirname(self.core_dir) if os.path.basename(self.core_dir) == "models" else self.core_dir
        self.gnn_results_dir = os.path.dirname(self.gnn_dir) if os.path.basename(self.gnn_dir) == "models" else self.gnn_dir
        self.gnn_available = False
        logger.info(f"Loading core models from: {self.core_dir}")

        try:
            if not TORCH_AVAILABLE:
                raise FileNotFoundError("torch is not installed")

            fc = joblib.load(os.path.join(self.core_dir, "feature_cols.pkl"))
            self.base_features = list(fc["base_features"])
            self.final_features = list(fc["final_features"])
            self.uses_ae = bool(fc.get("uses_ae", "AE_err" in self.final_features))
            self.uses_if = bool(fc.get("uses_if", "IF_score" in self.final_features))
            self.feature_cols = self.final_features                     # what /models/info reports

            # Autoencoder + its preprocessing (fitted on normal train rows only)
            prep = joblib.load(os.path.join(self.core_dir, "ae_prep.pkl"))
            self.ae_med, self.ae_mu, self.ae_sd = prep["med"], prep["mu"], prep["sd"]
            self.autoencoder = AE(len(self.base_features))
            self.autoencoder.load_state_dict(torch.load(os.path.join(self.core_dir, "autoencoder.pt"), map_location="cpu"))
            self.autoencoder.eval()
            logger.info("✅ Autoencoder (PyTorch) loaded")

            # Isolation Forest (fitted without labels on AE-preprocessed train rows; score = -score_samples)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                self.isolation_forest = joblib.load(os.path.join(self.core_dir, "isolation_forest.pkl"))
            logger.info("✅ Isolation Forest loaded")

            # XGBoost final model (trained on train only; the validated threshold belongs to THIS file)
            import xgboost as xgb
            xgb_file = "xgboost_final_trainval.json" if os.getenv("USE_TRAINVAL_MODEL", "false").lower() == "true" else "xgboost_final.json"
            self.xgboost_model = xgb.XGBClassifier()
            self.xgboost_model.load_model(os.path.join(self.core_dir, xgb_file))
            self.xgb_file = xgb_file
            logger.info(f"✅ XGBoost loaded ({xgb_file}, {len(self.final_features)} features)")

            # Training metadata -> thresholds, performance, SHAP importance
            self._build_metadata()
            self._load_runtime_config()
            self.ae_ref_error = self._ae_reference_error()

            self._load_gnn()
            self._models_loaded = True
            logger.info(f"✅ Ready. Final model: {self.metadata.get('final_model', {}).get('label')} | "
                        f"threshold {self.ensemble_threshold:.4f} | weights {self.ensemble_weights} | GNN: {self.gnn_available}")

        except (FileNotFoundError, KeyError, OSError) as e:
            logger.warning(f"⚠️  Model files not found / unreadable: {e}")
            logger.warning("⚠️  Running in DEMO mode with random predictions (see SETUP_GUIDE.md for the expected saved_models/ layout)")
            self.isolation_forest = self.autoencoder = self.xgboost_model = None
            self.base_features = self.final_features = self.feature_cols = []
            self.uses_ae = self.uses_if = False
            self.ensemble_threshold = 0.5
            self.ensemble_weights = {"xgboost": 1.0, "autoencoder": 0.0, "isolation_forest": 0.0}
            self.ae_ref_error = 0.1
            self.gnn_available = False
            self.metadata = {"model_performance": {}, "shap_feature_importance": {}, "ensemble_weights": self.ensemble_weights,
                             "ensemble_threshold": self.ensemble_threshold}
            self._models_loaded = True

    # ---- metadata (REAL numbers from the training notebooks' saved outputs) ------------------------------------
    def _build_metadata(self):
        meta = _read_json(os.path.join(self.results_dir, "metadata.json")) or _read_json(os.path.join(self.core_dir, "metadata.json"), {})
        tdir = os.path.join(self.results_dir, "tables")
        names = {"Isolation Forest alone": "isolation_forest", "Autoencoder alone": "autoencoder", "Unsupervised AE+IF": "ae_if_unsupervised",
                 "XGBoost (base)": "xgboost", "XGBoost + AE": "xgboost_ae", "XGBoost + IF": "xgboost_if", "XGBoost + AE + IF": "xgboost_ae_if"}
        labels = {"isolation_forest": "Isolation Forest", "autoencoder": "Autoencoder", "ae_if_unsupervised": "AE + IF (unsupervised)",
                  "xgboost": "XGBoost (base)", "xgboost_ae": "XGBoost + AE", "xgboost_if": "XGBoost + IF", "xgboost_ae_if": "XGBoost + AE + IF"}
        keymap = {"ROC_AUC": "roc_auc", "AP_PR_AUC": "avg_prec", "F1": "f1", "Precision": "precision", "Recall": "recall", "MCC": "mcc", "Accuracy": "accuracy"}
        perf = {}
        for model, key in names.items():
            for src, dst in keymap.items():
                v = (meta.get("all_models", {}).get(model, {}) or {}).get(src)
                if v is not None:
                    perf[f"{key}_{dst}"] = float(v)

        # GNN metrics (optional module)
        gsum = _read_json(os.path.join(self.gnn_results_dir, "summary.json"), {}) or {}
        gnn_best = gsum.get("best_gnn", "GNN + behavioural features")
        gm = (gsum.get("test_metrics", {}) or {}).get(gnn_best, {})
        for src, dst in keymap.items():
            if gm.get(src) is not None:
                perf[f"gnn_{dst}"] = float(gm[src])
                labels["gnn"] = "GNN (optional extra)"
        blend = (gsum.get("test_metrics", {}) or {}).get("Blend (XGBoost + GNN + behavioural features)", {})
        for src, dst in keymap.items():
            if blend.get(src) is not None:
                perf[f"xgboost_gnn_blend_{dst}"] = float(blend[src])
                labels["xgboost_gnn_blend"] = "XGBoost + GNN blend (extra)"
        self.gnn_test_performance = {k: float(v) for k, v in {
            "precision": gm.get("Precision"), "recall": gm.get("Recall"), "f1": gm.get("F1"),
            "roc_auc": gm.get("ROC_AUC"), "avg_precision": gm.get("AP_PR_AUC"), "mcc": gm.get("MCC")}.items() if v is not None}
        self.gnn_summary = gsum

        # SHAP importance of the final model (normalised mean |SHAP|)
        shap_imp = {}
        try:
            t = pd.read_csv(os.path.join(tdir, "T10_shap_importance.csv"), index_col=0)["mean_abs_shap"]
            total = float(t.sum()) or 1.0
            shap_imp = {str(k): round(float(v) / total, 4) for k, v in t.sort_values(ascending=False).head(12).items()}
        except Exception:
            pass

        ops = []
        try:
            ops = pd.read_csv(os.path.join(tdir, "T09_operating_points_final_model.csv")).replace({np.nan: None}).to_dict("records")
        except Exception:
            pass

        final_key = {"XGBoost (base)": "xgboost", "XGBoost + AE": "xgboost_ae", "XGBoost + IF": "xgboost_if",
                     "XGBoost + AE + IF": "xgboost_ae_if"}.get(meta.get("final_variant"), "xgboost_ae")
        tm = meta.get("test_metrics", {}) or {}
        self.metadata = {
            "model_performance": perf,
            "model_labels": labels,
            "shap_feature_importance": shap_imp,
            "operating_points": ops,
            "final_model": {
                "key": final_key, "label": meta.get("final_variant", "XGBoost + AE"), "threshold": meta.get("threshold"),
                "config(depth,spw,mcw)": meta.get("config(depth,spw,mcw)"), "n_features": len(self.final_features),
                "uses_autoencoder": self.uses_ae, "uses_isolation_forest": self.uses_if,
                "test_metrics": {k: tm.get(k) for k in ["Accuracy", "Balanced_Accuracy", "Precision", "Recall", "Specificity", "F1", "F2",
                                                          "ROC_AUC", "AP_PR_AUC", "MCC", "Cohen_Kappa", "Brier", "Log_Loss", "Precision_at_k",
                                                          "TP", "FP", "FN", "TN", "Alerts"]},
                "refit_train_val_metrics": meta.get("refit_train_val_metrics"),
            },
            "training": {
                "dataset": meta.get("dataset"), "test_rows": meta.get("test_rows"), "test_fraud": meta.get("test_fraud"),
                "note": "Metrics are on a held-out, later time period (time-based 60/20/20 split). Fraud is ~0.18% of the test period, "
                        "so accuracy is not informative — use average precision, ROC-AUC, precision, recall, F1 and MCC.",
            },
            "model_files": {"core": self.core_dir, "gnn": self.gnn_dir if os.path.isdir(self.gnn_dir) else None, "xgboost_file": self.xgb_file},
        }
        self.default_threshold = float(meta.get("threshold", 0.5))
        self.ensemble_threshold = self.default_threshold
        self.ensemble_weights = {"xgboost": 1.0, "autoencoder": 0.0, "isolation_forest": 0.0}
        self.metadata["ensemble_weights"] = self.ensemble_weights
        self.metadata["ensemble_threshold"] = self.ensemble_threshold

    def _load_runtime_config(self):
        """Admin changes (FR-14) are persisted in saved_models/engine_config.json — the training outputs are never overwritten."""
        cfg = _read_json(os.path.join(self.base_dir, "engine_config.json"), None)
        if cfg:
            if cfg.get("ensemble_threshold") is not None:
                self.ensemble_threshold = float(cfg["ensemble_threshold"])
            if cfg.get("ensemble_weights"):
                self.ensemble_weights = cfg["ensemble_weights"]
            self.metadata["ensemble_weights"] = self.ensemble_weights
            self.metadata["ensemble_threshold"] = self.ensemble_threshold
            logger.info("ℹ️  Loaded admin overrides from engine_config.json")

    def _ae_reference_error(self):
        """Typical reconstruction error of NORMAL train rows (last epoch's train MSE) — used only to scale the AE display score."""
        try:
            h = pd.read_csv(os.path.join(self.results_dir, "tables", "T02_autoencoder_training_history.csv"))
            return float(h["train_mse"].iloc[-1])
        except Exception:
            return 0.1

    # ---- GNN (optional extra) ----------------------------------------------------------------------------------
    def _load_gnn(self):
        try:
            cfg_path = os.path.join(self.gnn_dir, "gnn_config.json")
            if not os.path.exists(cfg_path):
                logger.info(f"ℹ️  GNN disabled (no model at {self.gnn_dir})")
                return
            cfg = _read_json(cfg_path)
            spec = importlib.util.spec_from_file_location("gnn_model_def", os.path.join(self.gnn_dir, "gnn_model_def.py"))
            gm = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(gm)
            sc = joblib.load(os.path.join(self.gnn_dir, "gnn_edge_scaler.pkl"))
            if cfg["best_key"] != "B_behav":
                raise ValueError("serving code supports the 'GNN + behavioural features' variant (B_behav)")
            net = gm.Net(cfg["d_in"], 1, cfg["hidden"], cfg["layers"])
            net.load_state_dict(torch.load(os.path.join(self.gnn_dir, "gnn_best.pt"), map_location="cpu"), strict=True)
            net.eval()
            # decision threshold of this GNN (picked on validation in the notebook)
            thr = 0.5
            try:
                g3 = pd.read_csv(os.path.join(self.gnn_results_dir, "tables", "G03_all_metrics_all_models_TEST.csv")).set_index("Model")
                thr = float(g3.loc[cfg["best_variant"], "Threshold"])
            except Exception as e:
                logger.warning(f"GNN threshold table not found, using 0.5 ({e})")
            self.gnn_def, self.gnn_cfg, self.gnn_scaler, self.gnn_model, self.gnn_threshold = gm, cfg, sc, net, thr
            expected = len(cfg["num_cols"]) + sum(cfg["onehot_dims"])
            assert expected == cfg["d_in"], f"edge feature size {expected} != d_in {cfg['d_in']}"
            # smoke test on a tiny graph
            with torch.no_grad():
                g = gm.make_graph(np.array([0, 1]), np.array([1, 2]), 3, "cpu")
                net.N = 3
                h, e = net.encode(torch.zeros((2, cfg["d_in"])), g)
                assert net.score(h, e, g, torch.arange(2)).shape == (2,)
            self.gnn_available = True
            logger.info(f"✅ GNN loaded (stand-alone PyTorch, no torch_geometric) — threshold {thr:.4f}")
        except Exception as e:
            logger.warning(f"⚠️  GNN failed to load — GNN scoring disabled, core engine unaffected: {e}")
            self.gnn_available = False

    def is_demo_mode(self):
        return self.xgboost_model is None

    def is_gnn_available(self):
        return getattr(self, "gnn_available", False)


registry = ModelRegistry()


@app.on_event("startup")
async def startup_event():
    registry.load_models()
    logger.info("🚀 DeepGuard AI Engine started!")


# ─────────────────────────────────────────────
# Request / response models
# ─────────────────────────────────────────────
class Transaction(BaseModel):
    timestamp: Optional[str] = None
    from_bank: Optional[str] = None
    account: Optional[str] = None
    to_bank: Optional[str] = None
    to_account: Optional[str] = None
    amount_paid: float = Field(0.0, ge=0)
    payment_currency: Optional[str] = "US Dollar"
    amount_received: float = Field(0.0, ge=0)
    receiving_currency: Optional[str] = "US Dollar"
    payment_format: Optional[str] = "Wire"
    transaction_id: Optional[str] = None
    # Deprecated (v1 hand-made aggregates). Accepted so old clients keep working, but IGNORED: the engine now computes
    # the real history features itself from the batch/job context.
    sender_tx_count: Optional[int] = None
    sender_avg_amount: Optional[float] = None
    sender_unique_receivers: Optional[int] = None
    sender_total_amount: Optional[float] = None
    sender_max_amount: Optional[float] = None
    receiver_tx_count: Optional[int] = None


class BatchAnalysisRequest(BaseModel):
    transactions: List[Transaction]
    job_id: Optional[str] = None
    use_gnn: bool = False


class SingleTransactionRequest(BaseModel):
    transaction: Transaction
    use_gnn: bool = False


class GnnAnalysisRequest(BaseModel):
    transactions: List[Transaction]
    job_id: Optional[str] = None


class AnalysisResult(BaseModel):
    transaction_id: str
    risk_score: float
    risk_level: str
    is_fraud: bool
    isolation_forest_score: float
    autoencoder_score: float
    xgboost_score: float
    gnn_score: Optional[float] = None
    gnn_flagged: Optional[bool] = None
    fraud_category: str
    shap_values: Optional[Dict[str, float]] = None
    shap_signed: Optional[Dict[str, float]] = None
    processing_time_ms: float


# ─────────────────────────────────────────────
# Per-job context (so chunked uploads still see each account's history)
# ─────────────────────────────────────────────
_CONTEXT: "OrderedDict[str, pd.DataFrame]" = OrderedDict()


def _get_context(job_id):
    if not job_id or job_id not in _CONTEXT:
        return None
    _CONTEXT.move_to_end(job_id)
    return _CONTEXT[job_id]


def _store_context(job_id, df_sorted):
    if not job_id:
        return
    tail = df_sorted[FE.RAW_COLS].iloc[-CONTEXT_ROWS:].copy()
    _CONTEXT[job_id] = tail
    _CONTEXT.move_to_end(job_id)
    while len(_CONTEXT) > CONTEXT_JOBS:
        _CONTEXT.popitem(last=False)


def _to_frame(transactions: List[Transaction]) -> pd.DataFrame:
    ts = pd.to_datetime([t.timestamp for t in transactions], errors="coerce")
    ts = pd.Series(ts)
    if ts.isna().any():                                            # missing/unparseable timestamps keep their upload order
        base = ts.min() if ts.notna().any() else pd.Timestamp.now().floor("min")
        fill = pd.Series([base + pd.Timedelta(minutes=i) for i in range(len(ts))])
        ts = ts.where(ts.notna(), fill)
    return pd.DataFrame({
        "Timestamp": ts.to_numpy(),
        "From_Bank": [str(t.from_bank or "") for t in transactions],
        "Sender": [str(t.account or "") for t in transactions],
        "To_Bank": [str(t.to_bank or "") for t in transactions],
        "Receiver": [str(t.to_account or "") for t in transactions],
        "Amount_Received": [float(t.amount_received) for t in transactions],
        "Receiving_Currency": [FE.normalize_currency(t.receiving_currency) for t in transactions],
        "Amount_Paid": [float(t.amount_paid) for t in transactions],
        "Payment_Currency": [FE.normalize_currency(t.payment_currency) for t in transactions],
        "Payment_Format": [FE.normalize_format(t.payment_format) for t in transactions],
    })


# ─────────────────────────────────────────────
# Model scoring helpers
# ─────────────────────────────────────────────
def _slog(X):
    return np.sign(X) * np.log1p(np.abs(X))


def ae_prep(X):
    r = registry
    Z = _slog(X)
    Z = np.where(np.isnan(Z), r.ae_med, Z)
    return np.clip((Z - r.ae_mu) / r.ae_sd, -6, 6).astype("float32")


def ae_out(X, bs=100_000):
    registry.autoencoder.eval()
    errs, zs = [], []
    with torch.no_grad():
        for i in range(0, len(X), bs):
            xb = torch.from_numpy(ae_prep(X[i:i + bs]))
            out, z = registry.autoencoder(xb)
            errs.append(((out - xb) ** 2).mean(1).numpy())
            zs.append(z.numpy())
    return np.concatenate(errs).astype("float32"), np.vstack(zs).astype("float32")


def if_score_raw(X, bs=200_000):
    return np.concatenate([-registry.isolation_forest.score_samples(ae_prep(X[i:i + bs])) for i in range(0, len(X), bs)]).astype("float32")


def final_matrix(X, err, z, isf):
    parts = [X] + ([err[:, None], z] if registry.uses_ae else []) + ([isf[:, None]] if registry.uses_if else [])
    return np.hstack(parts).astype("float32")


def gnn_edge_scores(F_all: pd.DataFrame, df_sorted: pd.DataFrame):
    """Score EVERY edge of the (context + batch) graph with the GNN. Built exactly like notebook XE_B."""
    r = registry
    cfg, sc = r.gnn_cfg, r.gnn_scaler
    Xnum = F_all[cfg["num_cols"]].to_numpy(dtype="float32")
    Z = _slog(Xnum)
    Z = np.where(np.isnan(Z), sc["med"], Z)
    Xs = np.clip((Z - sc["mu"]) / sc["sd"], -6, 6).astype("float32")
    oh = []
    for c, k in zip(cfg["cat_cols"], cfg["onehot_dims"]):
        codes = F_all[c].to_numpy()
        a = np.zeros((len(codes), k), "float32")
        codes = np.nan_to_num(codes.astype("float64"), nan=-1).astype(int)
        ok = (codes >= 0) & (codes < k)      # -1 / unseen label -> all-zero row (never wraps to the last column)
        a[np.where(ok)[0], codes[ok]] = 1.0
        oh.append(a)
    XE = np.hstack([Xs] + oh).astype("float32")
    codes, _ = pd.factorize(pd.concat([df_sorted["Sender"], df_sorted["Receiver"]], ignore_index=True))
    n = len(df_sorted)
    src, dst = codes[:n].astype("int64"), codes[n:].astype("int64")
    n_nodes = int(codes.max()) + 1
    g = r.gnn_def.make_graph(src, dst, n_nodes, "cpu")
    with torch.no_grad():
        r.gnn_model.N = n_nodes                                   # node init is one shared learned vector -> any graph size works
        h, e = r.gnn_model.encode(torch.from_numpy(XE), g)
        out = []
        for a in range(0, n, 400_000):
            idx = torch.arange(a, min(a + 400_000, n))
            out.append(torch.sigmoid(r.gnn_model.score(h, e, g, idx)).numpy())
    return np.concatenate(out)


def shap_for_rows(X_final_rows: np.ndarray, top=8):
    """Exact TreeSHAP from the XGBoost booster (same method as notebook Step 6). Returns (abs-normalised, signed) dicts per row."""
    import xgboost as xgb
    contribs = registry.xgboost_model.get_booster().predict(xgb.DMatrix(X_final_rows), pred_contribs=True)
    sv = contribs[:, :-1]
    names = registry.final_features
    outs = []
    for row in sv:
        a = np.abs(row)
        tot = a.sum() + 1e-9
        order = np.argsort(-a)[:top]
        outs.append(({names[i]: round(float(a[i] / tot), 4) for i in order}, {names[i]: round(float(row[i]), 4) for i in order}))
    return outs


def get_fraud_category(risk_score: float, payment_format: str, amount_diff: float) -> str:
    if risk_score < 0.3:
        return "Clean"
    elif payment_format == "Bitcoin" and risk_score > 0.7:
        return "Cryptocurrency Laundering"
    elif abs(amount_diff) < 1.0 and risk_score > 0.6:
        return "Circular Transaction"
    elif risk_score > 0.85:
        return "High-Risk AML Typology"
    elif risk_score > 0.7:
        return "Suspicious Layering"
    elif risk_score > 0.5:
        return "Unusual Transfer Volume"
    else:
        return "Low-Risk Anomaly"


# ─────────────────────────────────────────────
# Core analysis
# ─────────────────────────────────────────────
def analyze_transactions(transactions: List[Transaction], use_gnn: bool = False, job_id: Optional[str] = None,
                         always_shap: bool = False, gnn_only: bool = False) -> Dict[str, Any]:
    start = time.time()
    n_req = len(transactions)
    r = registry

    if r.is_demo_mode():
        rng = np.random.default_rng(42)
        xs, ae_s, if_s = (np.clip(rng.beta(2, 5, n_req), 0, 1) for _ in range(3))
        gnn_s = None
        shap_rows = [None] * n_req
        history_rows = 0
    else:
        with PIPE_LOCK:
            df_new = _to_frame(transactions)
            df_new["_ord"] = np.arange(n_req)
            df_new["_new"] = True
            ctx = _get_context(job_id)
            if ctx is not None and len(ctx):
                c = ctx.copy()
                c["_ord"] = -1
                c["_new"] = False
                df_all = pd.concat([c, df_new], ignore_index=True)
            else:
                df_all = df_new
            history_rows = len(df_all) - n_req
            df_sorted = df_all.sort_values("Timestamp", kind="stable").reset_index(drop=True)      # ties keep older rows first
            F_all = pd.concat([FE.build_features(df_sorted), FE.window_features(df_sorted)], axis=1)
            assert list(F_all.columns) == r.base_features, "feature order differs from the trained models"

            is_new = df_sorted["_new"].to_numpy()
            pos_new = np.where(is_new)[0]
            ord_new = df_sorted["_ord"].to_numpy()[pos_new]
            X_new = F_all.iloc[pos_new].to_numpy(dtype="float32")

            err, z = ae_out(X_new)
            isf = if_score_raw(X_new)                      # always computed: reported as an unsupervised anomaly signal
            Xf = final_matrix(X_new, err, z, isf)
            p_xgb = r.xgboost_model.predict_proba(Xf)[:, 1].astype("float64")

            gnn_new = None
            if (use_gnn or gnn_only) and r.is_gnn_available():
                try:
                    gnn_new = gnn_edge_scores(F_all, df_sorted)[pos_new]
                except Exception as e:
                    logger.warning(f"GNN scoring failed for this batch (core scores unaffected): {e}")
            _store_context(job_id, df_sorted)

        # back to the order of the request
        def unsort(a):
            out = np.empty_like(a)
            out[ord_new] = a
            return out
        xs, err_o, isf_o = unsort(p_xgb), unsort(err), unsort(isf)
        Xf_o = np.empty_like(Xf)
        Xf_o[ord_new] = Xf
        gnn_s = unsort(gnn_new.astype("float64")) if gnn_new is not None else None

        # display scales (0-1): AE = relative reconstruction error; IF = sklearn's own 0.5 boundary
        rel = err_o / (r.ae_ref_error + 1e-9)
        ae_s = rel / (rel + 4.0)
        if_s = np.clip((isf_o - 0.40) / 0.20, 0, 1)
        shap_rows = None

    # ── combine (admin-adjustable weights; default = XGBoost probability only) ──
    w = r.ensemble_weights
    num = w.get("xgboost", 1.0) * xs + w.get("autoencoder", 0.0) * ae_s + w.get("isolation_forest", 0.0) * if_s
    den = w.get("xgboost", 1.0) + w.get("autoencoder", 0.0) + w.get("isolation_forest", 0.0)
    if gnn_s is not None and w.get("gnn", 0.0) > 0:
        num = num + w["gnn"] * gnn_s
        den += w["gnn"]
    combined = num / den if den > 0 else xs
    thr = r.ensemble_threshold

    # ── SHAP only for rows that matter (or all, for single analysis) ──
    if shap_rows is None:
        sel = np.arange(n_req) if always_shap else np.where(combined >= thr * 0.5)[0]
        shap_rows = [None] * n_req
        if len(sel):
            try:
                for i, s in zip(sel, shap_for_rows(Xf_o[sel])):
                    shap_rows[i] = s
            except Exception as e:
                logger.warning(f"SHAP computation failed: {e}")

    per_ms = (time.time() - start) * 1000 / max(n_req, 1)
    results = []
    for i, tx in enumerate(transactions):
        risk = float(combined[i])
        if risk >= max(thr * 1.3, thr + 0.15):
            level = "Critical"
        elif risk >= thr:
            level = "High"
        elif risk >= thr * 0.5:
            level = "Medium"
        else:
            level = "Low"
        sh = shap_rows[i]
        g = float(gnn_s[i]) if gnn_s is not None else None
        results.append(AnalysisResult(
            transaction_id=tx.transaction_id or f"TX-{i + 1:05d}",
            risk_score=round(risk * 100, 2),
            risk_level=level,
            is_fraud=risk >= thr,
            isolation_forest_score=round(float(if_s[i]) * 100, 2),
            autoencoder_score=round(float(ae_s[i]) * 100, 2),
            xgboost_score=round(float(xs[i]) * 100, 2),
            gnn_score=round(g * 100, 2) if g is not None else None,
            gnn_flagged=(g >= r.gnn_threshold) if g is not None else None,
            fraud_category=get_fraud_category(risk, tx.payment_format or "Wire", tx.amount_paid - tx.amount_received),
            shap_values=sh[0] if sh else None,
            shap_signed=sh[1] if sh else None,
            processing_time_ms=round(per_ms, 2),
        ))
    return {"results": results, "history_rows": int(history_rows), "gnn_scores": gnn_s}


# ─────────────────────────────────────────────
# API routes
# ─────────────────────────────────────────────
@app.get("/")
async def root():
    return {"service": "DeepGuard AI Engine", "version": "2.0.0", "status": "running", "demo_mode": registry.is_demo_mode(),
            "models_loaded": registry._models_loaded, "timestamp": datetime.utcnow().isoformat()}


@app.get("/health")
async def health():
    demo = registry.is_demo_mode()
    return {
        "status": "healthy",
        "models": {"isolation_forest": not demo, "autoencoder": not demo, "xgboost": not demo, "scaler": not demo,
                   "gnn": registry.is_gnn_available()},
        "demo_mode": demo,
        "performance": registry.metadata.get("model_performance", {}),
    }


@app.post("/analyze/batch", response_model=Dict[str, Any])
def analyze_batch(request: BatchAnalysisRequest):
    """Analyze a batch. Send chunks of one upload with the SAME job_id and in time order so each chunk sees earlier history."""
    if len(request.transactions) == 0:
        raise HTTPException(status_code=400, detail="No transactions provided")
    if len(request.transactions) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"Max {MAX_BATCH:,} transactions per batch")
    start = time.time()
    logger.info(f"📥 Batch analysis: {len(request.transactions)} transactions | Job: {request.job_id}")
    try:
        out = analyze_transactions(request.transactions, use_gnn=request.use_gnn, job_id=request.job_id)
    except Exception as e:
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=str(e))
    results = out["results"]
    flagged = [x for x in results if x.is_fraud]
    critical = [x for x in results if x.risk_level == "Critical"]
    return {
        "job_id": request.job_id,
        "status": "completed",
        "summary": {
            "total_transactions": len(results),
            "flagged_count": len(flagged),
            "critical_count": len(critical),
            "clean_count": len(results) - len(flagged),
            "flagging_rate_pct": round(len(flagged) / max(len(results), 1) * 100, 2),
            "processing_time_ms": round((time.time() - start) * 1000, 2),
            "history_rows_used": out["history_rows"],
            "demo_mode": registry.is_demo_mode(),
        },
        "results": [x.dict() for x in results],
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/analyze/single", response_model=Dict[str, Any])
def analyze_single(request: SingleTransactionRequest):
    """Analyze ONE transaction with a full SHAP explanation. Without account history the behavioural features are empty."""
    try:
        out = analyze_transactions([request.transaction], use_gnn=request.use_gnn, always_shap=True)
        return {
            "result": out["results"][0].dict(),
            "warning": "Single transaction scored WITHOUT account history: the model was trained on behavioural history features "
                       "(prior activity of sender/receiver). For reliable results upload a file / batch so history can be computed.",
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as e:
        logger.exception("Single analysis failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models/info")
async def model_info():
    info = {
        "demo_mode": registry.is_demo_mode(),
        "features": registry.feature_cols,
        "n_features": len(registry.feature_cols),
        "metadata": registry.metadata,
        "gnn_available": registry.is_gnn_available(),
    }
    if registry.is_gnn_available():
        info["gnn_metadata"] = {
            "architecture": "Edge-aware GNN (reverse message passing, port numbering, GINE-style layers, mean aggregation + LayerNorm)",
            "variant": registry.gnn_cfg["best_variant"], "hidden_dim": registry.gnn_cfg["hidden"], "n_layers": registry.gnn_cfg["layers"],
            "threshold": registry.gnn_threshold, "test_performance": registry.gnn_test_performance,
            "mode": "batch / period graph — optional network-analysis module, not the real-time scorer",
        }
    return info


@app.get("/models/gnn/status")
async def gnn_status():
    if not registry.is_gnn_available():
        return {"available": False, "torch_installed": TORCH_AVAILABLE,
                "reason": "No GNN package found at saved_models/deepguard_gnn_results/models (or it failed to load) — see AI Engine startup log."}
    return {
        "available": True,
        "architecture": "Edge-aware GNN (custom PyTorch — no torch_geometric required)",
        "variant": registry.gnn_cfg["best_variant"],
        "hidden_dim": registry.gnn_cfg["hidden"],
        "n_layers": registry.gnn_cfg["layers"],
        "threshold": registry.gnn_threshold,
        "edge_feature_count": registry.gnn_cfg["d_in"],
        "test_performance": registry.gnn_test_performance,
        "note": "Scores a whole batch graph (structure + features, never labels); an optional extra on top of the core detector.",
    }


@app.post("/analyze/gnn", response_model=Dict[str, Any])
def analyze_gnn(request: GnnAnalysisRequest):
    """Score a batch with ONLY the GNN (account graph of this batch + job context)."""
    if not registry.is_gnn_available():
        raise HTTPException(status_code=503, detail="GNN is not available — check GET /models/gnn/status")
    if len(request.transactions) == 0:
        raise HTTPException(status_code=400, detail="No transactions provided")
    if len(request.transactions) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f"Max {MAX_BATCH:,} transactions per GNN batch")
    start = time.time()
    try:
        out = analyze_transactions(request.transactions, use_gnn=True, gnn_only=True, job_id=request.job_id)
    except Exception as e:
        logger.exception("GNN analysis failed")
        raise HTTPException(status_code=500, detail=str(e))
    scores = out["gnn_scores"]
    if scores is None:
        raise HTTPException(status_code=500, detail="GNN scoring failed — see AI Engine log")
    thr = registry.gnn_threshold
    results = []
    for i, tx in enumerate(request.transactions):
        s = float(scores[i])
        flagged = s >= thr
        results.append({
            "transaction_id": tx.transaction_id or f"TX-{i + 1:05d}",
            "gnn_score": round(s * 100, 2),
            "is_fraud": flagged,
            "risk_level": "Critical" if flagged and s >= min(1.0, thr + (1 - thr) * 0.5) else ("High" if flagged else ("Medium" if s >= thr * 0.5 else "Low")),
        })
    flagged_n = sum(1 for x in results if x["is_fraud"])
    return {
        "job_id": request.job_id, "status": "completed",
        "model": "GNN (edge-aware, graph built from this batch + job context)", "threshold": thr,
        "note": "Optional research module. Its threshold was tuned on the full 5M-transaction graph; on a small batch the graph is sparse "
                "and scores are less reliable (expect more flags) — use it on larger uploads and as an investigation aid.",
        "summary": {"total_transactions": len(results), "flagged_count": flagged_n,
                    "flagging_rate_pct": round(flagged_n / max(len(results), 1) * 100, 2),
                    "processing_time_ms": round((time.time() - start) * 1000, 2)},
        "results": results, "timestamp": datetime.utcnow().isoformat(),
    }


# ─────────────────────────────────────────────
# FR-14: Manage AI Models (admin)
# ─────────────────────────────────────────────
class ModelConfigUpdate(BaseModel):
    ensemble_threshold: Optional[float] = Field(None, ge=0.0, le=1.0)
    ensemble_weights: Optional[Dict[str, float]] = None


@app.get("/models/config")
async def get_model_config():
    return {
        "ensemble_threshold": registry.ensemble_threshold,
        "default_threshold": getattr(registry, "default_threshold", registry.ensemble_threshold),
        "ensemble_weights": registry.ensemble_weights,
        "ae_threshold": None,
        "gnn_available": registry.is_gnn_available(),
        "operating_points": registry.metadata.get("operating_points", []),
        "model_performance": registry.metadata.get("model_performance", {}),
        "note": "Default = XGBoost probability with the validation-tuned threshold. Changing weights mixes the 0-1 display scores of the "
                "other models in; re-tune the threshold afterwards (see operating_points for precision/recall trade-offs).",
    }


@app.patch("/models/config")
async def update_model_config(update: ModelConfigUpdate):
    if registry.is_demo_mode():
        raise HTTPException(status_code=400, detail="Cannot update config in demo mode (no models loaded)")
    # Validate EVERYTHING first, then apply — a rejected request must not change anything.
    if update.ensemble_threshold is not None and not (0.0 <= update.ensemble_threshold <= 1.0):
        raise HTTPException(status_code=400, detail="ensemble_threshold must be between 0 and 1")
    if update.ensemble_weights is not None:
        allowed = {"xgboost", "autoencoder", "isolation_forest", "gnn"}
        unknown = set(update.ensemble_weights) - allowed
        if unknown:
            raise HTTPException(status_code=400, detail=f"unknown model(s) in ensemble_weights: {sorted(unknown)}; allowed: {sorted(allowed)}")
        if any(v < 0 for v in update.ensemble_weights.values()):
            raise HTTPException(status_code=400, detail="ensemble_weights must not be negative")
        total = sum(update.ensemble_weights.values())
        if abs(total - 1.0) > 0.01:
            raise HTTPException(status_code=400, detail=f"ensemble_weights must sum to 1.0 (got {total:.3f})")
    if update.ensemble_threshold is not None:
        registry.ensemble_threshold = update.ensemble_threshold
        registry.metadata["ensemble_threshold"] = update.ensemble_threshold
    if update.ensemble_weights is not None:
        registry.ensemble_weights = update.ensemble_weights
        registry.metadata["ensemble_weights"] = update.ensemble_weights
    try:
        with open(os.path.join(registry.base_dir, "engine_config.json"), "w") as f:
            json.dump({"ensemble_threshold": registry.ensemble_threshold, "ensemble_weights": registry.ensemble_weights}, f, indent=2)
    except Exception as e:
        logger.warning(f"Config updated in memory but failed to persist: {e}")
    logger.info(f"⚙️  Model config updated: threshold={registry.ensemble_threshold:.4f}, weights={registry.ensemble_weights}")
    return {"ensemble_threshold": registry.ensemble_threshold, "ensemble_weights": registry.ensemble_weights, "message": "Configuration updated"}