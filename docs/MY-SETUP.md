# My NanoClaw Setup (Taskie)

Context for future Claude Code sessions on this fork. Covers what was customized, why, and what's in-progress.

---

## Identity

- **Assistant name:** Taskie (`@Taskie`)
- **Primary channel:** Telegram (replaced WhatsApp)
- **Host:** Mac Mini (Apple silicon)

---

## Channels

### Telegram (primary)

Added via the `/add-telegram` skill. Taskie has its own Telegram bot token. The channel handles both the inbound trigger (`@Taskie`) and outbound responses.

WhatsApp was never used in production — Telegram was set up directly as the primary channel.

---

## Apple MCP Bridge

Goal: give the container agent (Taskie) read/write access to Apple Reminders and Calendar.

### Architecture

```
NanoClaw (host macOS)
  └── McpBridge (src/mcp-bridge.ts)
        └── supergateway --stdio <mcp-server> --outputTransport streamableHttp --port 7891
              └── MCP server (accesses EventKit via macOS APIs)

Container (Linux VM)
  └── Claude Agent SDK
        └── apple-events MCP server
              └── mcp-remote http://192.168.64.1:7891/mcp --allow-http
```

The host spawns supergateway as a child process to bridge a stdio MCP server to HTTP. The container connects via `mcp-remote` using the host gateway IP (`192.168.64.1` on Apple Container's default network). Port 7891. Transport: Streamable HTTP (`/mcp` endpoint, not `/sse`).

### Current State: mcp-server-apple-events (fragile)

`mcp-server-apple-events` (npm package) wraps a Swift CLI binary `EventKitCLI` that calls the macOS EventKit APIs. **It works but is fragile.** Tool names: `reminders_tasks`, `reminders_lists`, `calendar_events`, `calendar_calendars`.

Six failure modes were hit and fixed during setup:

| Failure | Cause | Fix |
|---------|-------|-----|
| Exit 127 on `npx` | launchd PATH doesn't include Homebrew node | Use full node binary path |
| Child shebang `env: node: No such file or directory` | supergateway spawns mcp-server-apple-events; child uses `#!/usr/bin/env node` but can't find node under launchd PATH | Pass `env: { PATH: nodeDir + ':...' }` to spawn |
| mcp-remote HTTP rejection | mcp-remote refuses non-HTTPS URLs for non-localhost hosts | Add `--allow-http` flag |
| SSE double-connection crash (`Already connected`) | mcp-remote probes Streamable HTTP first (POST → 404), falls back to SSE; two connections arrive before the first closes; supergateway SSE transport only handles one | Switch to `--outputTransport streamableHttp` and use `/mcp` URL instead of `/sse` |
| `System error occurred` on every tool call | `EventKitCLI` Swift binary doesn't exist; mcp-server-apple-events has no postinstall step | Install as project dep (`npm install --ignore-scripts`), build binary manually: `cd node_modules/mcp-server-apple-events && node scripts/build-swift.mjs` |
| TCC permissions never prompted | EventKitCLI ran under launchd but dialog didn't appear from Claude Code subprocess | Trigger via curl to the live bridge endpoint (runs in GUI session): `curl http://localhost:7891/mcp ...` |

### Planned Migration: che-ical-mcp

Design doc: `docs/plans/2026-02-20-che-ical-mcp-migration-design.md`
Implementation plan: `docs/plans/2026-02-20-che-ical-mcp-migration.md`

Replace `mcp-server-apple-events` with `che-ical-mcp` — a native Swift MCP server that ships **precompiled binaries** via GitHub Releases. No Swift compilation, no npm package, no postinstall step.

The binary is vendored at `vendor/CheICalMCP` (pinned to a specific release). `mcp-bridge.ts` passes it directly as the `--stdio` argument to supergateway. Everything else (port, transport, mcp-remote, container config) stays the same.

**Why not migrate immediately:** Working setup exists; want to use it as-is for a while before another round of TCC permission prompts and testing. The plan is ready when we want to execute.

**che-ical-mcp tool names** (24 tools, different from current):
- Reminders: `list_reminders`, `create_reminder`, `update_reminder`, `complete_reminder`, `delete_reminder`, `search_reminders`, `create_reminders_batch`, `delete_reminders_batch`
- Calendar events: `list_events`, `create_event`, `update_event`, `delete_event`, `search_events`, `list_events_quick`, `create_events_batch`, `move_events_batch`, `delete_events_batch`, `copy_event`, `check_conflicts`, `find_duplicate_events`
- Calendars: `list_calendars`, `create_calendar`, `update_calendar`, `delete_calendar`

---

## Key Files (fork-specific)

| File | What's custom |
|------|---------------|
| `src/mcp-bridge.ts` | Runs supergateway + mcp-server-apple-events for Apple Reminders/Calendar |
| `src/channels/telegram.ts` | Telegram channel (added via skill) |
| `groups/main/CLAUDE.md` | Taskie's persona + apple-events tool documentation |
| `vendor/` | (planned) Will hold vendored `CheICalMCP` binary |
| `docs/plans/` | Design docs and implementation plans for features |

---

## Notes for Future Sessions

- **npm with mcp-server-apple-events:** Always use `--ignore-scripts` (`npm install --ignore-scripts`) — the package has a pnpm-based build that errors out otherwise.
- **TypeScript compilation:** Use `node_modules/.bin/tsc -p tsconfig.json`, not `npx tsc` — the latter can pick up tsconfigs from node_modules packages.
- **Commits:** This repo uses `jj` (Jujutsu), not git directly. `jj describe -m "..."` sets the message, `jj new` creates a new change, `jj bookmark set main -r @-` moves the main bookmark before pushing.
- **Service restart:** `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` restarts the service. Check `tail -f logs/nanoclaw.log` to verify.
- **TCC permissions:** Any new binary that accesses EventKit (Reminders/Calendar) will trigger a macOS permission dialog. Must be triggered via the live bridge (`curl` to port 7891), not directly from a terminal subprocess — the dialog only surfaces in the GUI session.
