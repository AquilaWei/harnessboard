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
  notes.forEach(({ note, at }, i) => {
    const time = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
    const verdict = note.verdict ? ` · ${VERDICT_NAMES[note.verdict]}` : '';
    lines.push(
      '',
      `## ${i + 1}. ${ROLE_NAMES[note.role]} (${note.agentId})${verdict} · ${time} UTC`,
      '',
      note.text || '(no notes)',
    );
  });
  return lines.join('\n') + '\n';
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
