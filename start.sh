#!/bin/bash

echo ""
echo "╔════════════════════════════════════════╗"
echo "║        SwarmVault — Clean Start        ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Step 1: Kill any leftover node processes
echo "⏹  Stopping any running servers..."
killall node 2>/dev/null
sleep 1

# Step 2: Kill anything using ports 5173 and 10001
lsof -ti:5173 | xargs kill -9 2>/dev/null
lsof -ti:10001 | xargs kill -9 2>/dev/null
lsof -ti:10000 | xargs kill -9 2>/dev/null
sleep 1

echo "✅ All ports cleared."
echo ""
echo "🚀 Starting SwarmVault..."
echo ""

# Step 3: Start the app
npm run dev
