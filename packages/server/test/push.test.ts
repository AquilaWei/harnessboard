// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Harness, Store, defaultConfig } from '@harnessboard/core';
import type { PushSubscriptionInfo } from '@harnessboard/shared';
import { CLIENT_HEADER, access } from '../src/access.js';
import { createApi } from '../src/api.js';
import {
  PushNotifier,
  describePushError,
  isGone,
  loadVapidKeys,
  parseSubscription,
} from '../src/push.js';
import type { PushOutcome, PushSender } from '../src/push.js';
import { SESSION_HEADER, Sessions } from '../src/session.js';

const PORT = 4999;
const REMOTE = 'box.tail1234.ts.net';
const START = 1_000_000;
const TOKEN = 'device-token';
const subscription = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
};
let home: string;
let harness: Harness;
let app: Hono;
let device: Record<string, string>;
let pushed: FakeSender;

const tempHome = () => mkdtempSync(path.join(realpathSync.native(tmpdir()), 'hb-push-'));

beforeEach(() => {
  home = tempHome();
  harness = Harness.open({
    ...defaultConfig({ HARNESSBOARD_HOME: home }),
    port: PORT,
    remoteHosts: [REMOTE],
  });
  const { id } = harness.store.addDevice('phone', TOKEN, START);
  harness.store.setDevicePasskey(
    id,
    { credentialId: 'cred', publicKey: new Uint8Array([1]), counter: 0 },
    START,
  );
  const sessions = new Sessions();
  device = { host: REMOTE, cookie: `hb_device=${TOKEN}`, [SESSION_HEADER]: sessions.open(id) };
  app = new Hono();
  app.use(
    '*',
    access(harness, sessions, () => START),
  );
  pushed = new FakeSender();
  app.route('/api', createApi(harness, sessions, { now: () => START, pushSender: pushed }));
});

afterEach(() => harness.store.close());

const send = (method: string, url: string, headers: Record<string, string>, body?: unknown) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('VAPID keys', () => {
  it('makes keys on first use and reads the same keys back', () => {
    const dir = tempHome();
    expect(loadVapidKeys(dir)).toEqual(loadVapidKeys(dir));
  });

  it('writes the keys to vapid.json in the given folder', () => {
    const dir = tempHome();
    const keys = loadVapidKeys(dir);
    expect(JSON.parse(readFileSync(path.join(dir, 'vapid.json'), 'utf8'))).toEqual(keys);
  });

  // Windows has no owner/group/other file modes, so Node reports 0o666 there whatever was asked.
  it.runIf(process.platform !== 'win32')('makes the key file readable by its owner only', () => {
    const dir = tempHome();
    loadVapidKeys(dir);
    expect(statSync(path.join(dir, 'vapid.json')).mode & 0o777).toBe(0o600);
  });

  it('makes a 65-byte public key and a 32-byte private key', () => {
    const keys = loadVapidKeys(tempHome());
    expect([
      Buffer.from(keys.publicKey, 'base64url').length,
      Buffer.from(keys.privateKey, 'base64url').length,
    ]).toEqual([65, 32]);
  });

  it('makes keys web-push accepts for signing a push', () => {
    const vapid = loadVapidKeys(tempHome());
    const request = webpush.generateRequestDetails(
      {
        endpoint: 'https://push.example/abc',
        keys: {
          p256dh:
            'BPKJThHBK6vQ0eAiMjOrUCheJtRXYZDFpeD3SHrnZZiWsRURI8Tz-LQrGyqLh49qUVIzRoWfm1Hn1wPoXOAdUEs',
          auth: 'AAAAAAAAAAAAAAAAAAAAAA',
        },
      },
      'hello',
      { vapidDetails: { subject: 'https://github.com/AquilaWei/harnessboard', ...vapid } },
    );
    expect(request.headers.Authorization).toMatch(/^vapid t=/);
  });

  it('makes different keys in different folders', () => {
    expect(loadVapidKeys(tempHome()).publicKey).not.toBe(loadVapidKeys(tempHome()).publicKey);
  });

  it('throws instead of replacing a key file it cannot read', () => {
    const dir = tempHome();
    writeFileSync(path.join(dir, 'vapid.json'), 'not json');
    expect(() => loadVapidKeys(dir)).toThrow();
  });
});

describe('parseSubscription', () => {
  it('accepts what PushSubscription.toJSON gives', () => {
    expect(parseSubscription({ ...subscription, expirationTime: null })).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    });
  });

  it('refuses an http endpoint', () => {
    expect(parseSubscription({ ...subscription, endpoint: 'http://push.example/abc' })).toBeNull();
  });

  it('refuses an endpoint that is not a URL', () => {
    expect(parseSubscription({ ...subscription, endpoint: 'push.example' })).toBeNull();
  });

  it('refuses a subscription without an auth key', () => {
    expect(parseSubscription({ ...subscription, keys: { p256dh: 'p256dh-key' } })).toBeNull();
  });

  it('refuses a body that is not an object', () => {
    expect(parseSubscription(null)).toBeNull();
  });
});

