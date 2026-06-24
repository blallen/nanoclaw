#!/usr/bin/env node
/**
 * PreCompact command hook — ported from the container agent-runner's
 * `createPreCompactHook` + helpers (container/agent-runner/src/index.ts).
 *
 * Before compaction, archives the full transcript to a markdown file under
 * `<group>/conversations/<date>-<name>.md`. The name is derived from the
 * session summary (sessions-index.json) when available, else a timestamp.
 *
 * Reads the hook JSON from stdin ({ transcript_path, session_id, cwd }).
 * Path note: the container wrote to `/workspace/group/conversations`; on the
 * host the hook runs with cwd = groups/main, so we resolve `conversations/`
 * relative to the hook's `cwd` (falling back to process.cwd()).
 *
 * Never throws — on any error it swallows and prints `{}`, mirroring the
 * container behavior (a failed archive must not block compaction).
 */

import fs from 'fs';
import path from 'path';

function log(message) {
  process.stderr.write(`[archive-precompact] ${message}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function getSessionSummary(sessionId, transcriptPath) {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

function sanitizeFilename(summary) {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName() {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

function parseTranscript(content) {
  const messages = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((c) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip malformed lines */
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages, title) {
  const now = new Date();
  const formatDateTime = (d) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const assistantName = process.env.ASSISTANT_NAME || 'Assistant';

  const lines = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName;
    const content =
      msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    const transcriptPath = input.transcript_path;
    const sessionId = input.session_id;
    // The hook runs with cwd = groups/<folder>; resolve conversations/ there.
    const baseDir = input.cwd || process.cwd();

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      process.stdout.write('{}');
      return;
    }

    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);

    if (messages.length === 0) {
      log('No messages to archive');
      process.stdout.write('{}');
      return;
    }

    const summary = getSessionSummary(sessionId, transcriptPath);
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = path.join(baseDir, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
  }

  process.stdout.write('{}');
}

main();
