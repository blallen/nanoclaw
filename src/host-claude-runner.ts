/**
 * Host Claude Runner for NanoClaw
 *
 * Spawns the `claude` CLI directly on the host (no Apple Container) for the
 * main group. Mirrors the signature and control-flow of
 * `runContainerAgent` in `container-runner.ts` so callers can swap it in with
 * minimal change (the wiring lives in Task 5, not here).
 *
 * Key differences from the container path:
 *  - Output is parsed from `claude --output-format stream-json` via
 *    `ClaudeStreamParser`, not from NANOCLAW_OUTPUT markers.
 *  - Isolation + auth is achieved with env vars (CLAUDE_CONFIG_DIR for an
 *    isolated config dir, CLAUDE_CODE_OAUTH_TOKEN for auth) rather than mounts.
 *  - Graceful kill is `child.kill()` — there is no `container stop`.
 *
 * Scope (v1): single prompt per invocation. Mid-turn follow-up message
 * streaming (the container's IPC-input piping / `--input-format stream-json`)
 * is intentionally NOT implemented here — the GroupQueue + message loop already
 * enqueue new messages as fresh turns.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ClaudeStreamParser } from './claude-stream.js';
import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Absolute path to the claude binary — do NOT rely on PATH.
const CLAUDE_BIN = '/Users/ballen/.local/bin/claude';

/**
 * Build the claude CLI flag array. The prompt is NOT passed as an argv — it is
 * written to the child's stdin (see runHostClaudeAgent) to avoid shell-escaping
 * and size issues with multiline Telegram prompts.
 *
 * `--resume <id>` is added only when a sessionId is present.
 */
export function buildClaudeArgs({ sessionId }: { sessionId?: string }): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
}

/**
 * Read the OAuth token used to authenticate the isolated claude config dir.
 * The isolated CLAUDE_CONFIG_DIR does NOT use the keychain, so the token must
 * be supplied explicitly. Falls back to process.env when .env has no value.
 */
function readOauthToken(): string | undefined {
  const fromEnvFile = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']).CLAUDE_CODE_OAUTH_TOKEN;
  return fromEnvFile ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

export async function runHostClaudeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Per-group IPC namespace. The host flow has no agent-runner, but the
  // host-runnable `nanoclaw` MCP `send_message` writes <IPC_DIR>/input/_sent
  // and would throw ENOENT if input/ is missing — so create all of them.
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'images'), { recursive: true });

  // Isolated claude config dir (isolation from the user's personal ~/.claude).
  // Reuses the same path the container path uses for this group's sessions.
  const configDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(configDir, { recursive: true });

  const args = buildClaudeArgs({ sessionId: input.sessionId });
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const name = `nanoclaw-host-${safeName}-${Date.now()}`;

  const oauthToken = readOauthToken();
  if (!oauthToken) {
    logger.warn(
      { group: group.name },
      'No CLAUDE_CODE_OAUTH_TOKEN found in .env or process.env; host claude may fail to authenticate',
    );
  }

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  logger.info(
    { group: group.name, name, isMain: input.isMain, resume: !!input.sessionId },
    'Spawning host claude agent',
  );

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: groupDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
        NANOCLAW_CHAT_JID: input.chatJid,
        NANOCLAW_GROUP_FOLDER: input.groupFolder,
        NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
        NANOCLAW_IPC_DIR: groupIpcDir,
      },
    });

    onProcess(child, name);

    // Pass the prompt via stdin (avoids argv shell-escaping/size issues).
    // `claude -p` with no positional prompt reads it from stdin.
    child.stdin.write(input.prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    let newSessionId: string | undefined;
    let hadStreamingOutput = false;
    let sawError = false;
    let timedOut = false;
    let outputChain = Promise.resolve();

    const parser = new ClaudeStreamParser();

    parser.on('text', (text) => {
      if (!text) return;
      newSessionId = parser.sessionId ?? newSessionId;
      hadStreamingOutput = true;
      // Activity detected — reset the hard timeout.
      resetTimeout();
      if (onOutput) {
        outputChain = outputChain.then(() =>
          onOutput({ status: 'success', result: text, newSessionId }),
        );
      }
    });

    parser.on('result', (evt) => {
      newSessionId = parser.sessionId ?? newSessionId;
      if (evt.is_error || parser.isError) {
        sawError = true;
      }
    });

    child.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging (with size cap).
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Host claude stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      parser.push(chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ host: group.folder }, line);
      }
      // Don't reset timeout on stderr — claude writes debug logs continuously.
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Host claude stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so a
    // streaming run that goes idle is reaped gracefully rather than mid-output.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, name }, 'Host claude timeout, killing process');
      child.kill();
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    function resetTimeout() {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    }

    child.on('close', (code) => {
      clearTimeout(timeout);

      // Clean up downloaded images.
      const imagesDir = path.join(groupIpcDir, 'images');
      try {
        const imageFiles = fs.readdirSync(imagesDir);
        for (const file of imageFiles) {
          try {
            fs.unlinkSync(path.join(imagesDir, file));
          } catch {
            /* ignore */
          }
        }
        if (imageFiles.length > 0) {
          logger.debug({ group: group.name, count: imageFiles.length }, 'Cleaned up IPC images');
        }
      } catch {
        /* images dir may not exist */
      }

      const duration = Date.now() - startTime;

      // Note: the host flow does NOT read the <IPC_DIR>/input/_sent sentinel.
      // The container agent-runner uses it to detect "did the agent message
      // this turn"; here the orchestrator already tracks output via onOutput,
      // so the signal is intentionally unused.

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `host-claude-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Host Claude Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Name: ${name}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure. The agent already
        // streamed its response; this is just the process reaped after idle.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, name, duration, code },
            'Host claude timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: group.name, name, duration, code },
          'Host claude timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host claude timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write a per-run log file.
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `host-claude-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
      const isError = code !== 0 || sawError;

      const logLines = [
        `=== Host Claude Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Saw Error: ${sawError}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Args ===`,
          args.join(' '),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Host claude log written');

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr, logFile },
          'Host claude exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host claude exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (sawError) {
        logger.error(
          { group: group.name, duration, logFile },
          'Host claude reported an error result',
        );
        resolve({
          status: 'error',
          result: null,
          error: 'Host claude reported an error result',
        });
        return;
      }

      // Streaming mode: text was already delivered via onOutput. Wait for the
      // output chain to settle, then return the completion marker.
      outputChain.then(() => {
        logger.info(
          { group: group.name, duration, newSessionId },
          'Host claude completed (streaming mode)',
        );
        resolve({ status: 'success', result: null, newSessionId });
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, name, error: err }, 'Host claude spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Host claude spawn error: ${err.message}`,
      });
    });
  });
}
