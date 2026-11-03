#!/bin/bash
# DeepGuard — Master Startup Script
# Starts all 3 services in separate terminals

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🛡️  DeepGuard — Full Stack Launcher     ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "This will start:"
echo "  • AI Engine  (FastAPI)   → http://localhost:8000"
echo "  • Backend    (Node.js)   → http://localhost:4000"
echo "  • Frontend   (React)     → http://localhost:5173"
echo ""

# ── Check prerequisites ──
check_cmd() {
    command -v "$1" &>/dev/null || { echo "❌ $1 not found. Please install it."; exit 1; }
}
check_cmd python3
check_cmd node
check_cmd npm

# ── Check .env files ──
for dir in ai-engine backend-node frontend; do
    if [ ! -f "$dir/.env" ] && [ -f "$dir/.env.example" ]; then
        cp "$dir/.env.example" "$dir/.env"
        echo "📝 Created $dir/.env — please edit with your credentials"
    fi
done

echo ""
echo "⚠️  BEFORE STARTING — Make sure you have:"
echo "  1. MongoDB running locally (or set MONGODB_URI in backend-node/.env)"
echo "  2. Supabase project created (free at supabase.com)"
echo "     → Fill SUPABASE_URL and SUPABASE_SERVICE_KEY in backend-node/.env"
echo "     → Fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env"
echo "  3. (Optional) Groq API key for free AI report generation"
echo "     → Get at console.groq.com (free, no credit card)"
echo ""
read -p "Press ENTER to start all services (Ctrl+C to cancel)..."

# ── Launch in background with logs ──
mkdir -p logs

echo ""
echo "🚀 Starting AI Engine..."
(cd ai-engine && bash start.sh > ../logs/ai-engine.log 2>&1) &
AI_PID=$!
sleep 3

echo "🚀 Starting Node.js Backend..."
(cd backend-node && bash start.sh > ../logs/backend.log 2>&1) &
NODE_PID=$!
sleep 2

echo "🚀 Starting React Frontend..."
(cd frontend && bash start.sh > ../logs/frontend.log 2>&1) &
REACT_PID=$!

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ All services starting...              ║"
echo "╠══════════════════════════════════════════╣"
echo "║  🤖 AI Engine  → http://localhost:8000   ║"
echo "║  ⚙️  Backend   → http://localhost:4000   ║"
echo "║  🌐 Frontend   → http://localhost:5173   ║"
echo "╠══════════════════════════════════════════╣"
echo "║  📁 Logs in ./logs/                       ║"
echo "║  Press Ctrl+C to stop all services       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Wait and trap Ctrl+C ──
trap "echo ''; echo '🛑 Stopping all services...'; kill $AI_PID $NODE_PID $REACT_PID 2>/dev/null; exit 0" INT

wait
