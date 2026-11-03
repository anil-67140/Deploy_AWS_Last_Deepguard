# DeepGuard AI Engine (FastAPI + PyTorch-CPU + XGBoost + scikit-learn)
# Build context = repository root.
# NOTE: the project pins xgboost==3.4.1, which only installs on Python >= 3.12 (3.11 fails).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# XGBoost needs the OpenMP runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch first (~200 MB instead of ~2.5 GB with CUDA); requirements.txt then sees torch as satisfied.
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu
COPY ai-engine/requirements.txt .
RUN pip install -r requirements.txt

# If torch cannot be imported the engine silently falls back to DEMO mode (random scores) -> fail the build instead.
RUN python -c "import torch, xgboost, sklearn, pandas, fastapi; print('torch', torch.__version__)"

COPY ai-engine/main.py ai-engine/features.py ./
COPY ai-engine/saved_models ./saved_models

# engine_config.json (admin threshold/weights) is written at runtime -> keep it OUT of the read-only model folder
RUN useradd --uid 10001 --create-home app \
 && mkdir -p /data/engine && chown -R app:app /data/engine
USER app

ENV MODEL_PATH=/data/engine \
    CORE_MODEL_DIR=/app/saved_models/deepguard_training_results/models \
    GNN_MODEL_DIR=/app/saved_models/deepguard_gnn_results/models

EXPOSE 8000
# unhealthy (so the backend never starts) if models failed to load and the engine fell back to demo mode
HEALTHCHECK --interval=15s --timeout=6s --start-period=90s --retries=5 \
  CMD ["python", "-c", "import urllib.request,json,sys; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5)); sys.exit(0 if d.get('status')=='healthy' and not d.get('demo_mode') else 1)"]

# single worker: the models + per-job context live in this process's memory
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
