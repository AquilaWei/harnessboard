// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Task } from '@harnessboard/shared';
import { Harness } from '../src/harness.js';
import { defaultConfig } from '../src/config.js';
import { cleanTaskCaches } from '../src/cache-cleanup.js';
import { addWorktree, git, worktreePath } from '../src/worktree.js';
import { createHistoricalTask, makeRepo, tempDir } from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

let harness: Harness;
let task: Task;
let root: string;
let data: string;
beforeEach(async () => {
  data = tempDir('cache');
  const repo = makeRepo();
  harness = Harness.open({ ...defaultConfig({}), dataDir: data });
  task = await createHistoricalTask(harness, {
    repo,
    title: 'cache cleanup',
    prompt: 'Clean fixture caches',
    acceptance: 'works',
  });
  root = worktreePath(data, repo, task.id);
  await addWorktree(repo, root, 'cache-test', 'main');
  task = harness.store.updateTask(task.id, {
    worktreePath: root,
    workspace: 'worktree',
    branch: 'cache-test',
    status: 'stopped',
  });
  await writeFile(path.join(root, 'Cargo.toml'), '[package]\n');
  await writeFile(path.join(root, '.gitignore'), 'target/\nnode_modules/\n.venv/\n');
  await mkdir(path.join(root, 'target'));
  await writeFile(path.join(root, 'target', 'cache'), '12345');
});
afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});

it('previews without deleting and execution is repeatable', async () => {
  expect((await harness.cleanupTask(task.id)).estimatedBytes).toBe(5);
  expect(existsSync(path.join(root, 'target'))).toBe(true);
  expect((await harness.cleanupTask(task.id, true)).removedBytes).toBe(5);
  expect((await harness.cleanupTask(task.id, true)).entries).toEqual([]);
});
it('completion cleans caches while retaining work, branch and history', async () => {
  const head = await git(root, ['rev-parse', 'HEAD']);
  harness.completeTask(task.id);
  await harness.shutdown();
  expect(existsSync(path.join(root, 'target'))).toBe(false);
  expect(await readFile(path.join(root, 'Cargo.toml'), 'utf8')).toBe('[package]\n');
  expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
  expect(harness.store.getTask(task.id)?.status).toBe('done');
  expect(harness.toDraft(task.id).status).toBe('backlog');
});
it('preserves tracked files even in ignored caches', async () => {
  await git(root, ['add', '-f', 'target/cache']);
  expect((await harness.cleanupTask(task.id, true)).entries[0]?.reason).toBe(
    'Contains tracked files',
  );
  expect(existsSync(path.join(root, 'target/cache'))).toBe(true);
});
it('preserves directories without ignore rules', async () => {
  await writeFile(path.join(root, '.gitignore'), '');
  expect((await harness.cleanupTask(task.id, true)).removedBytes).toBe(0);
  expect(existsSync(path.join(root, 'target/cache'))).toBe(true);
});
it('preserves external symlink targets', async () => {
  const external = tempDir('external-cache');
  await writeFile(path.join(external, 'keep'), 'keep');
  await symlink(external, path.join(root, 'target/link'), 'dir');
  expect((await harness.cleanupTask(task.id, true)).entries[0]?.status).toBe('skipped');
  expect(await readFile(path.join(external, 'keep'), 'utf8')).toBe('keep');
});
it('preserves nested Git workspaces', async () => {
  await mkdir(path.join(root, 'target/.git'));
  expect((await harness.cleanupTask(task.id, true)).entries[0]?.reason).toBe(
    'Contains a nested Git workspace',
  );
});
it('preserves original project folders', async () => {
  expect(
    await cleanTaskCaches({ ...task, workspace: 'base', worktreePath: task.repoPath }, data, true),
  ).toEqual({ entries: [], estimatedBytes: 0, removedBytes: 0 });
});
it('rejects cleanup while running', async () => {
  harness.store.updateTask(task.id, { status: 'running' });
  await expect(harness.cleanupTask(task.id, true)).rejects.toThrow('busy');
});
it('holds the operation reservation before asynchronous disk work', async () => {
  const cleanup = harness.cleanupTask(task.id, true);
  expect(() => harness.queueTask(task.id)).toThrow('cleanup');
  expect(() => harness.chat(task.id, 'continue')).toThrow('cleanup');
  await expect(harness.deleteTask(task.id)).rejects.toThrow('cleanup');
  await expect(harness.cleanupTask(task.id)).rejects.toThrow('cleanup');
  await cleanup;
});
it('handles a missing worktree', async () => {
  await rm(root, { recursive: true });
  expect((await harness.cleanupTask(task.id, true)).entries).toEqual([]);
});
it('preserves delivery directories', async () => {
  await mkdir(path.join(root, 'dist/target'), { recursive: true });
  await writeFile(path.join(root, 'dist/Cargo.toml'), '');
  await writeFile(path.join(root, 'dist/target/result'), 'delivery');
  await harness.cleanupTask(task.id, true);
  expect(existsSync(path.join(root, 'dist/target/result'))).toBe(true);
});

it('startup sweeps historical completed tasks', async () => {
  harness.store.updateTask(task.id, { status: 'done' });
  vi.spyOn(harness, 'tick').mockImplementation(() => {});
  const internal = harness as unknown as { readQuotas(now: number): Promise<void> };
  vi.spyOn(internal, 'readQuotas').mockResolvedValue(undefined);
  await harness.start();
  await harness.shutdown();
  expect(existsSync(path.join(root, 'target'))).toBe(false);
});

it('reports a deletion failure and continues with the next cache', async () => {
  await writeFile(path.join(root, 'package.json'), '{}');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules/cache'), 'ok');
  const fs = await import('node:fs/promises');
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
    .rm;
  const removal = vi.mocked(fs.rm).mockImplementation(async (file, options) => {
    if (String(file).endsWith('node_modules')) throw new Error('permission denied');
    return original(file, options);
  });
  try {
    const result = await harness.cleanupTask(task.id, true);
    expect(result.entries.find((e) => e.path === 'node_modules')?.status).toBe('failed');
    expect(result.entries.find((e) => e.path === 'target')?.status).toBe('removed');
  } finally {
    removal.mockRestore();
  }
});

it('recognizes nested Node and Python caches with manifests', async () => {
  await mkdir(path.join(root, 'web/node_modules'), { recursive: true });
  await writeFile(path.join(root, 'web/package.json'), '{}');
  await writeFile(path.join(root, 'web/node_modules/cache'), 'node');
  await mkdir(path.join(root, 'python/.venv'), { recursive: true });
  await writeFile(path.join(root, 'python/pyproject.toml'), '');
  await writeFile(path.join(root, 'python/.venv/cache'), 'python');
  expect((await harness.cleanupTask(task.id, true)).removedBytes).toBe(15);
});

it('preserves caches without a matching project manifest', async () => {
  await rm(path.join(root, 'Cargo.toml'));
  expect((await harness.cleanupTask(task.id, true)).entries).toEqual([]);
  expect(existsSync(path.join(root, 'target/cache'))).toBe(true);
});

it('rejects arbitrary directories even if the task record points there', async () => {
  harness.store.updateTask(task.id, { worktreePath: task.repoPath });
  await expect(harness.cleanupTask(task.id, true)).rejects.toThrow('managed worktree');
});
