# Host Claude Code Harness Migration (Cowork-style)

**Date:** 2026-06-24
**Status:** Design approved, ready for implementation planning

## Problem & Goal

Today the Taskie (main) agent runs as a **Claude Agent SDK `query()` loop *inside* an ephemeral Apple Container**, spawned per Telegram trigger. We want to flip this to the architecture described in [How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude): **the agent loop runs on the host; the sandbox is just a workspace the harness operates in.**

Concretely, the migration must deliver:

1. **Drive Taskie from the Claude mobile app** via Claude Code **Remote Control** (a real `claude` session running on the Mac Mini, attachable from the phone), *in addition to* Telegram.
2. **Interactive drop-in** — a phone session and the automated Telegram path share the same workspace, tools, and memory.
3. **Reliability** — escape ephemeral-container-per-message; the article moved the loop out of the VM "for reliability."
4. **Full Claude Code harness** (skills, hooks, slash commands, subagents) — not just the embedded Agent SDK.

### Why not "Claude Code on the web"?
There are two distinct features. **Claude Code on the web** runs in ephemeral Anthropic cloud VMs and *requires a GitHub repo* — it cannot reach the Mac Mini's Taskie workspace. **Remote Control** (`claude remote-control`) runs a `claude` session *on your own machine*, exposed via a URL you attach to from the mobile app or claude.ai. Remote Control is the correct primitive for "drive Taskie from my phone."

## Core Model

> **One Claude Code harness, running on the host in the Taskie workspace, with the full NanoClaw toolset. Telegram is one input channel; the phone (Remote Control) is another. The ephemeral container is retired for the main path.**

Both drivers load the *same* `.claude/` (skills, MCP servers, settings) and operate on the *same* workspace + `CLAUDE.md` memory, so they are the same Taskie reached two ways. Autonomy features (`/loop`, scheduled tasks) let the phone session behave as proactively as the Telegram one.

### Coexistence: shared workspace, two drivers
The durable thing is the **workspace** (files + `CLAUDE.md` memory + per-group dirs). The Telegram path drives an automated headless harness against it; Remote Control attaches an interactive session to the same files/memory. They share state via the workspace, not a single live conversation — the most reliable model and it sidesteps multiplexing one live session.

## Components

### 1. `host-claude-runner.ts` (replaces `container-runner.ts` for main)
On a Telegram trigger, the orchestrator spawns:

```
claude -p "<formatted messages>" \
  --resume <sessionId> \
  --output-format stream-json --verbose \
  --permission-mode <...> \
  (cwd = groups/main)
```

The existing `runContainerAgent` control flow ports almost directly: spawn → stream stdout → parse → reply to Telegram → idle timer → hard timeout → persist session id. Only the parse target changes — Claude Code `stream-json` events instead of the bespoke `OUTPUT_START/END` markers. Follow-up messages mid-turn use Claude Code's native **stream-json input**, replacing the hand-built `MessageStream`/IPC-piping mechanism.

### 2. NanoClaw toolset — reused as-is
The `nanoclaw` stdio MCP server (`send_message`, `schedule_task`, `list/pause/resume/cancel_task`, `register_group`, MCP server management) stays a separate stdio process, now registered in `groups/main/.mcp.json` (or settings). It keeps writing the same IPC JSON files, except the IPC directory is now a **plain host directory, not a bind-mount**. `src/ipc.ts` already watches it. Context (`chatJid`, `groupFolder`, `isMain`) is supplied via env vars the runner sets, exactly as today. The entire scheduling/registration/messaging surface is reused.

### 3. Sessions & memory
- Sessions become **native Claude Code sessions** (`--resume <id>`, id captured from the `system/init` stream event). `db.ts` session storage is unchanged; it now holds Claude Code session ids.
- Memory is unchanged: `groups/main/CLAUDE.md` + global `groups/CLAUDE.md` load natively because the harness runs in `groups/main`.
- The pre-compact transcript-archiving hook and the bash-secret-sanitization hook move into `groups/main/.claude/settings.json` as real Claude Code hooks (they currently live in the SDK runner).

### 4. Auth & secrets — simplified
No more secrets-over-stdin. The host `claude` uses logged-in credentials (keychain / `CLAUDE_CODE_OAUTH_TOKEN`). This is the article's "credentials stay on host" property — there is no guest to leak into. The bash-secret-sanitization hook stays as defense-in-depth.

### 5. Scheduler
`task-scheduler.ts` swaps `runContainerAgent` for the same `host-claude-runner` call. Isolated vs group context = fresh session vs `--resume`. No other change.

### 6. Remote Control (phone path)
A second long-lived process: `claude remote-control` running in `groups/main` with the **same `.claude/` config**, so it inherits identical skills, MCP servers (`nanoclaw` tools + apple-events/calendar), and memory. Managed by launchd alongside the orchestrator. From the phone, attaching yields a Taskie that can `send_message` to Telegram, `schedule_task`, and edit memory — same powers as the automated path.

### 7. Sandboxing (Seatbelt)
`claude` runs with its macOS Seatbelt sandbox enabled, workspace scoped to the NanoClaw project dir plus allowed dirs (e.g. apple-events bridge). Bash now runs sandboxed-on-Mac instead of in a Linux VM.
- **Caveat:** `agent-browser`/Chromium currently assume the Linux container. On the host, use macOS Chromium, or keep one optional container purely for browser automation. Follow-up, not a v1 blocker.

### 8. Retired for the main path
`container-runner.ts`, `container/agent-runner` (SDK runner), the Dockerfile build, `discoverHostGateway`, and the MCP-bridge-over-host-gateway indirection (MCP servers are now local stdio for the host harness). Net reduction in code, in line with "small enough to understand."

## Concurrency: GroupQueue serialization
The Telegram driver and the Remote Control session operate on the same workspace and could race on files/memory. **Mitigation (decided):** route both through the existing `GroupQueue` so work for `main` is serialized — only one driver mutates the workspace at a time.

## Scope decisions
- **Non-main groups:** out of scope for v1. They keep the existing container path (isolation matters more there). Migrate later if desired.
- **Multi-group Remote Control:** not needed — in practice only `main` (Taskie) + `global` exist.

## Risks & trade-offs
- **Weaker isolation** than a hypervisor (Seatbelt syscall filter, bash on the Mac). Accepted — it is the same primitive Claude Code itself ships, and the user owns the machine and the data.
- **Browser automation** must be re-homed off the Linux container (see §7 caveat).
- **Process management:** two launchd-managed `claude`-bearing processes (orchestrator + remote-control) instead of one.

## Out of scope
- Migrating non-main groups off the container.
- Re-homing browser automation (tracked as a follow-up).
- Any GitHub/cloud-session integration.
