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
  harness.store.addDevice('phone', TOKEN, 0);
  clock = 0;
  app = new Hono();
  app.use(
    '*',
    access(harness, () => clock),
  );
  // Stands in for the pairing route of F3, which a device without a cookie must reach.
  app.post('/api/pair', (c) => c.text('paired'));
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
    const res = await write('POST', '/api/pair', remote);
    expect([res.status, await res.text()]).toEqual([200, 'paired']);
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

describe('settings-level routes from a paired remote device', () => {
  it('refuses PUT /settings', async () => {
    const res = await write('PUT', '/api/settings', paired, { maxConcurrent: 5 });
    expect([res.status, harness.settings().maxConcurrent]).toEqual([403, 1]);
  });

  it('refuses POST /agents', async () => {
    const res = await write('POST', '/api/agents', paired, { id: 'x', provider: 'codex' });
    expect(res.status).toBe(403);
  });

  it('refuses PUT /tasks/:id/auto-approve', async () => {
    const res = await write('PUT', '/api/tasks/1/auto-approve', paired, { on: true });
    expect(res.status).toBe(403);
  });

  it('refuses PUT /tasks/:id/allowed-tools', async () => {
    const res = await write('PUT', '/api/tasks/1/allowed-tools', paired, { rules: ['Bash'] });
    expect(res.status).toBe(403);
  });

  it('refuses POST /pairing', async () => {
    const res = await write('POST', '/api/pairing', paired);
    expect(res.status).toBe(403);
  });

  it('refuses GET /devices', async () => {
    const res = await app.request('/api/devices', { headers: paired });
    expect(res.status).toBe(403);
  });

  it('refuses DELETE /devices/:id', async () => {
    const res = await write('DELETE', '/api/devices/1', paired);
    expect(res.status).toBe(403);
  });

  it('still allows GET /settings', async () => {
    const res = await app.request('/api/settings', { headers: paired });
    expect(res.status).toBe(200);
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
