// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeDiff } from '@harnessboard/shared';

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

/** Everything the task changed relative to its base. Read-only: never touches the index. */
export async function worktreeDiff(dir: string, baseRef: string): Promise<WorktreeDiff> {
  const mergeBase = (await git(dir, ['merge-base', baseRef, 'HEAD'])).trim();
  const [diff, untracked] = await Promise.all([
    git(dir, ['diff', mergeBase]),
    git(dir, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return { diff, untracked: untracked.split('\n').filter(Boolean) };
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
