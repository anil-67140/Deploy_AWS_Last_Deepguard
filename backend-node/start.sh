#!/bin/bash
# DeepGuard Node.js Backend — Startup Script

echo "🛡️  DeepGuard Node.js Backend"
echo "================================"

# Check node
node --version || { echo "❌ Node.js 18+ required"; exit 1; }
npm --version  || { echo "❌ npm required"; exit 1; }

# Install
echo "📦 Installing dependencies..."
npm install

# Copy .env
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "📝 Created .env — IMPORTANT: fill in SUPABASE_URL and SUPABASE_SERVICE_KEY"
fi

# Create uploads/reports dirs
mkdir -p uploads reports

echo ""
echo "🚀 Starting Node.js server on http://localhost:4000"
echo ""

npm run dev
