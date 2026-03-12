# Taskiepedia Fix & Article Knowledge Base Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the broken Taskiepedia setup: add multi-bot Telegram support, create a message query MCP server, build the article-processing skill, and register Taskiepedia on a dedicated bot.

**Architecture:** The message query MCP server is a stdio process registered in the MCP server registry. Containers connect to it via mcp-remote (already wired). Multi-bot support splits `TELEGRAM_BOT_TOKEN` on commas and creates one `TelegramChannel` per token. The article-processing skill is a SKILL.md that the container agent follows.

**Tech Stack:** TypeScript, better-sqlite3, @modelcontextprotocol/sdk, Grammy

**Design Doc:** `docs/plans/2026-03-18-taskiepedia-fix-design.md`

---

## Task 1: Create Message Query MCP Server

**Files:**
- Create: `mcp-servers/messages/index.ts`
- Create: `mcp-servers/messages/package.json`
- Create: `mcp-servers/messages/tsconfig.json`

**Step 1: Create package.json**

```json
{
  "name": "nanoclaw-messages-mcp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.7.0",
    "better-sqlite3": "^11.8.1",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["index.ts"]
}
```

**Step 3: Write index.ts**

The MCP server exposes a single `query_messages` tool. It reads the DB path from `NANOCLAW_DB_PATH` env var (set by the registry startup). Authorization: uses `NANOCLAW_GROUP_FOLDER` and `NANOCLAW_IS_MAIN` from the container environment — but since this runs on the HOST side (via supergateway), the authorization must be done differently. The container passes `chat_jid` and the server checks it against the group's registered JID.

Actually, since this MCP server runs on the host and ALL containers connect to it via the same supergateway URL, we can't do per-container auth at the MCP level. Instead, we make the tool accept `chat_jid` as a required parameter and rely on the fact that the agent's CLAUDE.md only instructs it to query its own chat. This is consistent with how other MCP tools work (e.g., `send_message` takes a `chatJid`).

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import { z } from 'zod';
import path from 'path';

const DB_PATH = process.env.NANOCLAW_DB_PATH
  || path.resolve(process.cwd(), 'store', 'messages.db');

const db = new Database(DB_PATH, { readonly: true });

const server = new McpServer({
  name: 'nanoclaw-messages',
  version: '1.0.0',
});

