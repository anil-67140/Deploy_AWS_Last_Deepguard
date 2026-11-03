#!/bin/bash
# DeepGuard AI Engine — Startup Script
# Models live in saved_models/deepguard_training_results/ (core) and saved_models/deepguard_gnn_results/ (optional GNN)

echo "🛡️  DeepGuard AI Engine"
echo "================================"

# Check Python
python3 --version || { echo "❌ Python 3 required"; exit 1; }

# Create virtualenv if not exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

# Install dependencies
echo "📦 Installing dependencies..."
pip install -r requirements.txt -q

# Check saved_models (new layout produced by the two training notebooks)
if [ ! -f "saved_models/deepguard_training_results/models/xgboost_final.json" ]; then
    echo ""
    echo "⚠️  WARNING: trained models not found in saved_models/deepguard_training_results/models/"
    echo "   The AI engine will run in DEMO MODE with random predictions."
    echo "   To use the real models:"
    echo "   1. Run notebooks/DeepGuard_Training_Final.ipynb in Colab (T4 GPU)"
    echo "   2. Unzip DeepGuard_Training_Results.zip into saved_models/deepguard_training_results/"
    echo "   3. (optional) run notebooks/DeepGuard_GNN_Extra_Final.ipynb -> saved_models/deepguard_gnn_results/"
    echo ""
    mkdir -p saved_models
fi

# Copy .env if not exists
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "📝 Created .env from .env.example — please edit it"
fi

echo ""
echo "🚀 Starting FastAPI server on http://localhost:8000"
echo "📖 API docs: http://localhost:8000/docs"
echo ""

uvicorn main:app --reload --host 0.0.0.0 --port 8000
