// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CommitInfo, WorktreeDiff } from '@harnessboard/shared';

const execFileAsync = promisify(execFile);

/**
 * Runs git without a shell. `core.longpaths` is passed per call so deep worktrees work on
 * Windows without changing the user's repository config.
 * Throws with git's stderr when the command fails.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.longpaths=true', ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.trim() || e.message}`);
  }
}

/** Absolute repository root containing `dir`; throws when `dir` is not in a git repo. */
export async function repoRoot(dir: string): Promise<string> {
  return path.resolve((await git(dir, ['rev-parse', '--show-toplevel'])).trim());
}

/** Current branch name, or the commit hash when HEAD is detached. */
export async function currentRef(repo: string): Promise<string> {
  const ref = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return ref === 'HEAD' ? (await git(repo, ['rev-parse', 'HEAD'])).trim() : ref;
}

export function branchName(taskId: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  return slug ? `hb/${taskId}-${slug}` : `hb/${taskId}`;
}

/**
 * Worktree location kept short (hash of the repo path + task id) because Windows paths
 * are limited to 260 characters by default.
 */
export function worktreePath(dataDir: string, repo: string, taskId: number): string {
  const repoHash = createHash('sha256').update(repo).digest('hex').slice(0, 8);
  return path.join(dataDir, 'wt', `${repoHash}-${taskId}`);
}

export async function addWorktree(
  repo: string,
  dir: string,
  branch: string,
  baseRef: string,
): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, dir, baseRef]);
}

/** Removes the worktree directory but keeps its branch, so the work can still be merged. */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir]);
}

/** Forgets worktrees whose directories were deleted by hand. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune']);
}

/** Everything the task changed relative to its base. Read-only: never touches the index. */
export async function worktreeDiff(dir: string, baseRef: string): Promise<WorktreeDiff> {
  const mergeBase = (await git(dir, ['merge-base', baseRef, 'HEAD'])).trim();
  const [diff, untracked] = await Promise.all([
    git(dir, ['diff', mergeBase]),
    git(dir, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return { diff, untracked: untracked.split('\n').filter(Boolean) };
}

// Unit and record separators cannot appear in a one-line subject or an author name.
const FIELD = '\x1f';
const RECORD = '\x1e';

/** Commits on HEAD since it branched off `baseRef`, newest first. */
export async function commitLog(dir: string, baseRef: string): Promise<CommitInfo[]> {
  const base = await mergeBase(dir, baseRef);
  const out = await git(dir, [
    'log',
    `--format=%H${FIELD}%an${FIELD}%at${FIELD}%s${RECORD}`,
    `${base}..HEAD`,
  ]);
  return out
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', author = '', at = '0', subject = ''] = record.split(FIELD);
      return { hash, author, subject, ts: Number(at) * 1000 };
    });
}

/** Full message, file summary and patch of one commit. `hash` must be a full commit id. */
export async function commitDiff(dir: string, hash: string): Promise<string> {
  return git(dir, ['show', '--stat', '--patch', '--format=%B', hash]);
}

/** Commit hash of HEAD. */
export async function headCommit(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

/** `git status --porcelain` output; empty when the worktree is clean. */
export async function porcelainStatus(dir: string): Promise<string> {
  return git(dir, ['status', '--porcelain']);
}

/** Commit where HEAD branched off `ref`. */
export async function mergeBase(dir: string, ref: string): Promise<string> {
  return (await git(dir, ['merge-base', ref, 'HEAD'])).trim();
}
