#!/usr/bin/env node
/**
 * PreToolUse(Bash) command hook — ported from the container agent-runner's
 * `createSanitizeBashHook` (container/agent-runner/src/index.ts).
 *
 * Strips Claude's API-auth secrets from the environment of any Bash command the
 * agent runs by prepending `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN`.
 * These vars are needed by claude-code itself for auth but must never leak into
 * subprocesses the agent spawns.
 *
 * Reads the hook JSON from stdin ({ tool_input: { command } }) and prints the
 * Claude Code command-hook response that rewrites the command via
 * hookSpecificOutput.updatedInput. Never throws — on any error prints `{}` so
 * the tool proceeds unmodified.
 */

// Secrets to strip from Bash tool subprocess environments.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

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

async function main() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    const toolInput = input?.tool_input ?? {};
    const command = toolInput.command;
    if (typeof command !== 'string' || !command) {
      process.stdout.write('{}');
      return;
    }

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    // Intentionally does NOT set a permissionDecision — the active permission
    // mode governs approval. Forcing 'allow' here would auto-approve every Bash
    // command, bypassing prompts on the interactive Remote Control path.
    const response = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...toolInput,
          command: unsetPrefix + command,
        },
      },
    };
    process.stdout.write(JSON.stringify(response));
  } catch {
    // Never throw — let the tool proceed unmodified.
    process.stdout.write('{}');
  }
}

main();
