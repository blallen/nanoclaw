# Taskiepedia Fix & Article Knowledge Base Revival - Design

**Date:** 2026-03-18
**Status:** Approved

## Problem

The article knowledge base implementation (started 2026-03-12) broke the main Taskie bot:

1. Taskiepedia was registered on `tg:8403395613` (Brandon's personal chat), overwriting the main registration
2. Main bot has been dead since March 12 — messages go to taskiepedia instead
3. Scheduled task runs daily but can't access message history (non-main containers lack DB access)
4. Article-processing skill was never created

## Solution

### 1. Fix Main Bot Registration (Priority)

- Delete taskiepedia registration from `tg:8403395613`
- Re-register `tg:8403395613` as main group (folder: `main`, trigger: `@Taskie`)
- Cancel the broken scheduled task (`task-1773342146753-24fy08`)

### 2. Multi-Bot Telegram Support

- Support comma-separated `TELEGRAM_BOT_TOKEN` values
- Create one `TelegramChannel` instance per token
- No changes to TelegramChannel class itself
- Future: main bot can add new bot tokens via IPC

### 3. Message Query MCP Server

New stdio MCP server at `mcp-servers/messages/` that:
- Connects to `store/messages.db` read-only
- Exposes `query_messages(chat_jid, since?, until?, search?, limit?)` tool
- Authorization: non-main groups only see their own chat's messages
- Registered in MCP server registry for all containers to access via mcp-remote

### 4. Article Processing Skill

New skill at `container/skills/article-processing/SKILL.md`:
- Uses `query_messages` MCP tool to scan for `!archive` messages
- Extracts URLs, deduplicates against existing articles
- Fetches via Jina AI Reader
- Generates summaries, detects concepts, creates files
- Updates concept pages

### 5. Taskiepedia Dedicated Channel

- New Telegram bot (token: stored in env)
- User DMs bot, gets new JID via `/chatid`
- Register taskiepedia with new JID, `requiresTrigger: false`
- Create new scheduled task targeting new JID
