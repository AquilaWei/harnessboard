// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Harness } from '../src/harness.js';
import { defaultConfig } from '../src/config.js';
import { pmQuestion } from '../src/pm.js';
import {
  FAKE_CLAUDE,
  assistantText,
  init,
  makeRepo,
  result,
  tempDir,
  writeScenario,
} from './helpers.js';

let harness: Harness;
let repo: string;
let dir: string;
const spec = (id: string) => [
  [
    init(id),
    {
      __pm: {
        name: 'propose_spec',
        arguments: { criteria: '- greeting works', message: 'Review greeting' },
      },
    },
    assistantText('Review greeting', 100),
    result('Review greeting'),
  ],
];

beforeEach(() => {
  dir = tempDir('repository');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'runs.jsonl');
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [spec('old-folder'), spec('new-folder')]);
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: { provider: 'claude-code', command: FAKE_CLAUDE, model: null } },
  });
});
afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});

it('changes a draft repository without moving files and starts a fresh discussion in the new folder', async () => {
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  const old = harness.store.getTask(task.id)!;
  const target = makeRepo();
  writeFileSync(path.join(target, 'personal.txt'), 'keep me');
  expect(await harness.setRepository(task.id, target)).toMatchObject({
    repoPath: target,
    worktreePath: null,
    branch: null,
    status: 'backlog',
    deferred: true,
    startCommit: null,
    endCommit: null,
    priorSpans: [],
  });
  expect(pmQuestion(harness.store, task.id)).toBeNull();
  expect(readFileSync(path.join(target, 'personal.txt'), 'utf8')).toBe('keep me');
  expect(readFileSync(path.join(old.worktreePath!, 'README.md'), 'utf8')).toBe('hello\n');
  harness.planTask(task.id);
  await harness.waitForIdle();
  const updated = harness.store.getTask(task.id)!;
  expect(updated.worktreePath).not.toBe(old.worktreePath);
  const runs = readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(runs[1].cwd).toBe(updated.worktreePath);
  expect(runs[1].args).not.toContain('--resume');
  expect(harness.store.listSessions(task.id)).toHaveLength(2);
});

it('rejects changing an approved task even after it is returned to Draft', async () => {
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  harness.store.updateTask(task.id, { status: 'backlog', deferred: true });
  await expect(harness.setRepository(task.id, makeRepo())).rejects.toThrow(/before.*approval/i);
  expect(harness.store.getTask(task.id)?.repoPath).toBe(repo);
});

it('leaves the task intact for an invalid destination', async () => {
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  const before = harness.store.getTask(task.id);
  await expect(harness.setRepository(task.id, path.join(dir, 'missing'))).rejects.toThrow(
    /folder not found/,
  );
  expect(harness.store.getTask(task.id)).toEqual(before);
});

it('requires queued discussions to stop before changing their repository', async () => {
  vi.spyOn(harness, 'tick').mockImplementation(() => {});
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await expect(harness.setRepository(task.id, makeRepo())).rejects.toThrow(/stop/i);
});

it('uses a plain destination directly without initializing or staging it on save', async () => {
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  const target = tempDir('repository-plain');
  writeFileSync(path.join(target, 'personal.txt'), 'keep me');
  expect(await harness.setRepository(task.id, target)).toMatchObject({
    repoPath: target,
    workspace: 'base',
    baseRef: 'main',
  });
  expect(harness.store.listSessions(task.id)).toHaveLength(1);
  expect(existsSync(path.join(target, '.git'))).toBe(false);
});

it('can switch back to a previous repository without overwriting its old discussion worktree', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    spec('first'),
    spec('second'),
    spec('third'),
  ]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  const first = harness.store.getTask(task.id)!;
  await harness.setRepository(task.id, makeRepo());
  harness.planTask(task.id);
  await harness.waitForIdle();
  await harness.setRepository(task.id, repo);
  harness.planTask(task.id);
  await harness.waitForIdle();
  const last = harness.store.getTask(task.id)!;
  expect(last.status).toBe('awaiting_approval');
  expect(last.worktreePath).not.toBe(first.worktreePath);
  expect(existsSync(first.worktreePath!)).toBe(true);
  expect(harness.store.listSessions(task.id)).toHaveLength(3);
});
