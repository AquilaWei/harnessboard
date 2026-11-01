// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CacheCleanup, Task } from '@harnessboard/shared';
import { git, worktreePath } from './worktree.js';

const manifests: Record<string, string[]> = {
  target: ['Cargo.toml'],
  node_modules: ['package.json'],
  '.venv': ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
};

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inspect(dir: string): Promise<number> {
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) throw new Error('Contains a symbolic link');
  if (!stat.isDirectory()) return stat.size;
  let bytes = 0;
  for (const entry of await readdir(dir)) {
    if (entry === '.git') throw new Error('Contains a nested Git workspace');
    bytes += await inspect(path.join(dir, entry));
  }
  return bytes;
}

/** Only managed, ignored dependency caches qualify; execution always discovers paths again. */
export async function cleanTaskCaches(
  task: Task,
  dataDir: string,
  execute = false,
): Promise<CacheCleanup> {
  const result: CacheCleanup = { entries: [], estimatedBytes: 0, removedBytes: 0 };
  if (task.workspace !== 'worktree' || !task.worktreePath) return result;
  const root = path.resolve(task.worktreePath);
  const expected = worktreePath(dataDir, task.repoPath, task.id);
  if (
    root !== expected &&
    !new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r[0-9]+$`).test(root)
  ) {
    throw new Error('Not a Harness managed worktree');
  }
  if (!(await exists(root))) return result;
  if ((await realpath(root)) !== root) throw new Error('Worktree path contains a symbolic link');
  if (path.resolve((await git(root, ['rev-parse', '--show-toplevel'])).trim()) !== root)
    throw new Error('Invalid worktree root');
  const repoCommon = path.resolve(
    task.repoPath,
    (await git(task.repoPath, ['rev-parse', '--git-common-dir'])).trim(),
  );
  const treeCommon = path.resolve(
    root,
    (await git(root, ['rev-parse', '--git-common-dir'])).trim(),
  );
  if (repoCommon !== treeCommon) throw new Error('Worktree does not belong to the task repository');
  const tracked = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    if (dir !== root && entries.some((e) => e.name === '.git')) return;
    for (const entry of entries) {
      if (['.git', 'dist', 'build', 'reports', 'artifacts'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const markers = Object.hasOwn(manifests, entry.name) ? manifests[entry.name] : undefined;
      if (markers) {
        if (!(await Promise.all(markers.map((m) => exists(path.join(dir, m))))).some(Boolean))
          continue;
        const relative = path.relative(root, full).split(path.sep).join('/');
        const item: CacheCleanup['entries'][number] = {
          path: relative,
          bytes: 0,
          status: 'candidate',
        };
        result.entries.push(item);
        let removing = false;
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error('Not a regular directory');
          if (tracked.some((p) => p === relative || p.startsWith(`${relative}/`)))
            throw new Error('Contains tracked files');
          if (!(await git(root, ['check-ignore', '--no-index', '--', `${relative}/`])).trim())
            throw new Error('Directory is not ignored');
          if (
            (await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', relative]))
              .length
          )
            throw new Error('Contains files that are not ignored');
          item.bytes = await inspect(full);
          result.estimatedBytes += item.bytes;
          if (execute) {
            removing = true;
            await rm(full, { recursive: true });
            item.status = 'removed';
            result.removedBytes += item.bytes;
          }
        } catch (error) {
          item.status = removing ? 'failed' : 'skipped';
          item.reason = (error as Error).message;
        }
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(full);
      }
    }
  }
  await visit(root);
  return result;
}
