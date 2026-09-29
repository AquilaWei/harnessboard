// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { tempDir } from './helpers.js';

const newTask = {
  title: 't',
  prompt: 'do it',
  repoPath: '/repo',
  baseRef: 'main',
  contextPolicy: { size: 'small' as const },
  permission: { allowedTools: [], skipPermissions: false },
};

describe('Store', () => {
  it('creates tasks in the backlog', () => {
    const store = new Store(':memory:');
    expect(store.createTask(newTask).status).toBe('backlog');
  });

  it('round-trips the context policy as JSON', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask(newTask);
    expect(store.getTask(id)!.contextPolicy).toEqual({ size: 'small' });
  });

  it('updates only the given fields', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask(newTask);
    const updated = store.updateTask(id, { status: 'queued' });
    expect([updated.status, updated.branch]).toEqual(['queued', null]);
  });

  it('returns events after a given id', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask(newTask);
    const first = store.appendEvent(id, null, 'notice', { message: 'a' });
    store.appendEvent(id, null, 'notice', { message: 'b' });
    expect(store.listEvents(id, first).map((e) => e.data)).toEqual([{ message: 'b' }]);
  });

  it('keeps data when the database is reopened', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const first = new Store(file);
    first.createTask(newTask);
    first.close();
    expect(new Store(file).listTasks()).toHaveLength(1);
  });

  it('remembers the latest reported context window', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask(newTask);
    store.startSession('s1', id);
    store.updateSessionContext('s1', 100, 1_000_000);
    expect(store.lastKnownContextWindow()).toBe(1_000_000);
  });
});