describe('push API', () => {
  it('gives the public key from the key file in HARNESSBOARD_HOME', async () => {
    const res = await send('GET', '/api/push/key', device);
    const { publicKey } = JSON.parse(readFileSync(path.join(home, 'vapid.json'), 'utf8'));
    expect(await res.json()).toEqual({ publicKey });
  });

  it('gives the same key after a restart', async () => {
    const first = (await (await send('GET', '/api/push/key', device)).json()) as object;
    // A new API has no keys in memory, as after a restart; it is not mounted under /api.
    const restarted = createApi(harness, new Sessions(), { now: () => START });
    const res = await restarted.request('/push/key');
    expect(await res.json()).toEqual(first);
  });

  it('stores the subscription on the device that sent it', async () => {
    await send('POST', '/api/push/subscribe', device, subscription);
    expect(harness.store.listPushSubscriptions()).toEqual([
      {
        deviceId: 1,
        subscription: {
          endpoint: 'https://push.example/abc',
          keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
        },
      },
    ]);
  });

  it('answers 201 to a subscription', async () => {
    const res = await send('POST', '/api/push/subscribe', device, subscription);
    expect(res.status).toBe(201);
  });

  it('refuses a subscription with an http endpoint', async () => {
    const res = await send('POST', '/api/push/subscribe', device, {
      ...subscription,
      endpoint: 'http://push.example/abc',
    });
    expect([res.status, harness.store.listPushSubscriptions()]).toEqual([400, []]);
  });

  it('removes the subscription on DELETE', async () => {
    await send('POST', '/api/push/subscribe', device, subscription);
    await send('DELETE', '/api/push/subscribe', device);
    expect(harness.store.listPushSubscriptions()).toEqual([]);
  });

  it('refuses a subscription from the computer itself, which has no device', async () => {
    const res = await send(
      'POST',
      '/api/push/subscribe',
      { host: `127.0.0.1:${PORT}` },
      subscription,
    );
    expect(res.status).toBe(400);
  });

  it('refuses a subscription from a device that is not paired', async () => {
    const res = await send(
      'POST',
      '/api/push/subscribe',
      { ...device, cookie: 'hb_device=other-token' },
      subscription,
    );
    expect(res.status).toBe(401);
  });

  it('stops pushing to a device once it is revoked', async () => {
    await send('POST', '/api/push/subscribe', device, subscription);
    await send('DELETE', '/api/devices/1', { host: `127.0.0.1:${PORT}` });
    expect(harness.store.listPushSubscriptions()).toEqual([]);
  });
});

