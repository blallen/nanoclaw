#!/bin/bash
set -euo pipefail

# Test che-ical-mcp error handling before full migration
# This script runs on the host Mac Mini (not in container)

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="$PROJECT_ROOT/vendor/CheICalMCP"
SUPERGATEWAY="$PROJECT_ROOT/node_modules/supergateway/dist/index.js"
TEST_PORT=7892
TEST_PID=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[TEST]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

cleanup() {
    if [ -n "$TEST_PID" ] && kill -0 "$TEST_PID" 2>/dev/null; then
        log "Stopping test server (PID: $TEST_PID)..."
        kill "$TEST_PID"
        wait "$TEST_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT

# Step 1: Verify binary exists
log "Step 1: Verifying CheICalMCP binary..."
if [ ! -f "$BINARY" ]; then
    error "Binary not found at $BINARY"
    error "Run: curl -L https://github.com/kiki830621/che-ical-mcp/releases/download/v1.1.0/CheICalMCP -o $BINARY && chmod +x $BINARY"
    exit 1
fi

if [ ! -x "$BINARY" ]; then
    error "Binary not executable. Run: chmod +x $BINARY"
    exit 1
fi

log "Binary found and executable ✓"

# Step 2: Start test server
log "Step 2: Starting test server on port $TEST_PORT..."
node "$SUPERGATEWAY" --stdio "$BINARY" --port "$TEST_PORT" --outputTransport streamableHttp &
TEST_PID=$!

log "Started supergateway (PID: $TEST_PID)"
sleep 3

# Check if process is still running
if ! kill -0 "$TEST_PID" 2>/dev/null; then
    error "Test server failed to start"
    exit 1
fi

log "Test server running ✓"

# Step 3: Test basic connectivity
log "Step 3: Testing basic connectivity (list_calendars)..."
RESPONSE=$(curl -s --max-time 10 "http://localhost:$TEST_PORT/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_calendars","arguments":{}}}' 2>&1)

if echo "$RESPONSE" | grep -q "error"; then
    warn "Error in response (might be TCC permissions):"
    echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
    warn "Please check System Settings → Privacy & Security → Calendars"
    warn "Grant permission to CheICalMCP and run this script again"
    exit 1
elif echo "$RESPONSE" | grep -q "result"; then
    log "Connectivity test passed ✓"
else
    warn "Unexpected response:"
    echo "$RESPONSE"
fi

# Step 4: Test invalid day-of-week (Saturday 2026-03-08 is actually Sunday)
log "Step 4: Testing invalid day-of-week (Saturday 2026-03-08, actually Sunday)..."

CREATE_RESPONSE=$(curl -s --max-time 10 "http://localhost:$TEST_PORT/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{
        "jsonrpc":"2.0",
        "id":2,
        "method":"tools/call",
        "params":{
            "name":"create_event",
            "arguments":{
                "title":"TEST: Wrong Day-of-Week",
                "start_time":"2026-03-08T14:00:00-05:00",
                "end_time":"2026-03-08T15:00:00-05:00",
                "calendar_name":"Home"
            }
        }
    }' 2>&1)

echo "Create response:"
echo "$CREATE_RESPONSE" | jq '.' 2>/dev/null || echo "$CREATE_RESPONSE"

# Step 5: Verify if event was created
log "Step 5: Searching for the test event..."

SEARCH_RESPONSE=$(curl -s --max-time 10 "http://localhost:$TEST_PORT/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{
        "jsonrpc":"2.0",
        "id":3,
        "method":"tools/call",
        "params":{
            "name":"list_events",
            "arguments":{
                "start_date":"2026-03-08",
                "end_date":"2026-03-08"
            }
        }
    }' 2>&1)

echo "Search response:"
echo "$SEARCH_RESPONSE" | jq '.' 2>/dev/null || echo "$SEARCH_RESPONSE"

# Step 6: Test valid event (Tuesday 2026-03-10)
log "Step 6: Testing valid event (Tuesday 2026-03-10)..."

VALID_CREATE=$(curl -s --max-time 10 "http://localhost:$TEST_PORT/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{
        "jsonrpc":"2.0",
        "id":4,
        "method":"tools/call",
        "params":{
            "name":"create_event",
            "arguments":{
                "title":"TEST: Valid Event",
                "start_time":"2026-03-10T10:00:00-05:00",
                "end_time":"2026-03-10T11:00:00-05:00",
                "calendar_name":"Home"
            }
        }
    }' 2>&1)

echo "Valid event creation response:"
echo "$VALID_CREATE" | jq '.' 2>/dev/null || echo "$VALID_CREATE"

# Step 7: Verify valid event
log "Step 7: Verifying valid event..."

VALID_SEARCH=$(curl -s --max-time 10 "http://localhost:$TEST_PORT/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{
        "jsonrpc":"2.0",
        "id":5,
        "method":"tools/call",
        "params":{
            "name":"list_events",
            "arguments":{
                "start_date":"2026-03-10",
                "end_date":"2026-03-10"
            }
        }
    }' 2>&1)

echo "Valid event search response:"
echo "$VALID_SEARCH" | jq '.' 2>/dev/null || echo "$VALID_SEARCH"

# Analysis
log "============================================"
log "TEST COMPLETE"
log "============================================"
echo ""
echo "ANALYSIS:"
echo "1. Check if CREATE_RESPONSE for wrong day-of-week returned success or error"
echo "2. Check if SEARCH_RESPONSE shows the event exists (false success) or not"
echo "3. Compare with valid event behavior"
echo ""
echo "Good behaviors:"
echo "  - Error returned for invalid day-of-week"
echo "  - OR: Event created successfully on the specified date (2026-03-08)"
echo "  - OR: Event corrected to actual Saturday (2026-03-07)"
echo ""
echo "Bad behavior:"
echo "  - Success message but event doesn't exist (same bug as mcp-server-apple-events)"
echo ""
log "Review the responses above and document findings in:"
log "  groups/main/plans/2026-03-06-test-results.md"
