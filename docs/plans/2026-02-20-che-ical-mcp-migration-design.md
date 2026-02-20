# Apple MCP Bridge: Migrate to che-ical-mcp

**Date:** 2026-02-20
**Status:** Approved

## Problem

The current bridge uses `mcp-server-apple-events`, which has two significant issues:

**A. Fragility** — Four-process chain: NanoClaw → supergateway → mcp-server-apple-events → EventKitCLI (Swift binary). During setup we hit six distinct failure modes: PATH resolution under launchd, child shebang failures, mcp-remote HTTP rejection, SSE double-connection crash (supergateway bug), missing Swift binary (no postinstall step in the npm package), and TCC permission surfacing. The Swift binary must be manually compiled after every `npm install` because the package has no `postinstall` hook.

**B. Maintenance** — Tool names and API shape are owned by the `mcp-server-apple-events` package. They changed silently between versions (the initial design doc had entirely wrong tool names). Any upstream change requires us to discover the breakage, diagnose it, and update `groups/main/CLAUDE.md`.

## Solution

Replace `mcp-server-apple-events` with `che-ical-mcp` (GitHub: `kiki830621/che-ical-mcp`), a native Swift MCP server that ships precompiled binaries via GitHub Releases. Pin the binary to a specific release in git (`vendor/CheICalMCP`). No Swift compilation, no npm package, no postinstall step.

## Architecture

```
NanoClaw (host macOS)
  └── McpBridge
        └── supergateway --stdio vendor/CheICalMCP --outputTransport streamableHttp --port 7891
              └── CheICalMCP (precompiled Swift binary, accesses EventKit)

Container (Linux VM)
  └── Claude Agent SDK
        └── apple-events MCP server
              └── mcp-remote http://192.168.64.1:7891/mcp --allow-http
```

Three levels instead of four. `supergateway` remains as the stdio→HTTP adapter since `CheICalMCP` is stdio-only. Everything else (port, transport, mcp-remote, container env vars, allowedTools wildcard) is unchanged.

## Components

### `vendor/CheICalMCP` (new)

Precompiled universal macOS binary downloaded from:
```
https://github.com/kiki830621/che-ical-mcp/releases/download/v1.1.0/CheICalMCP
```

Committed to git at `vendor/CheICalMCP`, executable bit set. Version pinned by the download URL — updating requires a deliberate decision: download new binary, test, commit.

### `src/mcp-bridge.ts` (update)

Change `--stdio` argument from `${process.execPath} ${mcpServerAppleEventsScript}` to the absolute path of the vendored binary (`join(process.cwd(), 'vendor', 'CheICalMCP')`).

Remove the `mcpServerAppleEventsScript` constant and the comment about manual Swift compilation.

### `package.json` (update)

Remove `mcp-server-apple-events` dependency. `supergateway` stays.

### `groups/main/CLAUDE.md` (update)

Replace tool documentation with `che-ical-mcp`'s actual 24 tools:

**Reminders:** `list_reminders`, `create_reminder`, `update_reminder`, `complete_reminder`, `delete_reminder`, `search_reminders`, `create_reminders_batch`, `delete_reminders_batch`

**Calendar events:** `list_events`, `create_event`, `update_event`, `delete_event`, `search_events`, `list_events_quick`, `create_events_batch`, `move_events_batch`, `delete_events_batch`, `copy_event`, `check_conflicts`, `find_duplicate_events`

**Calendars:** `list_calendars`, `create_calendar`, `update_calendar`, `delete_calendar`

### TCC permissions (one-time)

`CheICalMCP` is a new binary — macOS will prompt for Reminders and Calendar access on first tool call. Trigger via `curl` to the bridge endpoint (same process used during initial setup). Old `EventKitCLI` permissions do not transfer.

## Pinning Strategy

The binary is committed to `vendor/CheICalMCP` at a specific release. Updating is explicit:

```bash
curl -L https://github.com/kiki830621/che-ical-mcp/releases/download/vX.Y.Z/CheICalMCP \
  -o vendor/CheICalMCP
chmod +x vendor/CheICalMCP
# Test: curl to bridge, verify tool calls work
# Update groups/main/CLAUDE.md if tool names changed
git add vendor/CheICalMCP
git commit -m "chore: update CheICalMCP to vX.Y.Z"
```

No network access required at runtime or install time.

## What Stays the Same

- `McpBridge` class structure, restart logic, port 7891
- supergateway, Streamable HTTP transport
- `mcp-remote` in container agent, `--allow-http` flag
- `NANOCLAW_MCP_HOST` / `NANOCLAW_MCP_PORT` env vars
- `mcp__apple-events__*` wildcard in `allowedTools`
- Host gateway IP discovery in `container-runner.ts`

## Trade-offs

- **Binary in git:** 6.9 MB commit. Acceptable for a vendored dependency with infrequent updates.
- **No automatic updates:** Intentional. Updates require testing. Changelog review before upgrading is low-friction.
- **New TCC grant required:** One-time, same procedure as initial setup.
