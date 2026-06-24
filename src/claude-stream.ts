/**
 * Line-buffered parser for `claude --output-format stream-json`.
 *
 * The stream emits one JSON object per line. This is pure logic — no fs,
 * process, or spawn — so it is fully unit-testable. Feed bytes via `push()`;
 * listen for `text` (incremental assistant output) and `result` (terminal).
 */
import { EventEmitter } from 'events';

export interface ClaudeResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string | null;
  session_id?: string;
  [key: string]: unknown;
}

export interface ClaudeStreamParser {
  on(event: 'text', listener: (text: string) => void): this;
  on(event: 'result', listener: (result: ClaudeResultEvent) => void): this;
  emit(event: 'text', text: string): boolean;
  emit(event: 'result', result: ClaudeResultEvent): boolean;
}

export class ClaudeStreamParser extends EventEmitter {
  /** Session id from the init event (or the result event). */
  sessionId?: string;
  /** Final assistant text from the result event. */
  result?: string | null;
  /** True if the result event indicated an error. */
  isError?: boolean;

  private buffer = '';

  /**
   * Append a chunk of the stream. Complete `\n`-terminated lines are parsed
   * and dispatched; any trailing partial line stays buffered for the next push.
   */
  push(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Tolerate the occasional non-JSON line by ignoring it.
      return;
    }

    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init' && typeof obj.session_id === 'string') {
          this.sessionId = obj.session_id;
        }
        break;

      case 'assistant': {
        const message = obj.message as
          | { content?: Array<{ type?: string; text?: string }> }
          | undefined;
        for (const c of message?.content ?? []) {
          if (c.type === 'text' && typeof c.text === 'string') {
            this.emit('text', c.text);
          }
        }
        if (typeof obj.session_id === 'string') {
          this.sessionId = obj.session_id;
        }
        break;
      }

      case 'result': {
        const result = obj as ClaudeResultEvent;
        if (typeof result.session_id === 'string') {
          this.sessionId = result.session_id;
        }
        this.result = result.result;
        this.isError = result.subtype !== 'success' || result.is_error === true;
        this.emit('result', result);
        break;
      }

      default:
        // Ignore everything else (hooks, rate_limit_event, summaries, ...).
        break;
    }
  }
}
