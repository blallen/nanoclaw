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
# Generate the project-level .mcp.json so claude (cwd = groups/main) auto-loads the
# host nanoclaw MCP server. The host runner (writeMcpConfig) does this at startup,
# but Remote Control runs independently — without this, a clean checkout (or a boot
# before the first Telegram message) would start the phone Taskie WITHOUT nanoclaw
# tools (send_message etc.). Reuse writeMcpConfig (single source of truth) rather
# than duplicating its JSON here. It derives BOTH the output path and the bundled
# server path from process.cwd(), so it MUST run with cwd = project root — hence the
# subshell `cd "$PROJECT_ROOT"` (the outer shell stays in groups/main for `exec`).
# Invoking via $NODE makes the generated `command` field (process.execPath) match.
# No `env` block is written: the stdio MCP inherits the NANOCLAW_* vars exported above.
NODE="/opt/homebrew/opt/node@22/bin/node"
( cd "$PROJECT_ROOT" && "$NODE" -e "import('$PROJECT_ROOT/dist/host-claude-runner.js').then((m) => m.writeMcpConfig('main'))" )
# --add-dir grants the phone Taskie tool access to the whole project root (SQLite DB,
# group folders, global memory) — mirrors the host runner's reach.
exec /Users/ballen/.local/bin/claude remote-control --name Taskie --add-dir "$PROJECT_ROOT"
