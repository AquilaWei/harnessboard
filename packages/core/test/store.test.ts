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
  acceptance: null,
  confirmPlan: false,
  agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
  contextPolicy: { size: 'small' as const },
  permission: { allowedTools: [], skipPermissions: false },
};

describe('Store', () => {
  it('does not reuse the id of a deleted task', () => {
    const store = new Store(':memory:');
    const first = store.createTask(newTask);
    store.deleteTask(first.id);
    expect(store.createTask(newTask).id).toBe(first.id + 1);
  });

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

  it('upgrades tasks from before plan approval as already approved', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const first = new Store(file);
    const { id } = first.createTask({ ...newTask, mode: 'loop', verifyCommand: 'npm test' });
    first.close();
    const db = new DatabaseSync(file);
    db.exec(
      `DROP TABLE devices; DROP TABLE counters; ALTER TABLE tasks DROP COLUMN acceptance;
       ALTER TABLE tasks DROP COLUMN confirm_plan; PRAGMA user_version = 3;`,
    );
    db.close();
    expect(new Store(file).getTask(id)!.confirmPlan).toBe(false);
  });

  it('stores approved acceptance criteria on the task', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask(newTask);
    expect(store.updateTask(id, { acceptance: '- prints hi' }).acceptance).toBe('- prints hi');
  });

  it('upgrades tasks from before acceptance criteria as having none', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const first = new Store(file);
    const { id } = first.createTask(newTask);
    first.close();
    const db = new DatabaseSync(file);
    db.exec(
      `DROP TABLE devices; ALTER TABLE tasks DROP COLUMN acceptance; PRAGMA user_version = 5;`,
    );
    db.close();
    expect(new Store(file).getTask(id)!.acceptance).toBeNull();
  });

  it('stores an updated permission list as JSON', () => {
    const store = new Store(':memory:');
    const { id } = store.createTask(newTask);
    const permission = { allowedTools: ['Bash(npm test)'], skipPermissions: false };
    expect(store.updateTask(id, { permission }).permission).toEqual(permission);
  });
});

const passkey = { credentialId: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 4 };
const pushSubscription = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
};

