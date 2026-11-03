#!/bin/bash
# DeepGuard Frontend — Startup Script

echo "🛡️  DeepGuard Frontend"
echo "================================"

node --version || { echo "❌ Node.js 18+ required"; exit 1; }

echo "📦 Installing dependencies..."
npm install

if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "📝 Created .env — fill in your Supabase anon key"
fi

echo ""
echo "🚀 Starting React dev server on http://localhost:5173"
echo ""

npm run dev
