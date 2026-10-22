// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store, defaultConfig } from '@harnessboard/core';
import type { Harness } from '@harnessboard/core';
import type { Task } from '@harnessboard/shared';
import { taskView } from '../src/views.js';

let store: Store;
let task: Task;
let harness: Harness;
beforeEach(() => {
  store = new Store(':memory:');
  task = store.createTask({
    title: 'Team',
    prompt: 'Review',
    repoPath: '/repo',
    baseRef: 'main',
    workspace: 'worktree',
    workflow: 'pm',
    pm: {
      agentId: 'claude',
      model: null,
      effort: null,
      workers: [{ agentId: 'claude', models: [null] }],
    },
    mode: 'single',
    verifyCommand: null,
    acceptance: 'Review',
    confirmPlan: true,
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
    contextPolicy: {},
    permission: { allowedTools: [], skipPermissions: false },
  });
  task = store.updateTask(task.id, { status: 'running' });
  harness = {
    store,
    config: defaultConfig({}),
    activity: () => null,
    taskOperations: () => undefined,
    permissionRequests: () => [],
    pmAcceptanceCurrent: () => false,
    pendingReview: () => null,
    pendingPlanFeedback: () => null,
    criteriaProposal: () => null,
    specFile: () => null,
    specChange: () => null,
    pendingSpecRevision: () => null,
    lastMerge: () => null,
  } as unknown as Harness;
});
afterEach(() => store.close());

const usage = (input: number) => ({
  role: 'worker',
  agentId: 'claude',
  durationMs: 100,
  cumulative: true,
  usage: {
    costUsd: null,
    models: { model: { input, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null } },
  },
});
const work = {
  id: 'worker',
  parentWorkId: null,
  parentSessionId: 'pm',
  sessionId: 'worker-new',
  sessionIds: ['worker-old', 'worker-new'],
  agentId: 'claude',
  model: null,
  effort: null,
  goal: 'Review changes',
  scope: 'core',
  acceptance: 'Identify risks',
  access: 'readOnly',
  status: 'running',
  summary: null,
  evidence: null,
  since: null,
  head: null,
  execution: 'managed',
};

it('counts each worker conversation once and excludes its childs usage from the parent', () => {
  store.startSession('worker-old', task.id, 'worker', 'claude', 'old');
  store.startSession('worker-new', task.id, 'worker', 'claude', 'new');
  store.startSession('child-session', task.id, 'worker', 'claude', 'child');
  store.appendEvent(task.id, 'worker-old', 'usage', usage(10));
  store.appendEvent(task.id, 'worker-old', 'usage', usage(20));
  store.appendEvent(task.id, 'worker-new', 'usage', usage(30));
  store.appendEvent(task.id, 'child-session', 'usage', usage(100));
  store.appendEvent(task.id, 'worker-new', 'pm_work', work);
  store.appendEvent(task.id, 'child-session', 'pm_work', {
    ...work,
    id: 'child',
    parentWorkId: 'worker',
    sessionId: 'child-session',
    sessionIds: ['child-session'],
  });
  expect(taskView(task, harness).work?.[0]?.usage?.tokens?.input).toBe(50);
  expect(taskView(task, harness).work?.[1]?.usage?.tokens?.input).toBe(100);
  expect(taskView(task, harness).usage.tokens?.input).toBe(150);
});

it('uses actual tool events and pending permissions to project worker activity', () => {
  store.appendEvent(task.id, 'worker-new', 'pm_work', work, 1000);
  store.appendEvent(
    task.id,
    'worker-new',
    'tool_use',
    { name: 'Read', summary: 'core/protocol.rs' },
    2000,
  );
  harness.permissionRequests = () =>
    [{ sessionId: 'worker-new' }] as ReturnType<Harness['permissionRequests']>;
  expect(taskView(task, harness).work?.[0]).toMatchObject({
    status: 'awaiting_permission',
    activity: 'Read: core/protocol.rs',
    updatedAt: 2000,
    provider: 'claude-code',
  });
});

it('distinguishes an idle supervising PM from its executing workers', () => {
  store.startSession('pm', task.id, 'pm', 'claude', 'pm');
  store.appendEvent(task.id, 'worker-new', 'pm_work', work);
  store.appendEvent(task.id, 'pm', 'pm_turn', {});
  store.appendEvent(task.id, 'pm', 'pm_reply', { text: 'Waiting for worker results.' });
  expect(taskView(task, harness).pmState?.status).toBe('awaiting_children');
  store.appendEvent(task.id, 'pm', 'pm_turn', {});
  expect(taskView(task, harness).pmState?.status).toBe('running');
});

it('shows the resumed PM model even when another PM conversation was created later', () => {
  store.startSession('old-claude', task.id, 'pm', 'claude', 'old');
  store.startSession('new-codex', task.id, 'pm', 'codex', 'new');
  store.appendEvent(task.id, 'new-codex', 'init', { model: 'codex-model' });
  store.appendEvent(task.id, 'old-claude', 'init', { model: 'claude-current' });
  store.appendEvent(task.id, 'old-claude', 'pm_turn', {});
  expect(taskView(task, harness).pmState?.model).toBe('claude-current');
});

it('stops a completed agents elapsed time while other agents continue working', () => {
  store.startSession('worker-new', task.id, 'worker', 'claude', 'worker', 1000);
  store.appendEvent(task.id, 'worker-new', 'usage', usage(20), 2000);
  store.endSession('worker-new', 'completed', 3000);
  store.appendEvent(task.id, 'worker-new', 'pm_work', { ...work, status: 'completed' }, 4000);
  harness.activity = () => ({ phase: 'managing', agentId: 'claude' });
  expect(taskView(task, harness).work?.[0]?.usage?.elapsedMs).toBe(2000);
});
