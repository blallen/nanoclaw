# Apple Reminders & Calendar MCP Bridge

**Date:** 2026-02-20
**Status:** Approved

## Problem

The NanoClaw agent runs inside a Linux container (Apple Container VM). MCP servers that use macOS APIs — specifically `mcp-server-apple-events` for Reminders and Calendar — cannot run inside the container. They must run on the host Mac and be bridged in.

## Solution

Run `mcp-server-apple-events` on the host Mac, wrapped with an HTTP/SSE transport via `supergateway`. NanoClaw manages the process lifecycle. The container agent connects using `mcp-remote`.

## Architecture

```
NanoClaw (host macOS)
  ├── TelegramChannel (existing)
  ├── McpBridge (new)
  │    └── spawns: supergateway --stdio "npx -y mcp-server-apple-events" --port 7891
  └── runContainerAgent()
        └── container run ... -e NANOCLAW_MCP_HOST=<host-gateway-ip>
              └── Claude Agent SDK (inside Linux VM)
                    ├── nanoclaw MCP server (existing IPC)
                    └── apple-events MCP server (new)
                          └── mcp-remote → McpBridge → macOS APIs
```

`supergateway` is the standard npm tool for wrapping stdio MCP servers as HTTP/SSE. Using `npx -y` means the container always benefits from upstream improvements to `mcp-server-apple-events` without any rebuild.

## Components

### `src/mcp-bridge.ts` (new)

Manages the `supergateway` subprocess:
- Spawns on `start()`, kills on `stop()`
- Logs stdout/stderr via the existing `logger`
- Restarts automatically on unexpected exit (with backoff)
- Exposes `isRunning()` for health checks

### `src/config.ts` (update)

Add:
- `MCP_BRIDGE_PORT` — default `7891`, overridable via `.env`
- `MCP_BRIDGE_ENABLED` — default `true`, set to `false` to disable

### `src/index.ts` (update)

- Instantiate and start `McpBridge` before connecting channels
- Stop it in the shutdown handler alongside channels

### `src/container-runner.ts` (update)

At startup, discover the host gateway IP by running:
```
container run --rm alpine ip route show default
```
Parse the gateway from the output (e.g. `default via 192.168.64.1 dev eth0`). Cache the result. Fall back to `MCP_BRIDGE_HOST` in `.env` if the probe fails or times out.

Pass the IP to containers via `-e NANOCLAW_MCP_HOST=<ip>` in the container args.

### `container/agent-runner/src/index.ts` (update)

Add a second MCP server entry to the SDK `query()` options:

```typescript
...(process.env.NANOCLAW_MCP_HOST ? {
  'apple-events': {
    command: 'npx',
    args: ['mcp-remote', `http://${process.env.NANOCLAW_MCP_HOST}:${process.env.NANOCLAW_MCP_PORT || '7891'}/sse`],
  }
} : {}),
```

Conditionally included so the container works fine if the host IP isn't set (e.g. tests, Docker).

Also add `mcp__apple-events__*` to `allowedTools`.

### `groups/main/CLAUDE.md` (update)

Document available Reminders and Calendar tools so the agent knows to use them.

## Lifecycle

- `McpBridge` starts before any container is spawned
- If `supergateway` crashes: log a warning, attempt restart with exponential backoff (1s, 2s, 4s, max 30s)
- NanoClaw continues operating if the bridge is down — Calendar/Reminders tools will be unavailable but messaging works normally
- Stops cleanly on SIGTERM/SIGINT

## Permissions

`mcp-server-apple-events` runs as a child of the NanoClaw launchd user agent. macOS will show a TCC permission dialog attributed to `node` the first time it accesses Calendar or Reminders. The dialog appears on-screen automatically. If it doesn't, grant access manually via System Settings → Privacy & Security → Calendars / Reminders.

## Configuration

All optional — sensible defaults work out of the box:

| `.env` key | Default | Purpose |
|---|---|---|
| `MCP_BRIDGE_PORT` | `7891` | Port supergateway listens on |
| `MCP_BRIDGE_ENABLED` | `true` | Set to `false` to disable entirely |
| `MCP_BRIDGE_HOST` | (auto-discovered) | Override host gateway IP |