server.tool(
  'query_messages',
  `Query stored messages from a chat. Returns messages matching the criteria as JSON.

Use this to search conversation history, find URLs, or check what was discussed.

Parameters:
- chat_jid (required): The chat JID to query (e.g., "tg:8403395613")
- since: ISO timestamp to start from (default: 24 hours ago)
- until: ISO timestamp to end at (default: now)
- search: Text to search for in message content (case-insensitive substring match)
- limit: Max messages to return (default: 100, max: 500)`,
  {
    chat_jid: z.string().describe('Chat JID to query'),
    since: z.string().optional().describe('ISO timestamp start (default: 24h ago)'),
    until: z.string().optional().describe('ISO timestamp end (default: now)'),
    search: z.string().optional().describe('Search text (case-insensitive)'),
    limit: z.number().optional().describe('Max results (default: 100, max: 500)'),
  },
  async (args) => {
    const limit = Math.min(args.limit || 100, 500);
    const since = args.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const until = args.until || new Date().toISOString();

    let sql = `
      SELECT id, chat_jid, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp >= ? AND timestamp <= ?
    `;
    const params: (string | number)[] = [args.chat_jid, since, until];

    if (args.search) {
      sql += ` AND content LIKE ?`;
      params.push(`%${args.search}%`);
    }

    sql += ` ORDER BY timestamp ASC LIMIT ?`;
    params.push(limit);

    try {
      const rows = db.prepare(sql).all(...params);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: rows.length, messages: rows }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error querying messages: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 4: Install dependencies and build**

```bash
cd mcp-servers/messages && npm install && npm run build
```

**Step 5: Register in MCP server registry**

Update `mcp-servers/registry.json` to add:
```json
"messages": {
  "transport": "stdio",
  "command": "node",
  "args": ["mcp-servers/messages/dist/index.js"],
  "enabled": true
}
```

The `McpBridgeManager` will auto-assign a port and start supergateway for it.

**Step 6: Build main project and restart**

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Step 7: Verify MCP server is running**

```bash
# Check the process is running
ps aux | grep messages/dist
# Check the registry was updated with a port
cat mcp-servers/registry.json
```

**Step 8: Commit**

```bash
jj describe -m "feat: add message query MCP server"
jj new
```

---

## Task 2: Add Multi-Bot Telegram Support

**Files:**
- Modify: `src/config.ts:14-15` (TELEGRAM_BOT_TOKEN → TELEGRAM_BOT_TOKENS array)
- Modify: `src/index.ts:12-13,512-516` (create multiple TelegramChannel instances)

**Step 1: Update config.ts**

Change `TELEGRAM_BOT_TOKEN` to `TELEGRAM_BOT_TOKENS` (array). Keep the old export for backwards compat.

In `src/config.ts`, replace the TELEGRAM_BOT_TOKEN lines:

```typescript
// Support comma-separated tokens for multiple bots
const rawTokens = process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_BOT_TOKENS: string[] = rawTokens
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
// Backwards compat
export const TELEGRAM_BOT_TOKEN = TELEGRAM_BOT_TOKENS[0] || '';
```

**Step 2: Update index.ts**

Replace the single Telegram bot creation block (lines 512-516):

```typescript
import { TELEGRAM_BOT_TOKENS } from './config.js';
// (keep TELEGRAM_BOT_TOKEN import for now, remove later)

// In main():
for (const token of TELEGRAM_BOT_TOKENS) {
  const telegram = new TelegramChannel(token, channelOpts);
  channels.push(telegram);
  await telegram.connect();
}
```

**Step 3: Update .env with both tokens**

```
TELEGRAM_BOT_TOKEN=8544684321:AAGXDxHNEyfsn_AeSjRWFlgG085Fxpe9PO8,8489023992:AAEwr7Jv9Owgq9yQk2-AIzDBeEdyPGZvAYk
```

**Step 4: Build and restart**

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Step 5: Verify both bots connect**

Check logs for two "Telegram bot connected" lines:
```bash
tail -20 /tmp/nanoclaw.log | grep "Telegram bot"
```

**Step 6: Get Taskiepedia chat JID**

User sends `/chatid` to the new Taskiepedia bot in a private chat. Note the JID.

**Step 7: Commit**

```bash
jj describe -m "feat: support multiple Telegram bot tokens"
jj new
```

---

## Task 3: Create Article Processing Skill

**Files:**
- Create: `container/skills/article-processing/SKILL.md`

**Step 1: Write SKILL.md**

The skill instructs the agent on how to process `!archive` URLs. It uses `query_messages` MCP tool to find messages and bash/curl for Jina AI Reader.

```markdown
---
name: article-processing
description: Process !archive URLs into the knowledge base. Fetches articles via Jina AI Reader, generates summaries, detects concepts, and maintains cross-referenced markdown files.
---

# Article Processing Skill

## When to Use

Run this skill when:
- A scheduled task triggers daily article processing
- A user asks to process articles manually

## Knowledge Base Location

`/workspace/project/groups/global/knowledge-base/`
- `articles/` — Individual article files (YYYY-MM-DD-slug.md)
- `concepts/` — Concept aggregation pages (concept-name.md)

## Workflow

### 1. Find URLs to Process

Use the `mcp__nanoclaw-messages__query_messages` tool to find messages containing `!archive`:

- Set `search` to `!archive`
- Set `since` to 24 hours ago (for daily runs) or as instructed
- Extract all URLs from matching messages using regex: `https?://[^\s)>\]]+`

### 2. Deduplicate

For each URL found:
- Search existing files in `/workspace/project/groups/global/knowledge-base/articles/` for the URL
- `grep -r "Source:.*URL" /workspace/project/groups/global/knowledge-base/articles/`
- Skip any URL already present

### 3. Fetch Article Content

For each new URL, fetch via Jina AI Reader:

```bash
curl -s "https://r.jina.ai/URL_HERE" \
  -H "Accept: text/markdown" \
  -H "X-No-Cache: true"
```

If Jina AI fails (empty response, error, or timeout), log the failure and continue with the next URL.

### 4. Create Article File

For each successfully fetched article, create a file at:
`/workspace/project/groups/global/knowledge-base/articles/YYYY-MM-DD-slug.md`

Slug rules: lowercase, hyphens, max 50 chars, derived from article title.

Template:
```
# [Article Title]

**Source:** [Original URL]
**Date Saved:** YYYY-MM-DD
**Concepts:** #concept-1, #concept-2, #concept-3

## Summary

[Generate a 2-3 paragraph summary of the article's key points]

## Key Quotes

> "Notable quote 1"

> "Notable quote 2"

> "Notable quote 3"

## Images

[Include any significant images from the article using markdown syntax]

## Full Content

[The extracted markdown content from Jina AI Reader]
```

### 5. Detect Concepts

For each article, identify 2-5 main topics/concepts. Use lowercase-with-hyphens format (e.g., `artificial-intelligence`, `climate-change`).

Consider:
- Main subject matter
- Key themes and arguments
- Related fields or domains
- Avoid overly generic concepts (e.g., "article", "writing")

### 6. Update Concept Pages

For each detected concept, create or update the concept page at:
`/workspace/project/groups/global/knowledge-base/concepts/concept-name.md`

If the file exists, add the new article reference to the "Related Articles" section.
If new, create with this template:

```
# [Concept Name]

## Related Articles

- [[YYYY-MM-DD-article-slug]] - Brief one-line description

## Key Themes

[Summary of common themes across articles tagged with this concept]

## Notable Quotes

> "Relevant quote" — [[article-slug]]
```

### 7. Send Summary Report

After processing all articles, send a summary using `mcp__nanoclaw__send_message`:

```
*Daily Article Processing Report - [Date]*

Processed X articles, updated Y concepts.

*New Articles:*
• [Title 1] — #concept-a, #concept-b
• [Title 2] — #concept-c, #concept-d

*Updated Concepts:* concept-a, concept-b, concept-c, concept-d

*Errors:* [List any URLs that failed to fetch, or "None"]
```

## Error Handling

- If Jina AI returns an error for a URL, skip it and report in the summary
- If a URL is malformed, skip it
- If the knowledge base directory doesn't exist, create it
- Always send a summary report, even if no articles were processed
```

**Step 2: Verify skill gets synced to container sessions**

The skill will be auto-synced by `container-runner.ts` (line 177-191) which copies from `container/skills/` to each group's `.claude/skills/`.

**Step 3: Commit**

```bash
jj describe -m "feat: add article-processing skill"
jj new
```

---

## Task 4: Register Taskiepedia on New Bot

**Depends on:** Task 2 (multi-bot support running), user providing new chat JID

**Step 1: Delete old taskiepedia folder registration (if stale)**

The old `taskiepedia` folder in `groups/` can stay — it has useful CLAUDE.md and logs.

**Step 2: Register new JID**

Once user provides the JID from `/chatid` (e.g., `tg:NEW_ID`):

```bash
sqlite3 store/messages.db "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger) VALUES ('tg:NEW_ID', 'Taskiepedia', 'taskiepedia', '!archive', datetime('now'), 0);"
```

**Step 3: Create new scheduled task**

```bash
sqlite3 store/messages.db "INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode) VALUES ('task-taskiepedia-daily', 'taskiepedia', 'tg:NEW_ID', 'Run the article-processing skill to process all URLs shared with the !archive trigger today. Generate summaries, detect concepts, and update the knowledge base. Send a summary report when complete.', 'cron', '0 23 * * *', datetime(''now'', ''+1 day'', ''start of day'', ''+23 hours''), 'active', datetime(''now''), 'group');"
```

**Step 4: Restart service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Step 5: Test**

Send a message to the new Taskiepedia bot:
```
!archive https://example.com/test-article
```

Verify the bot receives it and the message appears in the DB.

**Step 6: Commit**

```bash
jj describe -m "feat: register taskiepedia on dedicated bot"
jj new
```

---

## Task 5: Update Taskiepedia CLAUDE.md

**Files:**
- Modify: `groups/taskiepedia/CLAUDE.md`

**Step 1: Update CLAUDE.md**

Remove the line about sharing the same chat JID. Add reference to the `query_messages` tool. Update to reflect the dedicated channel setup.

**Step 2: Commit**

```bash
jj describe -m "docs: update taskiepedia CLAUDE.md for dedicated channel"
jj new
```
