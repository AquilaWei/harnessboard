// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PmConfig, Task } from '@harnessboard/shared';
import { Store } from '../src/store.js';
import { PmWorkflow, pmWork, validatePm } from '../src/pm.js';
import type { PmHost } from '../src/pm.js';
import type { SessionOutcome } from '../src/runner.js';
import { defaultConfig } from '../src/config.js';
import { makeRepo, tempDir } from './helpers.js';

let store: Store;
let task: Task;
let host: PmHost;
let controller: AbortController;
let engine: PmWorkflow;
const pm: PmConfig = {
  agentId: 'claude',
  model: null,
  effort: null,
  workers: [{ agentId: 'claude', models: [null] }],
};
const outcome: SessionOutcome = {
  reason: 'completed',
  finalText: 'done',
  quota: null,
  contextWindow: null,
  detail: null,
  usage: null,
};
const input = {
  agentId: 'claude',
  goal: 'Implement greeting',
  acceptance: 'Greeting works',
  scope: 'greeting.txt',
  access: 'edit',
};

beforeEach(() => {
  store = new Store(':memory:');
  controller = new AbortController();
  const repo = makeRepo();
  task = store.createTask({
    title: 'Greeting',
    prompt: 'Add greeting',
    repoPath: repo,
    baseRef: 'main',
    workspace: 'base',
    workflow: 'pm',
    pm,
    mode: 'single',
    verifyCommand: null,
    acceptance: '- greeting works',
    confirmPlan: true,
    contextPolicy: {},
    permission: { allowedTools: [], skipPermissions: false },
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
  });
  task = store.updateTask(task.id, { worktreePath: repo });
  store.appendEvent(task.id, null, 'criteria_approved', { criteria: task.acceptance });
  host = {
    store,
    config: { ...defaultConfig({}), dataDir: tempDir('pm-unit') },
    run: vi.fn(async (_task, _plan, _id, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ...outcome, reason: 'stopped' as const };
    }),
    status: (_id, status) => {
      store.updateTask(task.id, { status });
    },
    blocked: () => false,
    permissions: () => [],
    answer: vi.fn(),
    notice: vi.fn(),
  };
  engine = new PmWorkflow(host, task, controller.signal);
});
afterEach(() => store.close());

function pmTurn(action: () => Promise<void>) {
  const worker = host.run;
  host.run = async (task, plan, id, signal) => {
    if (plan.role !== 'pm') return worker(task, plan, id, signal);
    try {
      await action();
    } finally {
      controller.abort();
    }
    return outcome;
  };
  return engine.run();
}

it('allows two workers but refuses a second writer and a third worker', async () => {
  await pmTurn(async () => {
    await engine.call('dispatch', input);
    await expect(engine.call('dispatch', input)).rejects.toThrow('Only one worker');
    await engine.call('dispatch', { ...input, access: 'readOnly' });
    await expect(engine.call('dispatch', { ...input, access: 'readOnly' })).rejects.toThrow(
      'At most two',
    );
  });
  expect(pmWork(store, task.id)).toHaveLength(2);
});

it('refuses models outside the task model pool', async () => {
  await pmTurn(async () => {
    await expect(engine.call('dispatch', { ...input, model: 'unapproved' })).rejects.toThrow(
      'not permitted',
    );
  });
  expect(pmWork(store, task.id)).toEqual([]);
});

it('requires a fresh approval after proposing a changed specification', async () => {
  store.appendEvent(task.id, null, 'criteria', { criteria: '- changed' });
  await pmTurn(async () => {
    await expect(engine.call('dispatch', input)).rejects.toThrow('User must approve');
  });
});

it('refuses acceptance while any child is running', async () => {
  await pmTurn(async () => {
    await engine.call('dispatch', input);
    await expect(engine.call('accept', {})).rejects.toThrow('Finish all child work');
  });
  expect(store.lastEvent(task.id, 'pm_acceptance')).toBeUndefined();
});

it('rejects tools after the PM turn has ended', async () => {
  await expect(engine.call('dispatch', input)).rejects.toThrow('PM turn has ended');
});

