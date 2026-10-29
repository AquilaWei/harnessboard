// SPDX-License-Identifier: Apache-2.0
import { realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { git, resolveCommit } from './worktree.js';

/** Reject a worker in another project before starting its CLI or validating its history. */
export async function assertTaskRepository(repo: string, cwd: string): Promise<void> {
  const common = async (dir: string) =>
    realpath((await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if ((await common(repo)) !== (await common(cwd)))
    throw new Error(
      'Worker repository mismatch: cwd ' +
        cwd +
        ' does not belong to task repository ' +
        repo +
        '. Correct the task repository or dispatch a worktree from that repository.',
    );
}

/** Includes existing untracked contents so a no-change probe cannot conceal an edit. */
export async function dirtyFingerprint(cwd: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await git(cwd, ['diff', '--binary']));
  hash.update(await git(cwd, ['diff', '--cached', '--binary']));
  const files = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
    .sort();
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(path.join(cwd, file)));
  }
  return hash.digest('hex');
}

/** An unavailable historical baseline is retained in events, never used in a new repo. */
export async function validBaseline(cwd: string, baseline: string | null): Promise<boolean> {
  if (!baseline) return true;
  try {
    await resolveCommit(cwd, baseline);
    return true;
  } catch {
    return false;
  }
}
