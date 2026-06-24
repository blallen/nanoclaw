# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions. See [docs/MY-SETUP.md](docs/MY-SETUP.md) for how this specific fork (Taskie) is configured.

## Quick Context

Single Node.js process that connects to Telegram (primary channel) and routes messages to a Claude agent. Each group has isolated filesystem and memory.

The **main** group runs as a **host `claude` harness** (full Claude Code, not the embedded Agent SDK) operating directly in `groups/main/` — the Apple Container is retired for main. **Non-main** groups still run the Claude Agent SDK inside an Apple Container (Linux VM). `src/runner-selection.ts` (`chooseRunner`) routes the main path to `host-claude-runner.ts` and everything else to `container-runner.ts`. Both Telegram (automated, headless) and the "Taskie" Remote Control phone endpoint drive the same host harness over the shared `groups/main` workspace. See `docs/plans/2026-06-24-host-claude-harness-migration-design.md`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/telegram.ts` | Telegram connection, send/receive (primary) |
| `src/channels/whatsapp.ts` | WhatsApp connection (legacy, not used in production) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/runner-selection.ts` | `chooseRunner(group)`: host runner for `main`, container runner otherwise |
| `src/host-claude-runner.ts` | Spawns host `claude -p` harness for `main` (no container) |
| `src/claude-stream.ts` | `ClaudeStreamParser` for `claude --output-format stream-json` |
| `src/nanoclaw-mcp-server.ts` | Host twin of the container `nanoclaw` MCP (send_message/schedule_task/etc.); reads `NANOCLAW_IPC_DIR` |
| `src/container-runner.ts` | Spawns agent containers with mounts (non-main groups) |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `launchd/com.nanoclaw.remote.plist` (+ `.remote.sh`) | Taskie Remote Control phone endpoint: launchd agent + wrapper that runs `claude remote-control --name Taskie` in `groups/main` |
| `groups/main/.claude/` | Main harness config: `settings.json` + `hooks/` (sanitize-bash, archive-precompact) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (container agents via Bash; host re-homing is a follow-up) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Container Build Cache

Applies only to **non-main** groups now — `main` runs on the host harness and does not use the container image.

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`
