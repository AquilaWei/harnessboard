// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Harness } from '../src/harness.js';
import { defaultConfig } from '../src/config.js';
import { makeRepo, tempDir } from './helpers.js';

let harness: Harness;
let taskId: number;
let dataDir: string;
const event = {
  kind: 'permission_request' as const,
  requestId: 'rpc-1',
  toolName: 'Bash',
  summary: 'test',
  suggestedRules: [],
  input: { command: 'pnpm test' },
};
beforeEach(async () => {
  dataDir = path.join(tempDir('approval'), 'data');
  harness = Harness.open({ ...defaultConfig({}), dataDir });
  const task = await harness.createTask({
    prompt: 'Verify project',
    repo: makeRepo(),
    queue: false,
  });
  taskId = task.id;
});
afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});

it('keeps a worker waiting after storage failure and permits a safe retry', async () => {
  const reply = vi.fn();
  void harness['askPermission'](taskId, 'worker', 'claude-code', event, '/repo').then(reply);
  const requestId = harness.permissionRequests(taskId)[0]!.requestId;
  const save = vi.spyOn(harness.store, 'updateTask').mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  expect(() =>
    harness['answerPmPermission'](taskId, requestId, 'allow', 'Run tests', 'secretary'),
  ).toThrow('disk full');
  await Promise.resolve();
  expect(reply).not.toHaveBeenCalled();
  expect(harness.permissionRequests(taskId)).toHaveLength(1);
  save.mockRestore();
  harness['answerPmPermission'](taskId, requestId, 'allow', 'Run tests', 'secretary');
  await Promise.resolve();
  expect(reply).toHaveBeenCalledWith({ behavior: 'allow' });
  expect(harness.store.getTask(taskId)!.permission.approvalRules).toHaveLength(1);
});

it('rechecks queued requests and prevents duplicate approval records', async () => {
  const first = harness['askPermission'](taskId, 'worker-a', 'claude-code', event, '/repo');
  const second = harness['askPermission'](taskId, 'worker-b', 'claude-code', event, '/repo');
  expect(harness.permissionRequests(taskId)).toHaveLength(2);
  const requestId = harness.permissionRequests(taskId)[0]!.requestId;
  harness['answerPmPermission'](taskId, requestId, 'allow', 'Run tests', 'pm');
  await expect(first).resolves.toEqual({ behavior: 'allow' });
  await expect(second).resolves.toEqual({ behavior: 'allow' });
  expect(() => harness['answerPmPermission'](taskId, requestId, 'allow', 'Retry', 'pm')).toThrow(
    'expired',
  );
  expect(harness.store.getTask(taskId)!.permission.approvalRules).toHaveLength(1);
});

it('revokes a saved rule without deleting the decision evidence', async () => {
  const pending = harness['askPermission'](taskId, 'worker', 'claude-code', event, '/repo');
  harness['answerPmPermission'](
    taskId,
    harness.permissionRequests(taskId)[0]!.requestId,
    'allow',
    'Run tests',
    'pm',
  );
  await pending;
  const rule = harness.store.getTask(taskId)!.permission.approvalRules![0]!;
  harness.revokeApprovalRule(taskId, rule.id);
  expect(harness.store.getTask(taskId)!.permission.approvalRules![0]!.revokedAt).toEqual(
    expect.any(Number),
  );
  expect(harness.store.eventsOfKind(taskId, 'permission_decision')).toHaveLength(1);
});

it('does not create rules for denials or expired requests', async () => {
  const pending = harness['askPermission'](taskId, 'worker', 'claude-code', event, '/repo');
  const requestId = harness.permissionRequests(taskId)[0]!.requestId;
  harness['answerPmPermission'](taskId, requestId, 'deny', 'Outside scope', 'pm');
  await expect(pending).resolves.toEqual({ behavior: 'deny', message: 'Outside scope' });
  expect(() => harness['answerPmPermission'](taskId, requestId, 'allow', 'Late', 'pm')).toThrow(
    'expired',
  );
  expect(harness.store.getTask(taskId)!.permission.approvalRules).toBeUndefined();
});

it('reuses a persisted task rule after the harness restarts', async () => {
  const pending = harness['askPermission'](taskId, 'worker', 'claude-code', event, '/repo');
  harness['answerPmPermission'](
    taskId,
    harness.permissionRequests(taskId)[0]!.requestId,
    'allow',
    'Run tests',
    'pm',
  );
  await pending;
  await harness.shutdown();
  harness.store.close();
  harness = Harness.open({ ...defaultConfig({}), dataDir });
  await expect(
    harness['askPermission'](taskId, 'new-worker', 'claude-code', event, '/repo'),
  ).resolves.toEqual({ behavior: 'allow' });
  expect(harness.permissionRequests(taskId)).toEqual([]);
});
