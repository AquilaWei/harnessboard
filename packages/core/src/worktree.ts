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
    return await gitRaw(cwd, args);
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

/**
 * Paths whose content differs from commit `head`, committed or not, plus untracked files.
 * Renames count as the old path removed and the new one added.
 */
export async function changedPaths(dir: string, head: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(dir, ['diff', '--name-only', '--no-renames', head]),
    git(dir, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...tracked.split('\n'), ...untracked.split('\n')].filter((p) => p !== '');
}

/** Commit where HEAD branched off `ref`. */
export async function mergeBase(dir: string, ref: string): Promise<string> {
  return (await git(dir, ['merge-base', ref, 'HEAD'])).trim();
}

/** Like {@link git}, but a non-zero exit is returned, not thrown, for commands that use it. */
async function gitExit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    return { code: 0, stdout: await gitRaw(cwd, args) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message: string };
    if (typeof e.code !== 'number') throw err;
    return { code: e.code, stdout: e.stdout ?? '' };
  }
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * The tree of merging `branch` into `base`, computed without touching any worktree
 * (`git merge-tree`, git 2.38 or later), or the paths that conflict.
 */
export async function mergeTree(
  repo: string,
  base: string,
  branch: string,
): Promise<{ tree: string } | { conflicts: string[] }> {
  const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, branch];
  const { code, stdout } = await gitExit(repo, args);
  const [tree = '', ...paths] = stdout.split('\n').filter(Boolean);
  if (code === 0) return { tree };
  if (code === 1) return { conflicts: paths };
  throw new Error(`git merge-tree failed (exit ${code}); it needs git 2.38 or later`);
}

/** Creates a commit object for `tree` with the given parents; no ref moves. */
export async function commitTree(
  repo: string,
  tree: string,
  parents: string[],
  message: string,
): Promise<string> {
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message];
  return (await git(repo, args)).trim();
}

/** Commit a ref points at; throws when it does not exist. */
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}

/** True when `ref` is a local branch name. */
export async function isLocalBranch(repo: string, ref: string): Promise<boolean> {
  const { code } = await gitExit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]);
  return code === 0;
}

/** The worktree that has `branch` checked out, or `null` when none has. */
export async function worktreeOfBranch(repo: string, branch: string): Promise<string | null> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n');
    const dir = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (dir && lines.includes(`branch refs/heads/${branch}`)) return path.resolve(dir);
  }
  return null;
}

/**
 * Moves `branch` from `from` to `to`, where `to` descends from `from`. A worktree that has
 * the branch checked out is fast-forwarded, which updates its files and refuses when local
 * changes would be overwritten; otherwise only the ref moves, and only if it is still at
 * `from`. Throws when either refuses.
 */
export async function advanceBranch(
  repo: string,
  branch: string,
  from: string,
  to: string,
): Promise<void> {
  const checkedOut = await worktreeOfBranch(repo, branch);
  if (checkedOut) await git(checkedOut, ['merge', '--ff-only', to]);
  else await git(repo, ['update-ref', `refs/heads/${branch}`, to, from]);
}

/**
 * Starts merging `ref` into the worktree's branch and leaves the result uncommitted, with
 * conflict markers in the conflicting files, for an agent to resolve and commit.
 */
export async function startMerge(dir: string, ref: string): Promise<void> {
  const { code } = await gitExit(dir, ['merge', '--no-ff', '--no-commit', ref]);
  // 1 means conflicts, which is what this is for; anything else is a real failure.
  if (code !== 0 && code !== 1) throw new Error(`git merge ${ref} failed (exit ${code})`);
}

/**
 * Deletes `branch` once it is fully merged into `into`; throws when it is not. (`branch -d`
 * would check against the repository's current branch instead, which may be another one.)
 */
export async function deleteMergedBranch(
  repo: string,
  branch: string,
  into: string,
): Promise<void> {
  const { code } = await gitExit(repo, ['merge-base', '--is-ancestor', branch, into]);
  if (code !== 0) throw new Error(`branch ${branch} is not merged into ${into}`);
  await git(repo, ['branch', '-D', branch]);
}

/** True when every commit of `ref` is already in `into`. */
export async function isMergedInto(repo: string, ref: string, into: string): Promise<boolean> {
  const { code } = await gitExit(repo, ['merge-base', '--is-ancestor', ref, into]);
  return code === 0;
}
