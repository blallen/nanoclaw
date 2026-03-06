#!/bin/bash
# Quick script to discover che-ical-mcp's tool schemas

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="$PROJECT_ROOT/vendor/CheICalMCP"
SUPERGATEWAY="$PROJECT_ROOT/node_modules/supergateway/dist/index.js"
TEST_PORT=7892

# Start server
node "$SUPERGATEWAY" --stdio "$BINARY" --port "$TEST_PORT" --outputTransport streamableHttp &
PID=$!
sleep 3

# List available tools
echo "=== Listing available tools ==="
curl -s "http://localhost:$TEST_PORT/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.'

# Cleanup
kill $PID 2>/dev/null
