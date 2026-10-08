// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import { CLIENT_HEADER, access } from '../src/access.js';
import { createApi } from '../src/api.js';
import { createWellKnown } from '../src/assetlinks.js';
import { SESSION_HEADER, Sessions } from '../src/session.js';

const PORT = 4999;
const REMOTE = 'box.tail1234.ts.net';
const TOKEN = 'device-token';
const FINGERPRINT =
  '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';
let harness: Harness;
let app: Hono;
let clock: number;
let sessions: Sessions;
let paired: Record<string, string>;
let deviceId: number;

beforeEach(() => {
  const dir = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'hb-access-'));
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    port: PORT,
    remoteHosts: [REMOTE],
    androidAppFingerprints: [FINGERPRINT],
  });
  deviceId = harness.store.addDevice('phone', TOKEN, 0).id;
  harness.store.setDevicePasskey(
    deviceId,
    { credentialId: 'cred', publicKey: new Uint8Array([1]), counter: 0 },
    0,
  );
  sessions = new Sessions();
  paired = {
    host: REMOTE,
    cookie: `hb_device=${TOKEN}`,
    [SESSION_HEADER]: sessions.open(deviceId),
  };
  clock = 0;
  app = new Hono();
  app.use(
    '*',
    access(harness, sessions, () => clock),
  );
  app.route('/api', createApi(harness, sessions));
  app.route('/.well-known', createWellKnown(harness));
  app.get('*', (c) => c.text('index.html'));
});

afterEach(() => harness.store.close());

const remote = { host: REMOTE };
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
      headers: { ...paired, host: 'Box.Tail1234.TS.net' },
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

describe('access to the Android asset links', () => {
  it('answers 200 to a remote host without a device cookie', async () => {
    const res = await app.request('/.well-known/assetlinks.json', { headers: remote });
    expect(res.status).toBe(200);
  });

  it('answers 200 to loopback', async () => {
    const res = await app.request('/.well-known/assetlinks.json', {
      headers: { host: `127.0.0.1:${PORT}` },
    });
    expect(res.status).toBe(200);
  });

  it('answers 403 to an unknown Host', async () => {
    const res = await app.request('/.well-known/assetlinks.json', {
      headers: { host: 'evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('answers 403 to a Tailscale Funnel request', async () => {
    const res = await app.request('/.well-known/assetlinks.json', {
      headers: { ...remote, 'tailscale-funnel-request': '?1' },
    });
    expect(res.status).toBe(403);
  });

  it('answers 404 to another /.well-known path from a remote host', async () => {
    const res = await app.request('/.well-known/security.txt', { headers: remote });
    expect(res.status).toBe(404);
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
    harness.store.markDeviceVerified(deviceId, 0, 40 * MINUTE);
    clock = 41 * MINUTE;
    const res = await app.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(200);
  });
});

describe('session of a paired remote device', () => {
  const cookieOnly = { host: REMOTE, cookie: `hb_device=${TOKEN}` };

  it('answers 401 locked to a request without a session token', async () => {
    const res = await app.request('/api/tasks', { headers: cookieOnly });
    expect([res.status, await res.json()]).toEqual([
      401,
      { error: 'this device is locked', locked: true },
    ]);
  });

  it('answers 401 locked to an unknown session token', async () => {
    const res = await app.request('/api/tasks', {
      headers: { ...cookieOnly, [SESSION_HEADER]: 'not-a-session' },
    });
    expect(res.status).toBe(401);
  });

  it('answers 401 locked once the server starts over with new sessions', async () => {
    const restarted = new Hono();
    restarted.use(
      '*',
      access(harness, new Sessions(), () => clock),
    );
    restarted.route('/api', createApi(harness, new Sessions()));
    const res = await restarted.request('/api/tasks', { headers: paired });
    expect(res.status).toBe(401);
  });

  it('lets a request without a session token ask for a passkey challenge', async () => {
    const res = await write('POST', '/api/auth/challenge', cookieOnly);
    expect(res.status).toBe(200);
  });

  it('takes the session token as a query parameter on the event stream', async () => {
    const res = await app.request(`/api/events?session=${paired[SESSION_HEADER]}`, {
      headers: cookieOnly,
    });
    await res.body?.cancel();
    expect(res.status).toBe(200);
  });

  it('ignores a session query parameter on any other route', async () => {
    const res = await app.request(`/api/tasks?session=${paired[SESSION_HEADER]}`, {
      headers: cookieOnly,
    });
    expect(res.status).toBe(401);
  });

  it('ends when the device is revoked', async () => {
    await write('DELETE', `/api/devices/${deviceId}`, { host: `127.0.0.1:${PORT}` });
    expect(sessions.has(deviceId, paired[SESSION_HEADER])).toBe(false);
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

  it('lets PUT /settings change the Android fingerprints within 5 minutes of a passkey check', async () => {
    clock = 5 * MINUTE;
    const res = await write('PUT', '/api/settings', paired, { androidAppFingerprints: [] });
    expect([res.status, harness.settings().androidAppFingerprints]).toEqual([200, []]);
  });

  it('answers 401 reauth to changing the Android fingerprints after 5 minutes', async () => {
    clock = 5 * MINUTE + 1;
    const res = await write('PUT', '/api/settings', paired, { androidAppFingerprints: [] });
    expect([res.status, harness.settings().androidAppFingerprints]).toEqual([401, [FINGERPRINT]]);
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

  it('answers 401 reauth to POST /tasks/:id/spec-revision after 5 minutes', async () => {
    clock = 6 * MINUTE;
    const res = await write('POST', '/api/tasks/1/spec-revision', paired, { message: 'x' });
    expect(res.status).toBe(401);
  });

  it('answers 401 reauth to POST /tasks/:id/spec-change/reject after 5 minutes', async () => {
    clock = 6 * MINUTE;
    const res = await write('POST', '/api/tasks/1/spec-change/reject', paired);
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
