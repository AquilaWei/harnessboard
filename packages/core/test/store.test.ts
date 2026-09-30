// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { tempDir } from './helpers.js';

const newTask = {
  title: 't',
  prompt: 'do it',
  repoPath: '/repo',
  baseRef: 'main',
  mode: 'single' as const,
  verifyCommand: null,
  agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
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
    store.startSession('s1', id, 'implementer', 'claude', 's1');
    store.updateSessionContext('s1', 100, 1_000_000);
    expect(store.lastKnownContextWindow('claude')).toBe(1_000_000);
  });

  it('stores the mode and verify command of a loop task', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask({ ...newTask, mode: 'loop', verifyCommand: 'npm test' });
    const task = store.getTask(id)!;
    expect([task.mode, task.verifyCommand]).toEqual(['loop', 'npm test']);
  });

  it('upgrades a database from before loop mode, keeping its tasks as single', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE tasks (
       id INTEGER PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
       repo_path TEXT NOT NULL, base_ref TEXT NOT NULL, branch TEXT, worktree_path TEXT,
       status TEXT NOT NULL, context_policy TEXT NOT NULL, permission TEXT NOT NULL,
       resume_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, started_at INTEGER NOT NULL,
       ended_at INTEGER, end_reason TEXT, context_tokens INTEGER NOT NULL DEFAULT 0,
       context_window INTEGER);
     INSERT INTO tasks VALUES (1, 't', 'p', '/r', 'main', NULL, NULL, 'done', '{}',
       '{"allowedTools":[],"skipPermissions":false}', NULL, 0, 0);
     PRAGMA user_version = 1;`);
    old.close();
    expect(new Store(file).getTask(1)!.mode).toBe('single');
  });

  it('lists every event of one kind in order', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask(newTask);
    store.appendEvent(id, null, 'features', { n: 1 });
    store.appendEvent(id, null, 'notice', { message: 'x' });
    store.appendEvent(id, null, 'features', { n: 2 });
    expect(store.eventsOfKind(id, 'features').map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('upgrades sessions from before agent profiles to claude implementer sessions', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE tasks (
       id INTEGER PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
       repo_path TEXT NOT NULL, base_ref TEXT NOT NULL, branch TEXT, worktree_path TEXT,
       status TEXT NOT NULL, context_policy TEXT NOT NULL, permission TEXT NOT NULL,
       resume_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
       mode TEXT NOT NULL DEFAULT 'single', verify_command TEXT);
     CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, started_at INTEGER NOT NULL,
       ended_at INTEGER, end_reason TEXT, context_tokens INTEGER NOT NULL DEFAULT 0,
       context_window INTEGER);
     INSERT INTO tasks VALUES (1, 't', 'p', '/r', 'main', NULL, NULL, 'done', '{}',
       '{"allowedTools":[],"skipPermissions":false}', NULL, 0, 0, 'single', NULL);
     INSERT INTO sessions VALUES ('s1', 1, 0, 1, 'completed', 10, NULL);
     PRAGMA user_version = 2;`);
    old.close();
    const [session] = new Store(file).listSessions(1);
    expect([session!.role, session!.agentId, session!.agentSessionId]).toEqual([
      'implementer',
      'claude',
      's1',
    ]);
  });
});