it('passes permission decisions without permanent rules or global scope', async () => {
  await pmTurn(async () => {
    await engine.call('permission', {
      requestId: 'r',
      behavior: 'deny',
      reason: 'Outside the approved scope.',
    });
  });
  expect(host.answer).toHaveBeenCalledWith(task.id, 'r', 'deny', 'Outside the approved scope.');
});

it('does not dispatch a quota-blocked worker', async () => {
  await pmTurn(async () => {
    host.blocked = () => true;
    await expect(engine.call('dispatch', input)).rejects.toThrow('waiting for quota');
  });
  expect(pmWork(store, task.id)).toEqual([]);
});

it('marks interrupted work stopped without replaying it after restart', async () => {
  store.appendEvent(task.id, null, 'pm_work', {
    ...input,
    id: 'old-work',
    parentSessionId: 'old-pm',
    sessionId: null,
    model: null,
    effort: null,
    status: 'running',
    summary: null,
    evidence: null,
    since: null,
    head: null,
    execution: 'managed',
  });
  const workerRun = host.run;
  await pmTurn(async () => {
    expect(pmWork(store, task.id)[0]?.status).toBe('stopped');
  });
  expect(workerRun).not.toHaveBeenCalled();
});

it('upgrades a pre-PM database with all tasks remaining legacy', () => {
  const file = path.join(tempDir('pm-upgrade'), 'harness.db');
  const initial = new Store(file);
  const saved = initial.createTask({ ...task, workflow: 'legacy' });
  initial.close();
  const db = new DatabaseSync(file);
  db.exec(
    'ALTER TABLE tasks DROP COLUMN workflow; ALTER TABLE tasks DROP COLUMN pm; PRAGMA user_version = 13;',
  );
  db.close();
  const upgraded = new Store(file);
  expect(upgraded.getTask(saved.id)).toMatchObject({
    workflow: 'legacy',
    pm: null,
    title: 'Greeting',
  });
  upgraded.close();
});

it('permits cross-platform workers while requiring a supported PM transport', () => {
  host.config.agents.gemini = { provider: 'gemini', command: 'gemini', model: null };
  expect(() =>
    validatePm(host.config, { ...pm, workers: [{ agentId: 'gemini', models: [null] }] }),
  ).not.toThrow();
});

it('records explicit cancellation so the PM can replace a failed worker', async () => {
  await pmTurn(async () => {
    const work = (await engine.call('dispatch', input)) as { id: string };
    await engine.call('cancel_work', { id: work.id });
  });
  expect(pmWork(store, task.id)[0]?.status).toBe('cancelled');
});

it('releases its task slot when an escalated question outlives the last worker', async () => {
  host.run = async (_task, plan) => {
    if (plan.role === 'pm') {
      await engine.call('dispatch', { ...input, access: 'readOnly' });
      await engine.call('ask_user', { message: 'Please choose the final direction.' });
    }
    return outcome;
  };
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await engine.run();
  } finally {
    clearTimeout(timer);
  }
  expect(store.getTask(task.id)?.status).toBe('awaiting_approval');
  expect(pmWork(store, task.id)[0]?.status).toBe('completed');
}, 3000);

it('reports PM acceptance for user review without marking the task done', async () => {
  const { headCommit } = await import('../src/worktree.js');
  const head = await headCommit(task.worktreePath!);
  store.appendEvent(task.id, null, 'pm_work', {
    ...input,
    id: 'completed-work',
    parentSessionId: 'old-pm',
    sessionId: 'worker-session',
    model: null,
    effort: null,
    status: 'completed',
    summary: 'Implemented',
    evidence: 'Tests pass',
    since: head,
    head,
    execution: 'managed',
  });
  host.run = vi.fn(async () => {
    await engine.call('accept', {
      head,
      summary: 'Greeting implemented',
      architecture: 'Architecture checked',
      functionality: 'Greeting works',
      verification: 'Tests pass',
    });
    return outcome;
  });
  await engine.run();
  expect(store.getTask(task.id)?.status).toBe('review');
  expect(store.lastEvent(task.id, 'pm_acceptance')?.data).toEqual({
    head,
    summary: 'Greeting implemented',
    architecture: 'Architecture checked',
    functionality: 'Greeting works',
    verification: 'Tests pass',
  });
});
