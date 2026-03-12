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
