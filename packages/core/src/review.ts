// SPDX-License-Identifier: Apache-2.0
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Feature,
  ReviewRecord,
  ReviewRequest,
  TestReport,
  TestRequest,
  Verdict,
  VerifyResult,
} from '@harnessboard/shared';
import type { Guideline } from './guidelines.js';
import { git } from './worktree.js';

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

/** What a review is checked against besides the task itself. */
export interface ReviewContext {
  /** The harness's verify run of a loop step. */
  verify?: VerifyResult | null;
  /** True when `goal` includes acceptance criteria. */
  hasCriteria?: boolean;
  /**
   * A loop task's feature list: the step is judged on the features marked done, since the
   * rest are built in later steps and would otherwise be held against every step.
   */
  features?: Feature[] | null;
  /** The user's rules (`reviewGuidelines`), checked like the task's own requirements. */
  guidelines?: Guideline[];
}

/**
 * Lines naming a `base` task's earlier stretches of work, which the agent checks as well;
 * the commits between them are other work in the folder and are left out.
 */
function earlierWork(request: ReviewRequest | TestRequest): string[] {
  const spans = request.earlier ?? [];
  if (spans.length === 0) return [];
  return [
    "- the task's earlier work, one stretch each (the commits between them are not its work):",
    ...spans.map(
      ({ from, to }) => `  - \`git log --oneline ${from}..${to}\` and \`git diff ${from}..${to}\``,
    ),
  ];
}

/** First message of a reviewer session. It runs read-only in the implementer's worktree. */
export function reviewPrompt(
  goal: string,
  request: ReviewRequest,
  { verify = null, hasCriteria = false, features = null, guidelines = [] }: ReviewContext = {},
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
    ...earlierWork(request),
    'Read the surrounding code where you need context.',
  ];
  if (verify) {
    lines.push('', `The harness ran \`${verify.command}\` after this step and it passed.`);
  }
  if (features) lines.push('', ...stepScope(features));
  lines.push(
    '',
    features
      ? 'Check correctness, missing tests, edge cases, and anything the done features need that is'
      : 'Check correctness, missing tests, edge cases, and anything the task asked for that is',
    'not done, including the README, changelog and docs the change makes wrong or stale.',
    'Ignore style that a formatter would settle.',
    ...(hasCriteria
      ? ['Check every acceptance criterion; one that does not hold is a required change.']
      : []),
    ...guidelinesSection(guidelines),
    '',
    `Make the first line of your reply exactly \`${VERDICT_APPROVE}\` or \`${VERDICT_CHANGES}\`.`,
    `After ${VERDICT_CHANGES}, list each required change with the file and what to do,`,
    'most important first. Only request changes that matter; the implementer gets your list.',
  );
  return lines.join('\n');
}

/**
 * Message to a reviewer that is resumed for its next round: it already has the task and its
 * own findings, so it only hears what changed since `reviewedHead`, the head it judged.
 */
export function reviewFollowUpPrompt(request: ReviewRequest, reviewedHead: string): string {
  return [
    'The implementer answered your requested changes. This is review round ' +
      `${request.round}; you still have the task and your earlier findings.`,
    '',
    `Check what changed since you last reviewed (${reviewedHead}):`,
    `- \`git log --oneline ${reviewedHead}..HEAD\` and \`git diff ${reviewedHead}..HEAD\``,
    '- `git status` for anything left uncommitted',
    ...earlierWork(request),
    'Confirm each of your earlier findings is fixed, and look for problems the new changes add.',
    '',
    `Make the first line of your reply exactly \`${VERDICT_APPROVE}\` or \`${VERDICT_CHANGES}\`.`,
    `After ${VERDICT_CHANGES}, list each required change with the file and what to do.`,
  ].join('\n');
}

/**
 * Characters of git output {@link reviewEvidence} quotes in a prompt, shared by all its
 * commands, so a large change does not bury the review instructions. Output past it is
 * only in the evidence files.
 */
export const EVIDENCE_INLINE_LIMIT = 12_000;

