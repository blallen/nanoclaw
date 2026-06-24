/**
 * Runner selection for NanoClaw.
 *
 * The `main` group runs through the host `claude` harness (no Apple Container),
 * while every other group runs in an isolated Apple Container. Both runners share
 * the same signature and return type, so callers can swap them transparently.
 */
import { MAIN_GROUP_FOLDER } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { runHostClaudeAgent } from './host-claude-runner.js';
import { RegisteredGroup } from './types.js';

/**
 * Pick the agent runner for a group: the host claude runner for `main`,
 * the container runner for everyone else.
 */
export function chooseRunner(
  group: RegisteredGroup,
): typeof runHostClaudeAgent | typeof runContainerAgent {
  return group.folder === MAIN_GROUP_FOLDER ? runHostClaudeAgent : runContainerAgent;
}
