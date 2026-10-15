// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRole, RoleNote } from '@harnessboard/shared';
import { git } from './worktree.js';

/**
 * The task's notes file, relative to its worktree: every role's report, oldest first. Git
 * ignores it, so it never reaches a commit or the base branch.
 */
export const NOTES_FILE = '.harnessboard/notes.md';

/** Heading of the reply section a role writes for the roles after it. */
export const NOTES_HEADING = '## Notes';

const ROLE_NAMES: Record<AgentRole, string> = {
  spec: 'Spec author',
  designer: 'Designer',
  implementer: 'Implementer',
  tester: 'Tester',
  reviewer: 'Reviewer',
};

const VERDICT_NAMES: Record<NonNullable<RoleNote['verdict']>, string> = {
  pass: 'tests pass',
  fail: 'tests fail',
  approve: 'approved',
  changes: 'changes requested',
};

/** The reply's notes section without its heading, or the whole reply when it has none. */
export function parseNotes(reply: string): string {
  const lines = reply.split('\n');
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === NOTES_HEADING.toLowerCase(),
  );
  if (start === -1) return reply.trim();
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** One note as the notes file and the updates show it, numbered `n`. */
function noteEntry(n: number, { note, at }: { note: RoleNote; at: number }): string[] {
  const time = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  const verdict = note.verdict ? ` · ${VERDICT_NAMES[note.verdict]}` : '';
  return [
    '',
    `## ${n}. ${ROLE_NAMES[note.role]} (${note.agentId})${verdict} · ${time} UTC`,
    '',
    note.text || '(no notes)',
  ];
}

/** The notes file's content for a task; `at` is when each note was recorded. */
export function renderNotes(
  taskId: number,
  title: string,
  notes: { note: RoleNote; at: number }[],
): string {
  const lines = [
    `# Task #${taskId} notes: ${title}`,
    '',
    'Each role on this task reports here, oldest first. The harness writes this file from',
    'its own records before every session, so edits to it are lost.',
  ];
  notes.forEach((entry, i) => lines.push(...noteEntry(i + 1, entry)));
  return lines.join('\n') + '\n';
}

/**
 * The notes added since a role's last turn, for a role that goes on in its own
 * conversation: it already has the earlier ones, so only these are sent.
 */
export function renderNoteUpdates(notes: { note: RoleNote; at: number }[]): string {
  return [
    'New notes from the other roles since your last turn:',
    ...notes.flatMap((entry, i) => noteEntry(i + 1, entry)),
  ].join('\n');
}

/**
 * `reply` without its notes section, which reaches the next role as a note of its own;
 * the same section {@link parseNotes} reads.
 */
export function withoutNotes(reply: string): string {
  const lines = reply.split('\n');
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === NOTES_HEADING.toLowerCase(),
  );
  if (start === -1) return reply.trim();
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  const after = end === -1 ? [] : rest.slice(end);
  return [...lines.slice(0, start), ...after].join('\n').trim();
}

/** What every workflow session is told about the notes file. */
export function notesPrompt(hasNotes: boolean): string {
  return [
    ...(hasNotes
      ? [
          `Before you start, read \`${NOTES_FILE}\`: what the roles before you on this task did,`,
          'decided and want checked. Do not edit it; the harness keeps it.',
        ]
      : []),
    `End your reply with a \`${NOTES_HEADING}\` section for the roles after you: what you did,`,
    'the decisions you made and why, what you are unsure of, and what the next role should check.',
  ].join('\n');
}

/**
 * Writes the notes file into a worktree, first making git ignore it through the
 * repository's `info/exclude` (shared by all its worktrees), so it never shows up as a change.
 */
export async function writeNotes(worktree: string, content: string): Promise<void> {
  const common = path.resolve(
    worktree,
    (await git(worktree, ['rev-parse', '--git-common-dir'])).trim(),
  );
  const exclude = path.join(common, 'info', 'exclude');
  const pattern = `/${path.posix.dirname(NOTES_FILE)}/`;
  let current = '';
  try {
    current = readFileSync(exclude, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!current.split('\n').includes(pattern)) {
    mkdirSync(path.dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${pattern}\n`);
  }
  const file = path.join(worktree, NOTES_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * Writes `content` to `notes.md` in `dir` and returns the prompt section pointing at it, for
 * a reviewer that cannot run shell commands: its read tools skip files git ignores, which
 * hides the notes file in the worktree. Throws when `dir` cannot be written.
 */
export function copyNotes(dir: string, content: string): string {
  const file = path.join(dir, 'notes.md');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, content);
  return [
    `Your read tools skip \`${NOTES_FILE}\` because git ignores it. The harness saved the same`,
    `notes to \`${file}\`: consult it only when a specific ambiguity needs history.`,
  ].join('\n');
}
