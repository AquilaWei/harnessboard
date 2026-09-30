// SPDX-License-Identifier: Apache-2.0
import type { VerifyResult } from '@harnessboard/shared';

export const VERDICT_APPROVE = 'VERDICT: APPROVE';
export const VERDICT_CHANGES = 'VERDICT: CHANGES';

export type Verdict = 'approve' | 'changes';

/**
 * Stored as the `review_request` event when an implementer step is ready for review.
 * `head` and `status` record the worktree the reviewer is given, so any change it makes
 * can be detected.
 */
export interface ReviewRequest {
  round: number;
  /** Commit the reviewer diffs against: the last approved head, or the task's base. */
  since: string;
  head: string;
  /** `git status --porcelain` output at request time. */
  status: string;
}

/** Stored as the `review` event after a reviewer session. */
export interface ReviewRecord {
  round: number;
  agentId: string;
  /** `null` when the reply had no verdict line; the task then goes to a human. */
  verdict: Verdict | null;
  /** The reviewer's reply without the verdict line. */
  findings: string;
  head: string;
}

/** Reads the verdict from the first line of a reviewer's reply; `null` when there is none. */
export function parseVerdict(reply: string): { verdict: Verdict | null; findings: string } {
  const [first = '', ...rest] = reply.trimStart().split('\n');
  const line = first.trim().toUpperCase();
  const verdict = line.startsWith(VERDICT_APPROVE)
    ? 'approve'
    : line.startsWith(VERDICT_CHANGES)
      ? 'changes'
      : null;
  return { verdict, findings: (verdict ? rest.join('\n') : reply).trim() };
}

/** First message of a reviewer session. It runs read-only in the implementer's worktree. */
export function reviewPrompt(
  goal: string,
  request: ReviewRequest,
  verify: VerifyResult | null,
): string {
  const lines = [
    'You are reviewing work another agent did in this repository. You cannot edit files;',
    'your job is to decide whether the work is correct and complete.',
    '',
    `Task given to the implementer:\n${goal}`,
    '',
    `Review everything between ${request.since} and HEAD:`,
    `- \`git log --oneline ${request.since}..HEAD\` and \`git diff ${request.since}..HEAD\``,
    '- `git status` for anything left uncommitted',
    'Read the surrounding code where you need context.',
  ];
  if (verify) {
    lines.push('', `The harness ran \`${verify.command}\` after this step and it passed.`);
  }
  lines.push(
    '',
    'Check correctness, missing tests, edge cases, and anything the task asked for that is',
    'not done. Ignore style that a formatter would settle.',
    '',
    `Make the first line of your reply exactly \`${VERDICT_APPROVE}\` or \`${VERDICT_CHANGES}\`.`,
    `After ${VERDICT_CHANGES}, list each required change with the file and what to do,`,
    'most important first. Only request changes that matter; the implementer gets your list.',
  );
  return lines.join('\n');
}

/** Section added to the implementer's next prompt when the reviewer asked for changes. */
export function reviewFeedback(record: ReviewRecord): string {
  return [
    `A reviewer (${record.agentId}) checked your last step and requested changes.`,
    'Address every point before anything else, run the checks again, and commit:',
    record.findings,
  ].join('\n');
}
