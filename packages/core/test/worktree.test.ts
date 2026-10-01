// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addWorktree, commitDiff, commitLog } from '../src/worktree.js';
import { makeRepo, tempDir } from './helpers.js';

let worktree: string;

function commit(file: string, message: string): void {
  writeFileSync(path.join(worktree, file), `${message}\n`);
  execFileSync('git', ['add', file], { cwd: worktree });
  execFileSync(
    'git',
    ['-c', 'user.name=Agent', '-c', 'user.email=a@example.com', 'commit', '-qm', message],
    { cwd: worktree },
  );
}

beforeEach(async () => {
  const repo = makeRepo();
  worktree = path.join(tempDir('wt'), 'task');
  await addWorktree(repo, worktree, 'hb/1-task', 'main');
});

describe('commitLog', () => {
  it('lists the commits made since the base, newest first', async () => {
    commit('a.txt', 'feat: add a');
    commit('b.txt', 'feat: add b');
    const log = await commitLog(worktree, 'main');
    expect(log.map((c) => [c.subject, c.author])).toEqual([
      ['feat: add b', 'Agent'],
      ['feat: add a', 'Agent'],
    ]);
  });

  it('is empty before the task commits anything', async () => {
    expect(await commitLog(worktree, 'main')).toEqual([]);
  });
});

describe('commitDiff', () => {
  it('shows the message and patch of one commit', async () => {
    commit('a.txt', 'feat: add a');
    const [only] = await commitLog(worktree, 'main');
    const shown = await commitDiff(worktree, only!.hash);
    expect([shown.startsWith('feat: add a'), shown.includes('+++ b/a.txt')]).toEqual([true, true]);
  });
});
