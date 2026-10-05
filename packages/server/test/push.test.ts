// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import { CLIENT_HEADER, access } from '../src/access.js';
import { createApi } from '../src/api.js';
import { loadVapidKeys, parseSubscription } from '../src/push.js';
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
  app.route('/api', createApi(harness, sessions, { now: () => START }));
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

  it('makes the key file readable by its owner only', () => {
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
