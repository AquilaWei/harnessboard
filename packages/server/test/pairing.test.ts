// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import type { Device, PairingCode, PairingSetup } from '@harnessboard/shared';
import { CLIENT_HEADER, access } from '../src/access.js';
import { createApi } from '../src/api.js';
import { Sessions } from '../src/session.js';

const PORT = 4999;
const REMOTE = 'box.tail1234.ts.net';
const START = 1_000_000;
let harness: Harness;
let app: Hono;
let clock: number;
let tailscale: string | null;

beforeEach(() => {
  const dir = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'hb-pairing-'));
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    port: PORT,
    remoteHosts: [REMOTE],
  });
  clock = START;
  tailscale = 'box.tail1234.ts.net';
  const sessions = new Sessions();
  app = new Hono();
  app.use(
    '*',
    access(harness, sessions, () => clock),
  );
  app.route(
    '/api',
    createApi(harness, sessions, {
      now: () => clock,
      detectTailscale: () => Promise.resolve(tailscale),
    }),
  );
});

afterEach(() => harness.store.close());

const local = { host: `127.0.0.1:${PORT}` };
const send = (method: string, url: string, headers: Record<string, string>, body: unknown = {}) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test', ...headers },
    body: JSON.stringify(body),
  });
const newCode = async () =>
  (await (await send('POST', '/api/pairing', local)).json()) as PairingCode;
const pair = (code: string, name = 'phone') =>
  send('POST', '/api/pair', { host: REMOTE }, { code, name });

describe('POST /api/pairing', () => {
  it('returns a 128-bit code', async () => {
    const { code } = await newCode();
    expect(Buffer.from(code, 'base64url').length).toBe(16);
  });

  it('returns a code that expires 5 minutes from now', async () => {
    const { expiresAt } = await newCode();
    expect(expiresAt).toBe(START + 300_000);
  });
});

describe('GET /api/pairing/setup', () => {
  it('returns the Tailscale name and the port', async () => {
    const res = await app.request('/api/pairing/setup', { headers: local });
    expect((await res.json()) as PairingSetup).toEqual({
      tailscaleHost: 'box.tail1234.ts.net',
      port: 4999,
    });
  });

  it('returns a null name when Tailscale is not running', async () => {
    tailscale = null;
    const res = await app.request('/api/pairing/setup', { headers: local });
    expect((await res.json()) as PairingSetup).toEqual({ tailscaleHost: null, port: 4999 });
  });
});

describe('POST /api/pair', () => {
  it('sets a year-long HttpOnly, Secure, SameSite=Strict device cookie', async () => {
    const res = await pair((await newCode()).code);
    expect(res.headers.get('set-cookie')).toMatch(
      /^hb_device=[A-Za-z0-9_-]{43}; Max-Age=31536000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    );
  });

  it('creates a device with the given name', async () => {
    await pair((await newCode()).code, 'Pixel 9');
    expect(harness.store.listDevices().map((d) => d.name)).toEqual(['Pixel 9']);
  });

  it('gives a cookie that lets the device go on to register a passkey', async () => {
    const res = await pair((await newCode()).code);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const options = await send('POST', '/api/passkey/options', { host: REMOTE, cookie });
    expect(options.status).toBe(200);
  });

  it('accepts a code just before it expires', async () => {
    const { code } = await newCode();
    clock = START + 299_999;
    expect((await pair(code)).status).toBe(201);
  });

  it('refuses a wrong code and creates no device', async () => {
    await newCode();
    const res = await pair('AAAAAAAAAAAAAAAAAAAAAA');
    expect([res.status, harness.store.listDevices()]).toEqual([400, []]);
  });

  it('refuses an expired code and creates no device', async () => {
    const { code } = await newCode();
    clock = START + 300_000;
    const res = await pair(code);
    expect([res.status, harness.store.listDevices()]).toEqual([400, []]);
  });

  it('refuses a code that was already used and creates no second device', async () => {
    const { code } = await newCode();
    await pair(code, 'first');
    const res = await pair(code, 'second');
    expect([res.status, harness.store.listDevices().map((d) => d.name)]).toEqual([400, ['first']]);
  });

  it('refuses a code that a newer code replaced', async () => {
    const { code } = await newCode();
    await newCode();
    expect((await pair(code)).status).toBe(400);
  });

  it('refuses a request without a device name', async () => {
    const { code } = await newCode();
    const res = await send('POST', '/api/pair', { host: REMOTE }, { code });
    expect(res.status).toBe(400);
  });

  it('answers 429 to a valid code after 5 failed attempts in a row', async () => {
    const { code } = await newCode();
    await pair('wrong-1');
    await pair('wrong-2');
    await pair('wrong-3');
    await pair('wrong-4');
    await pair('wrong-5');
    const res = await pair(code);
    expect([res.status, harness.store.listDevices()]).toEqual([429, []]);
  });

  it('still accepts a valid code after 4 failed attempts', async () => {
    const { code } = await newCode();
    await pair('wrong-1');
    await pair('wrong-2');
    await pair('wrong-3');
    await pair('wrong-4');
    expect((await pair(code)).status).toBe(201);
  });

  it('accepts pairing again once the computer makes a new code after a block', async () => {
    await newCode();
    await pair('wrong-1');
    await pair('wrong-2');
    await pair('wrong-3');
    await pair('wrong-4');
    await pair('wrong-5');
    const { code } = await newCode();
    expect((await pair(code)).status).toBe(201);
  });
});

describe('devices API', () => {
  it('lists each device with its name and last seen time', async () => {
    await pair((await newCode()).code, 'Pixel 9');
    const res = await app.request('/api/devices', { headers: local });
    const devices = (await res.json()) as Device[];
    expect(devices.map((d) => [d.name, d.lastSeenAt])).toEqual([['Pixel 9', START]]);
  });

  it('answers 401 to the next request of a revoked device', async () => {
    const res = await pair((await newCode()).code);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const { id } = (await res.json()) as Device;
    await send('DELETE', `/api/devices/${id}`, local);
    const options = await send('POST', '/api/passkey/options', { host: REMOTE, cookie });
    expect(options.status).toBe(401);
  });

  it('answers 404 when revoking a device that does not exist', async () => {
    const res = await send('DELETE', '/api/devices/42', local);
    expect(res.status).toBe(404);
  });
});
