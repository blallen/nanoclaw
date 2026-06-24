# Task 0 spike — claude CLI ground truth (v2.1.190)

Scratch notes from the spike. Deleted in the final cleanup task once folded into the plan.

## Verified flags
- Print/headless: `-p` / `--print`.
- `--output-format stream-json` (requires `--verbose` for full streaming).
- `--input-format stream-json` (for streaming multiple user messages in; works with `--print` + `--output-format stream-json`).
- `-r` / `--resume [sessionId]`.
- `--permission-mode <mode>`: `bypassPermissions`, `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`. Use **`bypassPermissions`** for the unattended Telegram/scheduler path.
- `--dangerously-skip-permissions` also exists; help says "Recommended only for sandboxes with no internet access" — we are on host with internet, so prefer `--permission-mode bypassPermissions`.
- `--strict-mcp-config` (load ONLY the MCP servers we pass, ignore ambient) — use to be safe.

## Remote Control — CONFIRMED real
- `claude remote-control [options]`: control local sessions from claude.ai/code or the Claude mobile app.
- Options: `--name <name>` (shown in the app), `--permission-mode`, `--spawn <same-dir|worktree|session>` (default `same-dir`), `--capacity <N>`, `--debug-file`.
- Run it in the directory you want to work in, then connect from phone/browser.

## stream-json event shapes (use as Task 2 fixtures)
- Init: `{"type":"system","subtype":"init","session_id":"<id>","cwd":...,"model":"claude-opus-4-8[1m]","mcp_servers":[...],"slash_commands":[...],"permissionMode":"bypassPermissions", ...}` — **session_id is here.**
- Assistant text: `{"type":"assistant","message":{"content":[{"type":"text","text":"HELLO"}], ...},"session_id":"<id>"}`.
- Terminal: `{"type":"result","subtype":"success","is_error":false,"result":"HELLO","session_id":"<id>","total_cost_usd":...}` — **result carries the full final text.**
- Other event types seen (ignore): `system/hook_started`, `system/hook_response`, `rate_limit_event`, `system/post_turn_summary`.

## Resume behavior
- `claude -p "..." --resume <id>` reuses the **SAME** session_id and correctly recalls prior context. So `db.ts` can keep storing one id per group; capture the id from `init`/`result` each turn (it stays stable).

## CRITICAL: config isolation (decided — fully isolated)
Running `claude` in `groups/main` with the default config inherited the USER's personal `~/.claude`:
- superpowers `SessionStart` hook injected "you have superpowers, you MUST invoke skills" into Taskie's context.
- personal claude.ai MCP servers loaded (Gmail, Google Drive, Calendar).
- personal auto-memory + plugins; model `claude-opus-4-8[1m]` (1M ctx) → **$0.11 for a one-word reply** (~28k injected tokens).

**Fix (verified):** set a dedicated **`CLAUDE_CONFIG_DIR`** → init showed `mcp_servers: []`, `plugins: []`, no superpowers hook. BUT a fresh config dir is **not logged in** ("Not logged in · Please run /login") — credentials live in the config dir, not the macOS keychain.

**Decision:** Both Taskie processes (Telegram headless runner + the "Taskie" Remote Control endpoint) run with `CLAUDE_CONFIG_DIR` pointed at a dedicated Taskie config dir. Reuse the existing per-group path **`data/sessions/main/.claude`** (already created/populated by `container-runner.ts:buildVolumeMounts`). Authenticate it once (one-time `CLAUDE_CONFIG_DIR=<dir> claude setup-token`/login, or pass `CLAUDE_CODE_OAUTH_TOKEN` from `.env`). Project-level `groups/main/.claude/` + `groups/main/.mcp.json` still load (cwd-based) and carry Taskie's hooks/MCP/skills. The user's personal Claude Code is unaffected — it uses the default `~/.claude`.
