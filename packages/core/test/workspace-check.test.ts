// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { makeRepo, tempDir } from './helpers.js';
import { addWorktree, headCommit } from '../src/worktree.js';
import { assertTaskRepository, dirtyFingerprint, validBaseline } from '../src/workspace-check.js';

it('rejects another project before dispatch', async () => {
  await expect(assertTaskRepository(makeRepo(), makeRepo())).rejects.toThrow('repository mismatch');
});
it('accepts a linked worktree from the task repository', async () => {
  const repo = makeRepo();
  const worktree = path.join(tempDir('identity'), 'worker');
  await addWorktree(repo, worktree, 'worker', 'HEAD');
  await expect(assertTaskRepository(repo, worktree)).resolves.toBeUndefined();
});
it('isolates a baseline absent from this repository', async () => {
  expect(await validBaseline(makeRepo(), '1111111111111111111111111111111111111111')).toBe(false);
});
it('retains an existing valid baseline', async () => {
  const repo = makeRepo();
  expect(await validBaseline(repo, await headCommit(repo))).toBe(true);
});
it('detects changes inside a pre-existing untracked file', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, 'untracked.txt'), 'before');
  const before = await dirtyFingerprint(repo);
  writeFileSync(path.join(repo, 'untracked.txt'), 'after');
  expect(await dirtyFingerprint(repo)).not.toBe(before);
});
it('keeps an unchanged dirty baseline stable', async () => {
  const repo = makeRepo();
  writeFileSync(path.join(repo, 'untracked.txt'), 'before');
  const before = await dirtyFingerprint(repo);
  expect(await dirtyFingerprint(repo)).toBe(before);
});
