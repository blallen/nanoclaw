#!/usr/bin/env node
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'store', 'messages.db');

const db = new Database(dbPath, { readonly: true });

const chats = db.prepare(`
  SELECT jid, name, last_message_time
  FROM chats
  WHERE jid LIKE 'tg:%'
  ORDER BY last_message_time DESC
  LIMIT 10
`).all();

console.log('Recent Telegram chats:\n');
chats.forEach(chat => {
  console.log(`JID: ${chat.jid}`);
  console.log(`Name: ${chat.name}`);
  console.log(`Last activity: ${chat.last_message_time}`);
  console.log('---');
});

db.close();