const newTask = {
  title: 'Fix the login page',
  prompt: 'secret prompt text',
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
const keys = { publicKey: 'public', privateKey: 'private' };
const phone = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

/** Records every push; endpoints listed in `outcomes` answer with that outcome or error. */
class FakeSender implements PushSender {
  readonly sent: { endpoint: string; payload: string }[] = [];
  constructor(private readonly outcomes: Record<string, PushOutcome | Error> = {}) {}
  async send(subscription: PushSubscriptionInfo, payload: string) {
    this.sent.push({ endpoint: subscription.endpoint, payload });
    const outcome = this.outcomes[subscription.endpoint] ?? 'sent';
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

describe('PushNotifier', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
    store.createTask(newTask);
    store.setPushSubscription(store.addDevice('phone', 'token-1').id, phone('https://push/1'));
    store.setPushSubscription(store.addDevice('tablet', 'token-2').id, phone('https://push/2'));
  });
  afterEach(() => store.close());

  it('pushes once to each subscribed device when a task enters review', async () => {
    const sender = new FakeSender();
    await new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    expect(sender.sent.map((s) => s.endpoint)).toEqual(['https://push/1', 'https://push/2']);
  });

  it('sends only the task id, title and status', async () => {
    const sender = new FakeSender();
    await new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    expect(sender.sent[0]!.payload).toBe(
      '{"taskId":1,"title":"Fix the login page","status":"review"}',
    );
  });

  it('sends no second push for a repeated event with the same status', async () => {
    const sender = new FakeSender();
    const notifier = new PushNotifier(store, sender, () => keys);
    await notifier.handle({ type: 'task', taskId: 1, status: 'review' });
    await notifier.handle({ type: 'task', taskId: 1, status: 'review' });
    expect(sender.sent).toHaveLength(2);
  });

  it('pushes again when the task comes back to review after running', async () => {
    const sender = new FakeSender();
    const notifier = new PushNotifier(store, sender, () => keys);
    await notifier.handle({ type: 'task', taskId: 1, status: 'review' });
    await notifier.handle({ type: 'task', taskId: 1, status: 'running' });
    await notifier.handle({ type: 'task', taskId: 1, status: 'review' });
    expect(sender.sent).toHaveLength(4);
  });

  it('does not push a task that was already in review when the board started', async () => {
    store.updateTask(1, { status: 'review' });
    const sender = new FakeSender();
    await new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    expect(sender.sent).toEqual([]);
  });

  it('does not push a status nobody needs to act on', async () => {
    const sender = new FakeSender();
    await new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'running',
    });
    expect(sender.sent).toEqual([]);
  });

  it('pushes nothing to a revoked device', async () => {
    store.revokeDevice(1);
    const sender = new FakeSender();
    await new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    expect(sender.sent.map((s) => s.endpoint)).toEqual(['https://push/2']);
  });

  it('deletes a subscription the push service reports gone', async () => {
    const sender = new FakeSender({ 'https://push/1': 'gone' });
    await new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    expect(store.listPushSubscriptions()).toEqual([
      { deviceId: 2, subscription: phone('https://push/2') },
    ]);
  });

  it('keeps a subscription the phone replaced while the push was in flight', async () => {
    const sender = new FakeSender({ 'https://push/1': 'gone' });
    const send = sender.send.bind(sender);
    sender.send = async (subscription, payload) => {
      store.setPushSubscription(1, phone('https://push/1-new'));
      return send(subscription, payload);
    };
    await new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    expect(store.listPushSubscriptions()[0]).toEqual({
      deviceId: 1,
      subscription: phone('https://push/1-new'),
    });
  });

  it('still pushes to the other devices when one push fails, then rejects', async () => {
    const sender = new FakeSender({ 'https://push/1': new Error('push service down') });
    const handled = new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    await expect(handled).rejects.toThrow('push failed');
    expect(sender.sent.map((s) => s.endpoint)).toEqual(['https://push/1', 'https://push/2']);
  });

  it('rejects naming the failed device and status, without the endpoint', async () => {
    const refused = new webpush.WebPushError('refused', 429, {}, 'body', 'https://push/1');
    const sender = new FakeSender({ 'https://push/1': refused });
    const handled = new PushNotifier(store, sender, () => keys).handle({
      type: 'task',
      taskId: 1,
      status: 'review',
    });
    await expect(handled).rejects.toThrow(/^push failed \(device 1: status 429\)$/);
  });

  it('does not load the keys when no device is subscribed', async () => {
    store.revokeDevice(1);
    store.revokeDevice(2);
    const loadKeys = () => {
      throw new Error('keys loaded');
    };
    await expect(
      new PushNotifier(store, new FakeSender(), loadKeys).handle({
        type: 'task',
        taskId: 1,
        status: 'review',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('isGone', () => {
  const pushError = (status: number) =>
    new webpush.WebPushError('push refused', status, {}, '', 'https://push/1');

  it('reads a 410 from the push service as a gone subscription', () => {
    expect(isGone(pushError(410))).toBe(true);
  });

  it('reads a 404 from the push service as a gone subscription', () => {
    expect(isGone(pushError(404))).toBe(true);
  });

  it('does not read a 429 from the push service as a gone subscription', () => {
    expect(isGone(pushError(429))).toBe(false);
  });

  it('does not read a network error as a gone subscription', () => {
    expect(isGone(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('describePushError', () => {
  it('gives the status of a push service error', () => {
    const err = new webpush.WebPushError('refused', 503, {}, 'reply', 'https://push/secret');
    expect(describePushError(err)).toBe('status 503');
  });

  it('gives the code of a network error', () => {
    const err = Object.assign(new Error('connect ECONNRESET https://push/secret'), {
      code: 'ECONNRESET',
    });
    expect(describePushError(err)).toBe('ECONNRESET');
  });

  it('gives only the name of an error without a code', () => {
    expect(describePushError(new SyntaxError('Unexpected token in "private-key"'))).toBe(
      'SyntaxError',
    );
  });
});

describe('push trigger in the API', () => {
  it('pushes to a subscribed phone when the harness reports a task entering review', async () => {
    harness.store.setPushSubscription(1, phone('https://push/1'));
    const { id } = harness.store.createTask(newTask);
    harness.store.updateTask(id, { status: 'review' });
    // Any change the harness announces carries the task's status; this one is the simplest.
    harness.setAutoApprove(id, true);
    await vi.waitFor(() => expect(pushed.sent.map((s) => s.endpoint)).toEqual(['https://push/1']));
  });

  it('logs a failed push by device and status, without the endpoint or the reply', async () => {
    const endpoint = 'https://push.example/send/secret-subscription-token';
    const refused = new webpush.WebPushError(
      'Received unexpected response code',
      429,
      { 'retry-after': '60', 'x-reply-header': 'secret-header' },
      'secret-reply-body',
      endpoint,
    );
    createApi(harness, new Sessions(), { pushSender: new FakeSender({ [endpoint]: refused }) });
    harness.store.setPushSubscription(1, phone(endpoint));
    const { id } = harness.store.createTask(newTask);
    harness.store.updateTask(id, { status: 'review' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    harness.setAutoApprove(id, true);
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    const calls = logged.mock.calls;
    logged.mockRestore();
    expect(calls).toEqual([['harnessboard: push failed (device 1: status 429)']]);
  });
});