describe('Store devices', () => {
  it('finds a device by the token it was added with', () => {
    const store = new Store(':memory:');
    store.addDevice('Pixel', 'token-one', 1000);
    expect(store.findDeviceByToken('token-one')).toEqual({
      id: 1,
      name: 'Pixel',
      createdAt: 1000,
      lastSeenAt: 1000,
      passkey: null,
      verifiedAt: null,
      lastActiveAt: null,
    });
  });

  it('finds no device for an unknown token', () => {
    const store = new Store(':memory:');
    store.addDevice('Pixel', 'token-one', 1000);
    expect(store.findDeviceByToken('token-two')).toBeUndefined();
  });

  it('stores only a hash of the token', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const store = new Store(file);
    store.addDevice('Pixel', 'raw-device-token', 1000);
    store.close();
    const db = new DatabaseSync(file);
    const rows = JSON.stringify(db.prepare('SELECT * FROM devices').all());
    db.close();
    expect(rows).not.toContain('raw-device-token');
  });

  it('lists devices in the order they were paired', () => {
    const store = new Store(':memory:');
    store.addDevice('Pixel', 'token-one', 1000);
    store.addDevice('iPad', 'token-two', 2000);
    expect(store.listDevices().map((d) => d.name)).toEqual(['Pixel', 'iPad']);
  });

  it('no longer finds a revoked device by its token', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.revokeDevice(id);
    expect(store.findDeviceByToken('token-one')).toBeUndefined();
  });

  it('reports that revoking an unknown device changed nothing', () => {
    const store = new Store(':memory:');
    expect(store.revokeDevice(7)).toBe(false);
  });

  it('does not give a new device the id of a revoked one', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.revokeDevice(id);
    expect(store.addDevice('iPad', 'token-two', 2000).id).toBe(2);
  });

  it('records when a device was last seen', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.touchDevice(id, 5000);
    expect(store.findDeviceByToken('token-one')!.lastSeenAt).toBe(5000);
  });

  it('records when a device was last active without changing its passkey check time', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setDevicePasskey(id, passkey, 2000);
    store.markDeviceActive(id, 7000);
    const device = store.findDeviceByToken('token-one')!;
    expect([device.verifiedAt, device.lastActiveAt]).toEqual([2000, 7000]);
  });

  it('stores a passkey and counts registering it as a passkey check', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setDevicePasskey(id, passkey, 2000);
    expect(store.findDeviceByToken('token-one')).toEqual({
      id: 1,
      name: 'Pixel',
      createdAt: 1000,
      lastSeenAt: 1000,
      passkey: { credentialId: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 4 },
      verifiedAt: 2000,
      lastActiveAt: 2000,
    });
  });

  it('does not replace a passkey a device already has', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setDevicePasskey(id, passkey, 2000);
    const replaced = store.setDevicePasskey(
      id,
      { credentialId: 'cred-2', publicKey: new Uint8Array([9]), counter: 0 },
      3000,
    );
    expect([replaced, store.findDeviceByToken('token-one')!.passkey!.credentialId]).toEqual([
      false,
      'cred-1',
    ]);
  });

  it('records a passed passkey check with the new counter', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setDevicePasskey(id, passkey, 2000);
    store.markDeviceVerified(id, 5, 3000);
    const device = store.findDeviceByToken('token-one')!;
    expect([device.passkey!.counter, device.verifiedAt, device.lastActiveAt]).toEqual([
      5, 3000, 3000,
    ]);
  });

  it('refuses a passkey check whose counter is not above the stored one', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setDevicePasskey(id, passkey, 2000);
    store.markDeviceVerified(id, 5, 3000);
    const marked = store.markDeviceVerified(id, 4, 4000);
    const device = store.findDeviceByToken('token-one')!;
    expect([marked, device.passkey!.counter, device.verifiedAt, device.lastActiveAt]).toEqual([
      false,
      5,
      3000,
      3000,
    ]);
  });

  it('accepts a passkey check from a passkey whose counter stays at 0', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setDevicePasskey(id, { ...passkey, counter: 0 }, 2000);
    const marked = store.markDeviceVerified(id, 0, 3000);
    expect([marked, store.findDeviceByToken('token-one')!.verifiedAt]).toEqual([true, 3000]);
  });

  it('keeps devices paired before passkeys, without a passkey', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const first = new Store(file);
    first.addDevice('Pixel', 'token-one', 1000);
    first.close();
    const db = new DatabaseSync(file);
    db.exec(
      `ALTER TABLE devices DROP COLUMN credential_id; ALTER TABLE devices DROP COLUMN public_key;
       ALTER TABLE devices DROP COLUMN sign_count; ALTER TABLE devices DROP COLUMN verified_at;
       ALTER TABLE devices DROP COLUMN last_active_at; ALTER TABLE devices DROP COLUMN push_subscription;
       PRAGMA user_version = 7;`,
    );
    db.close();
    expect(new Store(file).findDeviceByToken('token-one')).toEqual({
      id: 1,
      name: 'Pixel',
      createdAt: 1000,
      lastSeenAt: 1000,
      passkey: null,
      verifiedAt: null,
      lastActiveAt: null,
    });
  });

  it('stores a push subscription on its device', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setPushSubscription(id, pushSubscription);
    expect(store.listPushSubscriptions()).toEqual([
      {
        deviceId: 1,
        subscription: {
          endpoint: 'https://push.example/abc',
          keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
        },
      },
    ]);
  });

  it('replaces the push subscription a device had', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setPushSubscription(id, pushSubscription);
    store.setPushSubscription(id, { ...pushSubscription, endpoint: 'https://push.example/new' });
    expect(store.listPushSubscriptions().map((p) => p.subscription.endpoint)).toEqual([
      'https://push.example/new',
    ]);
  });

  it('clears a push subscription with null', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setPushSubscription(id, pushSubscription);
    store.setPushSubscription(id, null);
    expect(store.listPushSubscriptions()).toEqual([]);
  });

  it('removes the push subscription when the device is revoked', () => {
    const store = new Store(':memory:');
    const { id } = store.addDevice('Pixel', 'token-one', 1000);
    store.setPushSubscription(id, pushSubscription);
    store.revokeDevice(id);
    expect(store.listPushSubscriptions()).toEqual([]);
  });

  it('stores no push subscription for a device that is gone', () => {
    const store = new Store(':memory:');
    expect(store.setPushSubscription(7, pushSubscription)).toBe(false);
  });

  it('keeps devices paired before push, without a subscription', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const first = new Store(file);
    first.addDevice('Pixel', 'token-one', 1000);
    first.close();
    const db = new DatabaseSync(file);
    db.exec(`ALTER TABLE devices DROP COLUMN push_subscription; PRAGMA user_version = 8;`);
    db.close();
    const store = new Store(file);
    expect([store.listDevices().length, store.listPushSubscriptions()]).toEqual([1, []]);
  });

  it('adds the devices table to a database from before phone access', () => {
    const file = path.join(tempDir('db'), 'harness.db');
    const first = new Store(file);
    const { id } = first.createTask(newTask);
    first.close();
    const db = new DatabaseSync(file);
    db.exec(`DROP TABLE devices; PRAGMA user_version = 6;`);
    db.close();
    const store = new Store(file);
    store.addDevice('Pixel', 'token-one', 1000);
    expect(store.listDevices().map((d) => d.name)).toEqual(['Pixel']);
    expect(store.getTask(id)!.title).toBe('t');
  });
});
