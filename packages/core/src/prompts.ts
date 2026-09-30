// SPDX-License-Identifier: Apache-2.0
import { FEATURE_LIST_FILE, PROGRESS_FILE } from '@harnessboard/shared';
import type { VerifyResult } from '@harnessboard/shared';

/** Injected mid-turn when the soft context threshold is crossed. */
export function wrapUpPrompt(pct: number): string {
  return [
    `[harness] Context usage has reached ${pct}% of the window, so this session will end soon.`,
    'Finish the step you are on, then stop starting new work:',
    '1. Commit your changes with a clear message (work in progress is fine).',
    '2. Reply with a handoff note for the next session: what is done, what remains,',
    '   and anything non-obvious you learned. Keep it under 300 words.',
    `3. Make the first line of your reply exactly \`${STATUS_DONE}\` if the whole task is`,
    `   finished, or \`${STATUS_CONTINUE}\` if work remains.`,
  ].join('\n');
}

export const STATUS_DONE = 'STATUS: DONE';
export const STATUS_CONTINUE = 'STATUS: CONTINUE';

/** True when a wrap-up reply says the whole task is already finished. */
export function reportsDone(reply: string): boolean {
  return reply.trimStart().startsWith(STATUS_DONE);
}

/**
 * First message of a follow-up session. The note is the previous session's final reply,
 * or `null` when that session was cut off before writing one. `feedback` (a reviewer's
 * requested changes) replaces the note when the previous session finished its step.
 */
export function continuationPrompt(
  originalPrompt: string,
  note: string | null,
  feedback: string | null = null,
): string {
  const handoff =
    feedback ??
    (note
      ? `Handoff note from the previous session:\n${note}`
      : 'The previous session was cut off before it wrote a handoff note.');
  return [
    'You are continuing a task that an earlier session started in this same worktree.',
    'Check `git log` and `git status` to see the current state before changing anything.',
    '',
    `Original task:\n${originalPrompt}`,
    '',
    handoff,
  ].join('\n');
}

/** Sent when resuming the same session after a quota pause. */
export const QUOTA_RESUME_PROMPT =
  '[harness] The usage limit has reset. Continue the task from where you stopped.';

/** First session of a loop task: plan the work as a feature list, implement nothing yet. */
export function initializerPrompt(goal: string, verifyCommand: string): string {
  return [
    'You are the first session of a long-running project that later sessions will build',
    'one feature at a time. Do not implement any features in this session.',
    '',
    `Goal:\n${goal}`,
    '',
    '1. Study the repository.',
    `2. Write \`${FEATURE_LIST_FILE}\` at the repository root in this shape:`,
    '   {"features": [{"id": "F1", "description": "...", "steps": ["..."], "passes": false}]}',
    '   Split the goal into small features that can each be finished and checked in one',
    '   session, in the order they should be built. Every feature starts with "passes": false.',
    `3. Write \`${PROGRESS_FILE}\`: an overview of the plan, how to check the work with`,
    `   \`${verifyCommand}\`, and anything the next session should know.`,
    '4. Commit both files.',
    '',
    `After every later session the harness runs \`${verifyCommand}\` itself; a feature only`,
    'counts as done when that command succeeds.',
  ].join('\n');
}

/**
 * Every later session of a loop task. `failedVerify` is the harness's own verify output
 * when it failed after the previous session; `note` is a handoff note when the previous
 * session ran out of context mid-feature.
 */
export function loopSessionPrompt(
  goal: string,
  verifyCommand: string,
  failedVerify: VerifyResult | null,
  note: string | null,
  feedback: string | null = null,
): string {
  const lines = [
    'You are continuing a long-running project in this worktree. Each session implements',
    'exactly one feature.',
    '',
    `Goal:\n${goal}`,
    '',
    `1. Read \`${PROGRESS_FILE}\`, \`${FEATURE_LIST_FILE}\` and \`git log --oneline -20\`.`,
    `2. Run \`${verifyCommand}\`. If something that used to work is broken, fix that first.`,
    '3. Pick the first feature with "passes": false and implement it.',
    `4. Run \`${verifyCommand}\`. Set "passes": true for that feature only if it succeeds.`,
    '   Never remove features or change their descriptions or steps.',
    `5. Update \`${PROGRESS_FILE}\` and commit.`,
    '6. Stop after this one feature.',
  ];
  if (failedVerify) {
    const how = failedVerify.timedOut ? 'timed out' : `exited with code ${failedVerify.exitCode}`;
    lines.push(
      '',
      `The harness ran \`${failedVerify.command}\` after the previous session and it ${how}.`,
      'Features marked as passing were not accepted. Fix this before anything else.',
      `Output (tail):\n${failedVerify.output}`,
    );
  }
  if (feedback) lines.push('', feedback);
  if (note) lines.push('', `Handoff note from the previous session:\n${note}`);
  return lines.join('\n');
}