/**
 * The output of the git commands {@link reviewPrompt} names, for a reviewer whose CLI
 * cannot run them in a read-only session (see `AgentCapabilities.readOnlyGit`): the log,
 * file summary and patch of the current stretch and of each earlier one, `git status` and
 * the uncommitted changes. Every output is written whole to its own file in `outDir`,
 * which is emptied first and has to be readable by the session (`SessionSpec.readableDirs`);
 * the returned prompt section quotes the outputs that fit {@link EVIDENCE_INLINE_LIMIT} and
 * names the file of each, so nothing is lost when the patches are large. Throws when git
 * fails in `dir` or `outDir` cannot be written.
 */
export async function reviewEvidence(
  dir: string,
  request: ReviewRequest,
  outDir: string,
): Promise<string> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  let budget = EVIDENCE_INLINE_LIMIT;
  const block = async (command: string, file: string, output: string): Promise<string[]> => {
    const text = output.trimEnd() || '(no output)';
    const where = path.join(outDir, file);
    await writeFile(where, `$ ${command}\n${text}\n`);
    if (text.length > budget) {
      const lines = text.split('\n').length;
      return [
        `$ ${command}`,
        `(${lines} lines, too long to quote here: read all of \`${where}\`, in parts if needed)`,
      ];
    }
    budget -= text.length;
    return [`$ ${command}`, `(also in \`${where}\`)`, '```', text, '```'];
  };
  const span = async (from: string, to: string, name: string): Promise<string[]> => {
    const range = `${from}..${to}`;
    const [log, stat, diff] = await Promise.all([
      git(dir, ['log', '--oneline', range]),
      git(dir, ['diff', '--stat', range]),
      git(dir, ['diff', range]),
    ]);
    return [
      ...(await block(`git log --oneline ${range}`, `${name}-log.txt`, log)),
      ...(await block(`git diff --stat ${range}`, `${name}-stat.txt`, stat)),
      ...(await block(`git diff ${range}`, `${name}-diff.txt`, diff)),
    ];
  };
  const lines = [
    'You cannot run shell commands in this session, so the harness ran the git commands',
    'above for you and saved each output whole to a file you can read. What fits is quoted',
    'below; read the files for the rest, and use your read tools for the surrounding code.',
    '',
    ...(await span(request.since, 'HEAD', 'current')),
  ];
  // `git diff HEAD` adds what `git status` alone does not show: the uncommitted edits.
  const [status, uncommitted] = await Promise.all([
    git(dir, ['status', '--porcelain']),
    git(dir, ['diff', 'HEAD']),
  ]);
  lines.push(...(await block('git status --porcelain', 'status.txt', status)));
  if (uncommitted.trim()) {
    lines.push(...(await block('git diff HEAD', 'uncommitted-diff.txt', uncommitted)));
  }
  for (const [i, { from, to }] of (request.earlier ?? []).entries()) {
    lines.push(...(await span(from, to, `earlier-${i + 1}`)));
  }
  return lines.join('\n');
}

/** The user's rules, quoted whole, so any agent CLI reviews by them without loading anything. */
function guidelinesSection(guidelines: Guideline[]): string[] {
  if (guidelines.length === 0) return [];
  return [
    '',
    'Also review against the rules below, which the user set for all work. Something the',
    'change does that breaks a rule is a required change. Where the rules say how to review',
    '(an order to check in, how to mark minor points), follow them.',
    ...guidelines.flatMap((g) => [
      '',
      `===== ${g.file} =====`,
      g.text.trim(),
      `===== end of ${g.file} =====`,
    ]),
  ];
}

/** What a loop step is reviewed on: the features done so far, not the ones still to come. */
function stepScope(features: Feature[]): string[] {
  const line = (f: Feature) => `- ${f.id}: ${f.description}`;
  const done = features.filter((f) => f.passes);
  const later = features.filter((f) => !f.passes);
  return [
    'This task is built one feature at a time; this review covers the latest step.',
    'Features marked done, which must work and be tested:',
    ...(done.length > 0 ? done.map(line) : ['- (none)']),
    ...(later.length > 0
      ? [
          'Features still to come are built in later steps. Do not request them, and do not',
          'hold their open questions against this step:',
          ...later.map(line),
        ]
      : []),
  ];
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
    ...earlierWork(request),
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
