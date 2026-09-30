// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FolderInfo, FolderListing } from '@harnessboard/shared';
import { git, repoRoot } from './worktree.js';

/** Expands a leading `~`, which shells do but Node and browsers do not. */
export function expandHome(dir: string): string {
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return path.join(os.homedir(), dir.slice(2));
  return dir;
}

/** Whether `dir` exists and which git repository, if any, it belongs to. Never throws. */
export async function inspectFolder(dir: string): Promise<FolderInfo> {
  const abs = path.resolve(expandHome(dir.trim()));
  if (!isDirectory(abs)) return { path: abs, exists: false, repoRoot: null, hasCommits: false };
  const root = await repoRoot(abs).catch(() => null);
  const hasCommits =
    root !== null &&
    (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
      () => true,
      () => false,
    ));
  return { path: abs, exists: true, repoRoot: root, hasCommits };
}

/**
 * The repository root a task at `dir` works in.
 * Throws an explanation when the folder is missing, not in a repository, or has no commits.
 */
export async function resolveRepository(dir: string): Promise<string> {
  const info = await inspectFolder(dir);
  if (!info.exists) throw new Error(`folder not found: ${info.path}`);
  if (!info.repoRoot) {
    throw new Error(
      `${info.path} is not inside a git repository. Run "git init" there and make a first commit, or choose another folder.`,
    );
  }
  if (!info.hasCommits) {
    throw new Error(
      `the git repository at ${info.repoRoot} has no commits yet. Make a first commit, so tasks have something to branch from.`,
    );
  }
  return info.repoRoot;
}

/**
 * Subfolders of `dir` (default: the home folder) for the folder picker, marking git
 * repositories. Hidden folders are left out. Throws when `dir` is not a readable folder.
 */
export async function listFolders(dir?: string): Promise<FolderListing> {
  const info = await inspectFolder(dir?.trim() ? dir : os.homedir());
  if (!info.exists) throw new Error(`folder not found: ${info.path}`);
  const dirents = await readdir(info.path, { withFileTypes: true });
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const full = path.join(info.path, d.name);
      return { name: d.name, path: full, isRepo: existsSync(path.join(full, '.git')) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(info.path);
  return { ...info, parent: parent === info.path ? null : parent, entries };
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
