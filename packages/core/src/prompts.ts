// SPDX-License-Identifier: Apache-2.0

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
 * or `null` when that session was cut off before writing one.
 */
export function continuationPrompt(originalPrompt: string, note: string | null): string {
  const handoff = note
    ? `Handoff note from the previous session:\n${note}`
    : 'The previous session was cut off before it wrote a handoff note.';
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
