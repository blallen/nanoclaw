# MCP Server Registry: Agent-Managed MCP Services

**Date:** 2026-03-06
**Status:** Approved

## Problem

NanoClaw agents run in containers and cannot modify, fix, or extend the MCP services that provide their tools. When the apple-events MCP server silently failed on calendar creation (`groups/metzger-allen/mcp-calendar-silent-failure-issue.md`), the agent had no way to patch the bug. When a better MCP server exists (`docs/plans/2026-02-20-che-ical-mcp-migration-design.md`), the agent can't swap it in. And when the agent needs a new capability (Feedly, Instapaper, Obsidian, Notes), it can't add an MCP server to give itself new tools.

## Solution

Replace the single `McpBridge` with a **multi-port bridge manager** backed by an agent-editable registry of MCP servers. Each server gets its own supergateway instance (for stdio servers) or passthrough URL (for HTTP servers). Agents manage the registry through IPC tools and can edit server code directly in `mcp-servers/`.

## Architecture

```
mcp-servers/                              # Agent-editable directory
  registry.json                           # Declares all servers
  apple-events/                           # Server code (wrapper or custom)
    index.ts
  feedly/                                 # Future: added by agent
    index.ts

src/mcp-bridge-manager.ts                 # Replaces mcp-bridge.ts
  |- supergateway :7891 -> mcp-servers/apple-events/
  |- supergateway :7892 -> mcp-servers/feedly/
  |- (passthrough)      -> http://localhost:3000/mcp
  '- file watcher on mcp-servers/ (auto-restarts affected bridge)

Container (Linux VM)
  '- Claude Agent SDK
       |- mcp-remote http://host:7891/mcp   # apple-events
       |- mcp-remote http://host:7892/mcp   # feedly
       '- ...
```

## Registry Format

`mcp-servers/registry.json`:

```json
{
  "servers": {
    "apple-events": {
      "transport": "stdio",
      "command": "node",
      "args": ["mcp-servers/apple-events/dist/index.js"],
      "port": 7891,
      "enabled": true
    },
    "feedly": {
      "transport": "stdio",
      "command": "node",
      "args": ["mcp-servers/feedly/dist/index.js"],
      "port": 7892,
      "enabled": true
    },
    "some-saas-tool": {
      "transport": "http",
      "url": "http://localhost:3000/mcp",
      "enabled": true
    }
  }
}
```

- **`transport`** — `stdio` (wrapped with supergateway) or `http` (passthrough, no child process).
- **`command` + `args`** — how to launch stdio servers. Agnostic to source: node script, vendored binary, npx, whatever.
- **`port`** — each stdio server gets its own supergateway port. Explicit, not auto-assigned, so container config stays stable.
- **`url`** — for http servers, the existing endpoint. No supergateway needed.
- **`enabled`** — agent can disable a server without removing it.
- Paths are relative to project root.

## Bridge Manager

`src/mcp-bridge-manager.ts` replaces `src/mcp-bridge.ts`.

```
class McpBridgeManager {
  bridges: Map<string, { proc, config }>

  start()                 // Read registry, spawn all enabled servers
  stopServer(name)        // Stop one server's bridge
  startServer(name)       // Start one server's bridge
  restartServer(name)     // Restart one server's bridge
  stopAll()               // Clean shutdown
  listServers()           // Status: name, port, enabled, running
}
```

Each stdio server gets its own supergateway process. Same pattern as current `McpBridge`: spawn, pipe stdout/stderr to logger, auto-restart on unexpected exit with exponential backoff. HTTP servers have no child process — the manager just tracks their URL.

**File watcher:** The manager watches `mcp-servers/` using `fs.watch`. When files change in a server's directory, it restarts just that server's bridge after a short debounce (~500ms). Agent edits code, change takes effect within a second.

**Registry changes:** When `registry.json` itself changes, the manager diffs against current state — starts new servers, stops removed ones, restarts changed ones.

## Container Integration

The bridge manager writes an `mcp_servers.json` snapshot to each group's IPC directory (same pattern as `current_tasks.json` and `available_groups.json`):

```json
{
  "servers": {
    "apple-events": { "url": "http://192.168.64.1:7891/mcp" },
    "feedly": { "url": "http://192.168.64.1:7892/mcp" },
    "some-saas": { "url": "http://localhost:3000/mcp" }
  }
}
```

The agent runner inside the container reads this file and configures an `mcp-remote` connection for each server, replacing the current hardcoded single-server setup.

## IPC Commands

New tools in `ipc-mcp-stdio.ts`, the primary interface for agents to manage MCP servers:

- **`list_mcp_servers`** — returns registered servers with status (running/stopped/enabled/disabled).
- **`add_mcp_server`** — register and start a new server. Auto-assigns port (next available). Validates for conflicts.
- **`remove_mcp_server`** — stop and unregister a server.
- **`restart_mcp_server`** — restart a specific server's bridge (after agent edits its code).
- **`restart_all_mcp_servers`** — full reconciliation: re-read registry, start/stop/restart as needed.

Direct editing of `registry.json` is the escape hatch if IPC commands are insufficient.

## Migration

The current apple-events setup moves into the new structure with no functional change:

1. Create `mcp-servers/apple-events/` — wrap current `mcp-server-apple-events` launch config.
2. Create `mcp-servers/registry.json` — apple-events as sole initial entry.
3. Replace `src/mcp-bridge.ts` with `src/mcp-bridge-manager.ts`.
4. Update `src/container-runner.ts` — write `mcp_servers.json` snapshot instead of single host/port env vars.
5. Update agent runner — read snapshot, configure multiple mcp-remote connections dynamically.
6. Add IPC commands to `ipc-mcp-stdio.ts`.
7. Update `src/index.ts` — swap `McpBridge` for `McpBridgeManager`.

Apple-events keeps working throughout. No functional change until the agent starts using the new management tools.

## What Stays the Same

- supergateway as the stdio-to-HTTP adapter
- Streamable HTTP transport (`/mcp` endpoint)
- `mcp-remote` in container with `--allow-http`
- Host gateway IP discovery in `container-runner.ts`
- Container isolation model

## Trade-offs

- **One supergateway per server** — more processes, but failure isolation (one server crashing doesn't take down others). Resource cost is minimal for the expected number of servers (< 10).
- **Explicit ports** — agents/IPC must pick ports. Auto-assignment via `add_mcp_server` handles the common case; direct registry edits need manual port selection.
- **File watcher restarts** — a file save during active tool use could briefly disrupt that server. The debounce mitigates rapid saves; exponential backoff handles the restart.
