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

/**
 * First session of a loop task: plan the work as a feature list, implement nothing yet.
 * Without a verify command the planner proposes one; the user confirms it before building.
 */
export function initializerPrompt(goal: string, verifyCommand: string | null): string {
  const verifyLine = verifyCommand
    ? `The user checks the work with \`${verifyCommand}\`.`
    : 'No check command is set yet: propose one in "verify" (see below).';
  return [
    'You are the planning session of a long-running project that later sessions will build',
    'one feature at a time. Do not implement any features in this session.',
    '',
    `Goal:\n${goal}`,
    '',
    verifyLine,
    '',
    '1. Study the repository.',
    `2. Write \`${FEATURE_LIST_FILE}\` at the repository root in this shape:`,
    '   {"features": [{"id": "F1", "description": "...", "steps": ["..."], "passes": false}],',
    '    "verify": "<command>", "questions": ["..."]}',
    '   - Split the goal into small features that can each be finished and checked in one',
    '     session, in the order they should be built. Every feature starts with "passes": false.',
    '   - "steps" are the acceptance criteria: concrete, observable checks that show the',
    '     feature works, preferably ones an automated test can cover.',
    '   - "verify": one shell command that runs the automated checks without any prompts',
    '     (tests, lint, build). Omit it if a command is already set above.',
    '   - "questions": decisions you need from the user (scope, tools, accounts, trade-offs).',
    '     Leave it empty if nothing is unclear.',
    `3. Write \`${PROGRESS_FILE}\`: an overview of the plan and anything the next session`,
    '   should know.',
    '4. Commit both files.',
    '5. Reply with a short summary of the plan and your questions.',
    '',
    'The user reviews this plan and may ask for changes before any feature is built. After',
    'approval, the harness runs the check command itself after every session; a feature only',
    'counts as done when that command succeeds.',
  ].join('\n');
}

/** Sent to the planning session when the user replies to the plan instead of approving it. */
export function planRevisionPrompt(message: string): string {
  return [
    '[harness] The user reviewed your plan and replied:',
    '',
    message,
    '',
    `Update \`${FEATURE_LIST_FILE}\` and \`${PROGRESS_FILE}\` to match, and commit. Keep ids of`,
    'features that stay; give new ones new ids. Update "questions" to what is still open.',
    'Still do not implement any features. Reply with what you changed, your answers to the',
    "user's points, and any remaining questions.",
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
    '3. Pick the first feature with "passes": false and implement it so its "steps" (the',
    '   acceptance criteria) hold.',
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

/** Heading the discussion session puts its proposed criteria under; see {@link parseCriteria}. */
export const CRITERIA_HEADING = '## Acceptance criteria';

/** The task as every implementer and reviewer sees it: the request plus agreed criteria. */
export function taskGoal(prompt: string, acceptance: string | null): string {
  if (!acceptance) return prompt;
  return [
    prompt,
    '',
    'Acceptance criteria, agreed with the user (the work is done when all of them hold):',
    acceptance,
  ].join('\n');
}

/**
 * First session of a single task that has no agreed criteria yet: a read-only discussion
 * that ends with proposed criteria and questions. `draft` is criteria the user gave.
 */
export function criteriaPrompt(request: string, draft: string | null): string {
  const lines = [
    'Before any work starts on the task below, agree with the user on what "done" means.',
    'This session is read-only: study the repository, but do not change anything.',
    '',
    `Task:\n${request}`,
  ];
  if (draft) lines.push('', `The user's draft acceptance criteria:\n${draft}`);
  lines.push(
    '',
    'Reply in this shape:',
    CRITERIA_HEADING,
    '- One concrete, observable check per line (behaviour, tests that pass, edge cases',
    '  handled). Prefer checks a test or a command can show.',
    '## Questions',
    '- Decisions you need from the user (scope, trade-offs, anything unclear). Leave this',
    '  section out if nothing is unclear.',
    '',
    'Keep it short. The user may reply before approving; nothing is built until then.',
  );
  return lines.join('\n');
}

/** Sent to the discussion session when the user replies instead of approving. */
export function criteriaRevisionPrompt(message: string): string {
  return [
    '[harness] The user read your proposal and replied:',
    '',
    message,
    '',
    'Answer their points and reply with the revised proposal in the same shape, starting with',
    `\`${CRITERIA_HEADING}\`. This session is still read-only.`,
  ].join('\n');
}

/** Sent when resuming the discussion session after the user approved the criteria. */
export function criteriaApprovedPrompt(criteria: string): string {
  return [
    '[harness] The user approved these acceptance criteria:',
    '',
    criteria,
    '',
    'You may now change files. Implement the task so that every criterion holds, check them',
    'as far as you can, and commit your work.',
  ].join('\n');
}

/**
 * The criteria section of a discussion reply: the lines under {@link CRITERIA_HEADING} up
 * to the next heading of the same level, without a closing remark after the list (a
 * paragraph that is not a list item, after a blank line); `null` when there is no such
 * section or it is empty.
 */
export function parseCriteria(reply: string): string | null {
  const lines = reply.split('\n');
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === CRITERIA_HEADING.toLowerCase(),
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  const blocks = section.split(/\n\s*\n/);
  const listed = (block: string) => /^\s*([-*+]|\d+[.)]|#)/.test(block);
  while (blocks.length > 1 && !listed(blocks.at(-1)!)) blocks.pop();
  return blocks.join('\n\n').trim() || null;
}

/** Sent as a user message to compact the conversation; the CLI runs it as its own turn. */
export const COMPACT_COMMAND = '/compact';

/**
 * A session that finishes merging the task's base into its branch: the harness has started
 * the merge, so the worktree holds conflict markers in `files`.
 */
export function mergeConflictPrompt(goal: string, base: string, files: string[]): string {
  return [
    `[harness] The user wants to merge this branch into \`${base}\`, but \`${base}\` has`,
    'changed in ways that conflict with it. The harness has started `git merge` of',
    `\`${base}\` in this worktree. These files have conflicts:`,
    ...files.map((file) => `- ${file}`),
    '',
    `Resolve every conflict so that both this task's changes and the changes on \`${base}\``,
    'keep working, and run the checks you can. Then `git add` the files and `git commit` to',
    'finish the merge. Do not abort the merge or rewrite history.',
    '',
    `The task this branch was made for:\n${goal}`,
  ].join('\n');
}
