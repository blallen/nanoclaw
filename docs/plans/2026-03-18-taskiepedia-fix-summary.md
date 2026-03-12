# Taskiepedia Fix — Summary

**Date:** 2026-03-18

## Problem

The article knowledge base implementation (started 2026-03-12) broke the main Taskie bot:

1. **Main bot dead for a week** — Taskiepedia was registered on `tg:8403395613` (Brandon's personal chat), overwriting the main bot's registration. All messages went to the taskiepedia group instead of main.
2. **Scheduled task stuck in a loop** — The daily 11pm task ran but couldn't access message history. Non-main containers don't have DB access, so it could never find `!archive` messages. It reported the same error every day.
3. **Missing skill** — The `article-processing` skill referenced in Taskiepedia's CLAUDE.md was never created.
4. **Same-JID conflict** — Both main and taskiepedia were registered on the same Telegram chat JID, which SQLite's primary key constraint doesn't allow (taskiepedia overwrote main).

## What Was Fixed

### 1. Main Bot Revived
- Deleted the taskiepedia registration from `tg:8403395613`
- Re-registered `tg:8403395613` as the main group (folder: `main`, `requiresTrigger: false`)
- Cancelled the broken scheduled task (`task-1773342146753-24fy08`)
- Restored a missing bot message to the DB
- Service restarted — main bot immediately processed backlogged messages and archived 3 articles

### 2. Multi-Bot Telegram Support
- `src/config.ts`: `TELEGRAM_BOT_TOKEN` now supports comma-separated tokens → `TELEGRAM_BOT_TOKENS` array
- `src/index.ts`: Creates one `TelegramChannel` per token
- Backwards compatible — single token works as before
- Currently running with just `@taskie_ai_bot` (second bot `@taskiepedia_bot` token removed from .env but available if needed later)

### 3. Message Query MCP Server
- New stdio MCP server at `mcp-servers/messages/`
- Exposes `query_messages` tool: query by chat JID, date range, search text, limit
- Registered in `mcp-servers/registry.json` on port 7892
- Runs via supergateway, accessible to all container agents via mcp-remote
- Allows any container agent to search conversation history without direct DB access

### 4. Article Processing Skill
- Created `container/skills/article-processing/SKILL.md`
- Full workflow: find `!archive` URLs → deduplicate → fetch via Jina AI Reader → generate summaries → detect concepts → update knowledge base → send report
- Uses `mcp__nanoclaw-messages__query_messages` for message search
- Auto-synced to container sessions by `container-runner.ts`

### 5. Taskiepedia Dedicated Group
- Created Telegram group "Taskiepedia Group" with JID `tg:-5239645499`
- Registered with `requiresTrigger: false` — processes all messages immediately
- `@taskie_ai_bot` added to the group (no second bot needed)
- Group-specific CLAUDE.md at `groups/taskiepedia/CLAUDE.md` instructs the agent on article processing behavior
- Daily 11pm scheduled task created but **paused** — not needed since messages are processed in real-time

## Architecture Decision: One Bot, Multiple Groups

Initially planned a second Telegram bot (`@taskiepedia_bot`) for the dedicated channel. Realized this was unnecessary — the same bot can serve multiple groups, each with their own JID, registration, and behavior. Telegram group JIDs are unique (negative numbers like `tg:-5239645499`), so no conflicts with the main private chat (`tg:8403395613`).

The multi-bot code remains in place for future use if separate bot identities are ever wanted.

## Files Changed

| File | Change |
|------|--------|
| `src/config.ts` | `TELEGRAM_BOT_TOKENS` array support |
| `src/index.ts` | Loop over tokens to create multiple channels |
| `mcp-servers/messages/index.ts` | New MCP server |
| `mcp-servers/messages/package.json` | New package |
| `mcp-servers/messages/tsconfig.json` | New TypeScript config |
| `mcp-servers/registry.json` | Added `messages` server entry |
| `container/skills/article-processing/SKILL.md` | New skill |
| `groups/taskiepedia/CLAUDE.md` | Updated for dedicated channel + message query tool |
| `docs/plans/2026-03-18-taskiepedia-fix-design.md` | Design doc |
| `docs/plans/2026-03-18-taskiepedia-fix-plan.md` | Implementation plan |

## iOS Shortcut Setup (TODO)

To send articles from iOS share sheet to the Taskiepedia group:
1. Create iOS Shortcut accepting URLs from Share Sheet
2. Use "Get Contents of URL" action to call Telegram Bot API:
   ```
   https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=-5239645499&text=!archive <URL>
   ```
3. Articles will be processed immediately by the bot
