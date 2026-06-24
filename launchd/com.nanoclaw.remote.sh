#!/bin/bash
# Launches the isolated "Taskie" Remote Control endpoint.
# Sources .env for CLAUDE_CODE_OAUTH_TOKEN so the token never lives in a plist.
set -euo pipefail
PROJECT_ROOT="/Users/ballen/Projects/nanoclaw"
cd "$PROJECT_ROOT/groups/main"
set -a
# shellcheck disable=SC1091
source "$PROJECT_ROOT/.env"
set +a
export CLAUDE_CONFIG_DIR="$PROJECT_ROOT/data/sessions/main/.claude"
# NANOCLAW_* context so the nanoclaw MCP (send_message etc.) targets the main group
export NANOCLAW_GROUP_FOLDER="main"
export NANOCLAW_IS_MAIN="1"
export NANOCLAW_IPC_DIR="$PROJECT_ROOT/data/ipc/main"
# NANOCLAW_CHAT_JID is the main Telegram chat JID — set it so send_message from the
# phone routes to the right chat. (The user must fill this in; see MY-SETUP.)
export NANOCLAW_CHAT_JID="${NANOCLAW_CHAT_JID:-}"
exec /Users/ballen/.local/bin/claude remote-control --name Taskie
