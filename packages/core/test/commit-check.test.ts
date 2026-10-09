// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { checkCommits } from '../src/commit-check.js';
import { git, headCommit } from '../src/worktree.js';
import { makeRepo } from './helpers.js';

it('blocks uncommitted tracked and untracked changes', async () => {
  const repo = makeRepo();
  const before = await headCommit(repo);
  writeFileSync(path.join(repo, 'new.ts'), 'export const n = 1;');
  expect(await checkCommits(repo, before)).toContain('Uncommitted');
});

it('allows a clean stage without requiring an empty commit', async () => {
  const repo = makeRepo();
  expect(await checkCommits(repo, await headCommit(repo))).toBeNull();
});

it('rejects an invalid earlier commit even when the latest commit is valid', async () => {
  const repo = makeRepo();
  const before = await headCommit(repo);
  await git(repo, ['commit', '--allow-empty', '-m', 'bad message']);
  await git(repo, ['commit', '--allow-empty', '-m', 'fix: handle zero']);
  expect(await checkCommits(repo, before)).toContain('Invalid commit');
});

it('rejects a multiline commit body', async () => {
  const repo = makeRepo();
  const before = await headCommit(repo);
  await git(repo, ['commit', '--allow-empty', '-m', 'feat: add feature', '-m', 'extra body']);
  expect(await checkCommits(repo, before)).toContain('Invalid commit');
});

it('accepts conventional English commits without validating older history', async () => {
  const repo = makeRepo();
  const before = await headCommit(repo);
  await git(repo, ['commit', '--allow-empty', '-m', 'test: cover empty input']);
  expect(await checkCommits(repo, before)).toBeNull();
});

it('does not validate unrelated commits merged from the base branch', async () => {
  const repo = makeRepo();
  await git(repo, ['checkout', '-b', 'task']);
  await git(repo, ['commit', '--allow-empty', '-m', 'feat: add task work']);
  const before = await headCommit(repo);
  await git(repo, ['checkout', 'main']);
  await git(repo, ['commit', '--allow-empty', '-m', 'legacy base message']);
  await git(repo, ['checkout', 'task']);
  await git(repo, ['merge', '--no-ff', '-m', 'chore: merge base updates', 'main']);
  expect(await checkCommits(repo, before)).toBeNull();
});
