// SPDX-License-Identifier: Apache-2.0
import type {
  ReviewRecord,
  ReviewRequest,
  TestReport,
  TestRequest,
  Verdict,
  VerifyResult,
} from '@harnessboard/shared';

export const VERDICT_APPROVE = 'VERDICT: APPROVE';
export const VERDICT_CHANGES = 'VERDICT: CHANGES';

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

/**
 * First message of a reviewer session. It runs read-only in the implementer's worktree.
 * `goal` includes the task's acceptance criteria when `hasCriteria` is true.
 */
export function reviewPrompt(
  goal: string,
  request: ReviewRequest,
  verify: VerifyResult | null,
  hasCriteria = false,
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
    'not done, including the README, changelog and docs the change makes wrong or stale.',
    'Ignore style that a formatter would settle.',
    ...(hasCriteria
      ? ['Check every acceptance criterion; one that does not hold is a required change.']
      : []),
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

export const TESTS_PASS = 'TESTS: PASS';
export const TESTS_FAIL = 'TESTS: FAIL';

/** Reads the verdict from the first line of a tester's reply; `null` when there is none. */
export function parseTestVerdict(reply: string): {
  verdict: TestReport['verdict'];
  findings: string;
} {
  const [first = '', ...rest] = reply.trimStart().split('\n');
  const line = first.trim().toUpperCase();
  const verdict = line.startsWith(TESTS_PASS)
    ? 'pass'
    : line.startsWith(TESTS_FAIL)
      ? 'fail'
      : null;
  return { verdict, findings: (verdict ? rest.join('\n') : reply).trim() };
}

/** True for a path the tester may change: a test directory or a `*.test.*` / `*_test.*` file. */
export function isTestPath(file: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|specs)\//i.test(file) || /[._-](test|spec)\.[^/]+$/i.test(file)
  );
}

/**
 * First message of a tester session. It edits test files only, in the implementer's
 * worktree, and ends with a verdict the harness reads.
 */
export function testPrompt(
  goal: string,
  request: TestRequest,
  verifyCommand: string | null,
  hasCriteria: boolean,
): string {
  const lines = [
    'You are the tester for work another agent did in this repository. Decide whether it',
    'works, by writing the tests it is missing and running them.',
    '',
    `Task given to the implementer:\n${goal}`,
    '',
    `The implementer's work is everything between ${request.since} and HEAD:`,
    `- \`git log --oneline ${request.since}..HEAD\` and \`git diff ${request.since}..HEAD\``,
    '- `git status` for anything left uncommitted',
    '',
    hasCriteria
      ? 'Make sure every acceptance criterion is covered by a test that would fail without it.'
      : 'Make sure the behaviour the task asked for is covered by tests that would fail without it.',
    'Add or extend tests, then run the whole test suite' +
      (verifyCommand ? ` (\`${verifyCommand}\`)` : '') +
      ' and commit the tests you wrote.',
    'You may change test files only (test directories, `*.test.*`, `*.spec.*`). Do not touch',
    'the implementation or the docs (the implementer owns both): if a test shows a bug,',
    'report it instead of fixing it.',
    '',
    `Make the first line of your reply exactly \`${TESTS_PASS}\` or \`${TESTS_FAIL}\`.`,
    `Use ${TESTS_FAIL} when the suite fails or a criterion has no passing test. After it, list`,
    'each failure or bug with the test, the command to reproduce it and what is wrong.',
  ];
  return lines.join('\n');
}

/** Section added to the implementer's next prompt when the tester reported failures. */
export function testFeedback(report: TestReport): string {
  return [
    `A tester (${report.agentId}) checked your last step and reported failures.`,
    'Fix every one before anything else, run the tests again, and commit:',
    report.findings,
  ].join('\n');
}
