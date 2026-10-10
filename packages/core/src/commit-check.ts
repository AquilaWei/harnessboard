// SPDX-License-Identifier: Apache-2.0
import { git, isMergedInto, mergeBase, porcelainStatus } from './worktree.js';

/** Commit convention shared by writing roles and the deterministic handoff check. */
export const COMMIT_RULE =
  'Before handing off, commit all task changes. Commit messages must be one concise English line: ' +
  '`<type>: <description>`, where type is feat, fix, docs, style, refactor, perf, test or chore. ' +
  'Follow the repository code rules as well. If nothing changed, do not create an empty commit.';

/**
 * Checks only the current stage's commits, never unrelated repository history. A clean
 * unchanged stage needs no new commit. Semantic adherence to project rules stays with review.
 *
 * Fixing a bad message means rewriting commits, which can replace `since` itself. Then the
 * range starts at the common ancestor of `since` and HEAD, so every rewritten commit is still
 * checked. Only a `since` that git no longer has fails, since there is nothing left to compare.
 */
export async function checkCommits(dir: string, since: string): Promise<string | null> {
  if ((await porcelainStatus(dir)) !== '')
    return 'Uncommitted changes remain; commit task changes before handing off.';
  let from = since;
  if (!(await isMergedInto(dir, since, 'HEAD'))) {
    try {
      from = await mergeBase(dir, since);
    } catch {
      return 'The stage rewrote its starting history and the original start is gone; restore it before handing off.';
    }
  }
  const messages = await git(dir, ['log', '--first-parent', '--format=%B%x00', `${from}..HEAD`]);
  for (const raw of messages.split('\0')) {
    const message = raw.trim();
    if (!message) continue;
    if (
      !/^(feat|fix|docs|style|refactor|perf|test|chore): [\x20-\x7e]*[A-Za-z][\x20-\x7e]*$/.test(
        message,
      )
    ) {
      return 'Invalid commit message: use one English line, `<type>: <description>` (feat, fix, docs, style, refactor, perf, test or chore). Correct the commit before handing off.';
    }
  }
  return null;
}
