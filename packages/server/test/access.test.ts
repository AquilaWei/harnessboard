// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import { CLIENT_HEADER, access } from '../src/access.js';
import { createApi } from '../src/api.js';

const PORT = 4999;
const REMOTE = 'box.tail1234.ts.net';
const TOKEN = 'device-token';
let harness: Harness;
let app: Hono;
let clock: number;

beforeEach(() => {
  const dir = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'hb-access-'));
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    port: PORT,
    remoteHosts: [REMOTE],
  });
  const { id } = harness.store.addDevice('phone', TOKEN, 0);
  harness.store.setDevicePasskey(
    id,
    { credentialId: 'cred', publicKey: new Uint8Array([1]), counter: 0 },
    0,
  );
  clock = 0;
  app = new Hono();
  app.use(
    '*',
    access(harness, () => clock),
  );
  app.route('/api', createApi(harness));
  app.get('*', (c) => c.text('index.html'));
});

afterEach(() => harness.store.close());

const remote = { host: REMOTE };
const paired = { host: REMOTE, cookie: `hb_device=${TOKEN}` };
const write = (method: string, url: string, headers: Record<string, string>, body: unknown = {}) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test', ...headers },
    body: JSON.stringify(body),
  });

describe('access from a remote host', () => {
  it('answers 401 to an API request without a device cookie', async () => {
    const res = await app.request('/api/tasks', { headers: remote });
    expect(res.status).toBe(401);
  });

  it('answers 200 to an API request with a paired device cookie', async () => {
    const res = await app.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(200);
  });

  it('answers 401 to a revoked device cookie', async () => {
    harness.store.revokeDevice(harness.store.listDevices()[0]!.id);
    const res = await app.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(401);
  });

  it('answers 401 to an unknown device cookie', async () => {
    const res = await app.request('/api/tasks', {
      headers: { host: REMOTE, cookie: 'hb_device=not-a-device' },
    });
    expect(res.status).toBe(401);
  });

  it('matches the remote host without regard to case', async () => {
    const res = await app.request('/api/tasks', {
      headers: { host: 'Box.Tail1234.TS.net', cookie: `hb_device=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a non-GET request without the client header even with a valid cookie', async () => {
    const res = await app.request('/api/tasks/1/stop', { method: 'POST', headers: paired });
    expect(res.status).toBe(403);
  });

  it('serves static files without a device cookie', async () => {
    const res = await app.request('/', { headers: remote });
    expect([res.status, await res.text()]).toEqual([200, 'index.html']);
  });

  it('lets pairing through without a device cookie', async () => {
    const made = await write('POST', '/api/pairing', { host: `127.0.0.1:${PORT}` });
    const { code } = (await made.json()) as { code: string };
    const res = await write('POST', '/api/pair', remote, { code, name: 'tablet' });
    expect(res.status).toBe(201);
  });

  it('stops accepting a remote host as soon as the setting drops it', async () => {
    harness.updateSettings({ remoteHosts: [] });
    const res = await app.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(403);
  });
});

describe('access from an unknown host', () => {
  it('answers 403 to a Host that is neither loopback nor a remote host', async () => {
    const res = await app.request('/api/tasks', {
      headers: { host: 'evil.example', cookie: `hb_device=${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('answers 403 to static files on an unknown Host', async () => {
    const res = await app.request('/', { headers: { host: 'evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('access through a proxy on loopback', () => {
  const host = `127.0.0.1:${PORT}`;

  it('treats a loopback Host with X-Forwarded-For as remote', async () => {
    const res = await app.request('/api/tasks', {
      headers: { host, 'x-forwarded-for': '100.64.0.2' },
    });
    expect(res.status).toBe(401);
  });

  it('treats a loopback Host with X-Forwarded-Host as remote', async () => {
    const res = await app.request('/api/tasks', {
      headers: { host, 'x-forwarded-host': REMOTE },
    });
    expect(res.status).toBe(401);
  });

  it('treats a loopback Host with Forwarded as remote', async () => {
    const res = await app.request('/api/tasks', {
      headers: { host, forwarded: 'for=100.64.0.2' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a Tailscale Funnel request on a loopback Host', async () => {
    const res = await app.request('/api/tasks', {
      headers: { host, 'tailscale-funnel-request': '?1' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a Tailscale Funnel request from a paired device', async () => {
    const res = await app.request('/api/tasks', {
      headers: { ...paired, 'tailscale-funnel-request': '?1' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses static files to a Tailscale Funnel request', async () => {
    const res = await app.request('/', {
      headers: { ...remote, 'tailscale-funnel-request': '?1' },
    });
    expect(res.status).toBe(403);
  });
});

const MINUTE = 60_000;

describe('lock of a paired remote device', () => {
  it('lets a device through after 29 idle minutes', async () => {
    clock = 29 * MINUTE;
    const res = await app.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(200);
  });

  it('answers 401 locked after 31 idle minutes', async () => {
    clock = 31 * MINUTE;
    const res = await app.request('/api/tasks', { headers: paired });
    expect([res.status, await res.json()]).toEqual([
      401,
      { error: 'this device is locked', locked: true },
    ]);
  });

  it('lets a locked device ask for a passkey challenge', async () => {
    clock = 31 * MINUTE;
    const res = await write('POST', '/api/auth/challenge', paired);
    expect(res.status).toBe(200);
  });

  it('stays unlocked while the device keeps being active', async () => {
    clock = 20 * MINUTE;
    await app.request('/api/tasks', { headers: paired });
    clock = 45 * MINUTE;
    const res = await app.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(200);
  });

  it('unlocks after a passed passkey check', async () => {
    harness.store.markDeviceVerified(harness.store.listDevices()[0]!.id, 0, 40 * MINUTE);
    clock = 41 * MINUTE;
    const res = await app.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(200);
  });
});

describe('last active time of a device', () => {
  it('is written by a request once a minute has passed', async () => {
    clock = 20 * MINUTE;
    await app.request('/api/tasks', { headers: paired });
    expect(harness.store.findDeviceByToken(TOKEN)!.lastActiveAt).toBe(20 * MINUTE);
  });

  it('is not written again within a minute', async () => {
    clock = 59_999;
    await app.request('/api/tasks', { headers: paired });
    expect(harness.store.findDeviceByToken(TOKEN)!.lastActiveAt).toBe(0);
  });

  it('is not written by a request the lock refused', async () => {
    clock = 31 * MINUTE;
    await app.request('/api/tasks', { headers: paired });
    expect(harness.store.findDeviceByToken(TOKEN)!.lastActiveAt).toBe(0);
  });
});

describe('sensitive routes from a paired remote device', () => {
  it('lets POST /tasks through within 5 minutes of a passkey check', async () => {
    clock = 5 * MINUTE;
    const res = await write('POST', '/api/tasks', paired, {});
    expect(res.status).toBe(400);
  });

  it('answers 401 reauth to POST /tasks more than 5 minutes after a passkey check', async () => {
    clock = 5 * MINUTE + 1;
    const res = await write('POST', '/api/tasks', paired, {});
    expect([res.status, await res.json()]).toEqual([
      401,
      { error: 'confirm with your passkey first', reauth: true },
    ]);
  });

  it('lets PUT /settings through within 5 minutes of a passkey check', async () => {
    clock = 5 * MINUTE;
    const res = await write('PUT', '/api/settings', paired, { maxConcurrent: 5 });
    expect([res.status, harness.settings().maxConcurrent]).toEqual([200, 5]);
  });

  it('answers 401 reauth to PUT /settings more than 5 minutes after a passkey check', async () => {
    clock = 5 * MINUTE + 1;
    const res = await write('PUT', '/api/settings', paired, { maxConcurrent: 5 });
    expect([res.status, harness.settings().maxConcurrent]).toEqual([401, 1]);
  });

  it('lets GET /devices through within 5 minutes of a passkey check', async () => {
    clock = 5 * MINUTE;
    const res = await app.request('/api/devices', { headers: paired });
    expect(res.status).toBe(200);
  });

  it('answers 401 reauth to DELETE /tasks/:id after 5 minutes', async () => {
    clock = 6 * MINUTE;
    const res = await write('DELETE', '/api/tasks/1', paired);
    expect(res.status).toBe(401);
  });

  it('answers 401 reauth to POST /tasks/:id/plan/approve after 5 minutes', async () => {
    clock = 6 * MINUTE;
    const res = await write('POST', '/api/tasks/1/plan/approve', paired);
    expect(res.status).toBe(401);
  });

  it('does not ask for a passkey on GET /tasks/:id after 5 minutes', async () => {
    clock = 6 * MINUTE;
    const res = await app.request('/api/tasks/1', { headers: paired });
    expect(res.status).toBe(404);
  });

  it('does not ask for a passkey on GET /settings after 5 minutes', async () => {
    clock = 6 * MINUTE;
    const res = await app.request('/api/settings', { headers: paired });
    expect(res.status).toBe(200);
  });
});

describe('lock and reauth on loopback', () => {
  const local = { host: `127.0.0.1:${PORT}` };

  it('never locks a loopback request', async () => {
    clock = 31 * MINUTE;
    const res = await app.request('/api/tasks', { headers: local });
    expect(res.status).toBe(200);
  });

  it('never asks a loopback request for a passkey on a sensitive route', async () => {
    clock = 6 * MINUTE;
    const res = await write('PUT', '/api/settings', local, { maxConcurrent: 5 });
    expect([res.status, harness.settings().maxConcurrent]).toEqual([200, 5]);
  });
});

describe('last seen time of a device', () => {
  it('is not written again within a minute', async () => {
    clock = 59_999;
    await app.request('/api/tasks', { headers: paired });
    expect(harness.store.listDevices()[0]!.lastSeenAt).toBe(0);
  });

  it('is written once a minute has passed', async () => {
    clock = 60_000;
    await app.request('/api/tasks', { headers: paired });
    expect(harness.store.listDevices()[0]!.lastSeenAt).toBe(60_000);
  });

  it('is not written by a local request', async () => {
    clock = 120_000;
    await app.request('/api/tasks', {
      headers: { host: `127.0.0.1:${PORT}`, cookie: `hb_device=${TOKEN}` },
    });
    expect(harness.store.listDevices()[0]!.lastSeenAt).toBe(0);
  });
});
