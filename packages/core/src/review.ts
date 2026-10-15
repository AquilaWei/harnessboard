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
import { withoutNotes } from './notes.js';
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
  /**
   * The feature list as a resumed reviewer last saw it: unchanged features are then named by
   * id only. `null` lists them all again, for a conversation that may have lost them.
   */
  known?: Feature[] | null;
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

/** How a reviewer hands test ideas to the implementer, who owns the tests. */
const REVIEWER_TESTS =
  'A missing test the work needs is a required change for the implementer; other test ideas go in your Notes for the implementer to decide on.';

/** First message of a reviewer session. It runs read-only in the implementer's worktree. */
export function reviewPrompt(
  goal: string,
  request: ReviewRequest,
  { verify = null, hasCriteria = false, features = null, guidelines = [] }: ReviewContext = {},
): string {
  const lines = [
    'You are reviewing work another agent did in this repository. You cannot edit files;',
    'your job is to check architecture, implementation logic, edge cases and code rule compliance.',
    'Inspect test coverage statically. Formal verification belongs to the tester; do not rerun tests, lint or builds.',
    REVIEWER_TESTS,
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
export function reviewFollowUpPrompt(
  request: ReviewRequest,
  reviewedHead: string,
  { features = null, verify = null, known = null }: ReviewContext = {},
): string {
  return [
    'The implementer finished another step. This is review round ' +
      `${request.round}; you still have the task and your earlier findings.`,
    '',
    `Check what changed since you last reviewed (${reviewedHead}):`,
    `- \`git log --oneline ${reviewedHead}..HEAD\` and \`git diff ${reviewedHead}..HEAD\``,
    '- `git status` for anything left uncommitted',
    ...earlierWork(request),
    ...(features ? ['', ...followUpScope(features, known)] : []),
    ...(verify?.ok
      ? ['', `The harness ran \`${verify.command}\` after this step and it passed.`]
      : []),
    'Confirm each of your earlier findings is fixed, and look for problems the new changes add.',
    'Focus on architecture, logic and code rules. Inspect tests statically; do not rerun tests, lint or builds.',
    REVIEWER_TESTS,
    '',
    `Make the first line of your reply exactly \`${VERDICT_APPROVE}\` or \`${VERDICT_CHANGES}\`.`,
    `After ${VERDICT_CHANGES}, list each required change with the file and what to do.`,
  ].join('\n');
}

/** A tester keeps its earlier tests and findings; only changed work needs a new examination. */
export function testFollowUpPrompt(
  request: TestRequest,
  testedHead: string,
  verifyCommand: string | null,
  features: Feature[] | null = null,
  known: Feature[] | null = null,
): string {
  return [
    `Continue testing this task in your own conversation (round ${request.round}).`,
    `Check \`git diff ${testedHead}..HEAD\` and \`git status\` for the latest changes.`,
    ...earlierWork(request),
    ...(features ? followUpScope(features, known) : []),
    'Recheck your earlier findings, regressions, and that every acceptance criterion has a test.',
    TESTER_HANDS_OFF,
    ...(verifyCommand ? [`Run \`${verifyCommand}\`.`] : []),
    `Make the first line of your reply exactly \`${TESTS_PASS}\` or \`${TESTS_FAIL}\`.`,
    'On failure, list each required fix with the file and what to do.',
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

/**
 * {@link stepScope} for a role that already has the list from an earlier round (`known`):
 * features that are new or changed since then are described, the rest named by id.
 */
function followUpScope(features: Feature[], known: Feature[] | null): string[] {
  if (!known) return stepScope(features);
  const before = new Map(known.map((f) => [f.id, f]));
  const changed = (f: Feature) => {
    const was = before.get(f.id);
    return !was || was.passes !== f.passes || was.description !== f.description;
  };
  const line = (f: Feature) => `- ${f.id}: ${f.description}`;
  const ids = (list: Feature[]) => list.map((f) => f.id).join(', ');
  const done = features.filter((f) => f.passes);
  const later = features.filter((f) => !f.passes);
  const newlyDone = done.filter(changed);
  const doneBefore = done.filter((f) => !changed(f));
  const laterNew = later.filter(changed);
  const laterKnown = later.filter((f) => !changed(f));
  return [
    'This task is built one feature at a time; this round covers the latest step.',
    'Features newly marked done, which must work and be tested:',
    ...(newlyDone.length > 0 ? newlyDone.map(line) : ['- (none)']),
    ...(doneBefore.length > 0 ? [`Done before, and must still work: ${ids(doneBefore)}.`] : []),
    ...(later.length > 0
      ? [
          'Features still to come are built in later steps. Do not request them, and do not',
          'hold their open questions against this step:',
          ...laterNew.map(line),
          ...(laterKnown.length > 0 ? [`- ${ids(laterKnown)}, as listed before`] : []),
        ]
      : []),
  ];
}

/** Section added to the implementer's next prompt when the reviewer asked for changes. */
export function reviewFeedback(record: ReviewRecord): string {
  return [
    `A reviewer (${record.agentId}) checked your last step and requested changes.`,
    'Address every point before anything else, run the checks again, and commit:',
    withoutNotes(record.findings),
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

/**
 * The tester's limits, in every prompt it gets. Tests belong to the implementer, so the
 * reports of both other roles reach it as handoffs, and it decides what to add.
 */
const TESTER_HANDS_OFF = [
  'Do not write, change or commit any file: the implementer owns the code, the tests and',
  'the docs, and the task stops if you change one. Build outputs your test run leaves in',
  'ignored folders are fine. Tests you think worth adding beyond the criteria go in your',
  'Notes for the implementer to decide on.',
].join('\n');

/**
 * First message of a tester session. It runs the implementer's tests in the implementer's
 * worktree without changing any file, and ends with a verdict the harness reads.
 */
export function testPrompt(
  goal: string,
  request: TestRequest,
  verifyCommand: string | null,
  hasCriteria: boolean,
  features: Feature[] | null = null,
): string {
  const lines = [
    'You are the tester for work another agent did in this repository. Decide whether it',
    'works, by running the tests the implementer wrote.',
    '',
    `Task given to the implementer:\n${goal}`,
    '',
    `The implementer's work is everything between ${request.since} and HEAD:`,
    `- \`git log --oneline ${request.since}..HEAD\` and \`git diff ${request.since}..HEAD\``,
    '- `git status` for anything left uncommitted',
    ...earlierWork(request),
    '',
    ...(features ? stepScope(features) : []),
    'Run the whole test suite' + (verifyCommand ? ` (\`${verifyCommand}\`)` : '') + '.',
    hasCriteria
      ? 'Check that every acceptance criterion is covered by a test that would fail without it.'
      : 'Check that the behaviour the task asked for is covered by tests that would fail without it.',
    TESTER_HANDS_OFF,
    '',
    `Make the first line of your reply exactly \`${TESTS_PASS}\` or \`${TESTS_FAIL}\`.`,
    `Use ${TESTS_FAIL} when the suite fails or a criterion has no test. After it, list each`,
    'failure with the test, the command to reproduce it and what is wrong, and each missing',
    'test with the criterion it must cover.',
  ];
  return lines.join('\n');
}

/** Section added to the implementer's next prompt when the tester reported failures. */
export function testFeedback(report: TestReport): string {
  return [
    `A tester (${report.agentId}) checked your last step and reported failures.`,
    'Fix every one, adding the tests it names as missing, before anything else; run the',
    'tests again and commit:',
    withoutNotes(report.findings),
  ].join('\n');
}
