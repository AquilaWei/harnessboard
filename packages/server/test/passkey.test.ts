// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import { CLIENT_HEADER, access } from '../src/access.js';
import { createApi } from '../src/api.js';
import { webauthnVerifier } from '../src/passkey.js';
import type { PasskeyVerifier } from '../src/passkey.js';
import { SESSION_HEADER, Sessions } from '../src/session.js';

const PORT = 4999;
const REMOTE = 'box.tail1234.ts.net';
const START = 1_000_000;
const NEW_TOKEN = 'new-device-token';
const TOKEN = 'device-token';
let harness: Harness;
let app: Hono;
let clock: number;
let registrationChallenges: string[];

/**
 * Real options, fake signatures: a registration response `{valid: true}` passes, and an
 * authentication response `{counter}` passes with that counter. Anything else throws.
 */
const verifier: PasskeyVerifier = {
  ...webauthnVerifier,
  verifyRegistration: (response, challenge) => {
    registrationChallenges.push(challenge);
    if ((response as { valid?: boolean }).valid !== true) throw new Error('bad signature');
    return Promise.resolve({
      credentialId: 'cred-new',
      publicKey: new Uint8Array([7]),
      counter: 0,
    });
  },
  verifyAuthentication: (response) => {
    const { counter } = response as { counter?: number };
    if (counter === undefined) throw new Error('bad signature');
    return Promise.resolve(counter);
  },
};

beforeEach(() => {
  const dir = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'hb-passkey-'));
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    port: PORT,
    remoteHosts: [REMOTE],
  });
  harness.store.addDevice('new phone', NEW_TOKEN, START);
  const { id } = harness.store.addDevice('phone', TOKEN, START);
  harness.store.setDevicePasskey(
    id,
    { credentialId: 'cred-old', publicKey: new Uint8Array([1]), counter: 3 },
    START,
  );
  clock = START;
  registrationChallenges = [];
  const sessions = new Sessions();
  app = new Hono();
  app.use(
    '*',
    access(harness, sessions, () => clock),
  );
  app.route('/api', createApi(harness, sessions, { now: () => clock, verifier }));
});

afterEach(() => harness.store.close());

const newDevice = { host: REMOTE, cookie: `hb_device=${NEW_TOKEN}` };
const device = { host: REMOTE, cookie: `hb_device=${TOKEN}` };
const post = (url: string, headers: Record<string, string>, body: unknown = {}) =>
  app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test', ...headers },
    body: JSON.stringify(body),
  });
const stored = (token: string) => harness.store.findDeviceByToken(token)!;
const challengeAndVerify = async (response: unknown) => {
  await post('/api/auth/challenge', device);
  return post('/api/auth/verify', device, response);
};

describe('passkey registration after pairing', () => {
  it('offers options for the remote host as the relying party', async () => {
    const res = await post('/api/passkey/options', newDevice);
    const options = (await res.json()) as { rp: { id: string } };
    expect(options.rp.id).toBe('box.tail1234.ts.net');
  });

  it('offers options that require user verification', async () => {
    const res = await post('/api/passkey/options', newDevice);
    const options = (await res.json()) as { authenticatorSelection: { userVerification: string } };
    expect(options.authenticatorSelection.userVerification).toBe('required');
  });

  it('stores the passkey the phone registers', async () => {
    await post('/api/passkey/options', newDevice);
    await post('/api/passkey', newDevice, { valid: true });
    expect(stored(NEW_TOKEN).passkey).toEqual({
      credentialId: 'cred-new',
      publicKey: new Uint8Array([7]),
      counter: 0,
    });
  });

  it('checks the registration against the challenge it offered', async () => {
    const res = await post('/api/passkey/options', newDevice);
    const { challenge } = (await res.json()) as { challenge: string };
    await post('/api/passkey', newDevice, { valid: true });
    expect(registrationChallenges).toEqual([challenge]);
  });

  it('stores nothing when the registration does not verify', async () => {
    await post('/api/passkey/options', newDevice);
    const res = await post('/api/passkey', newDevice, { valid: false });
    expect([res.status, stored(NEW_TOKEN).passkey]).toEqual([400, null]);
  });

  it('refuses a registration without offered options', async () => {
    const res = await post('/api/passkey', newDevice, { valid: true });
    expect([res.status, stored(NEW_TOKEN).passkey]).toEqual([400, null]);
  });

  it('refuses to replace a passkey the device already has', async () => {
    const verified = await challengeAndVerify({ counter: 4 });
    const { session } = (await verified.json()) as { session: string };
    const res = await post('/api/passkey/options', { ...device, [SESSION_HEADER]: session });
    expect(res.status).toBe(409);
  });

  it('refuses registration more than 10 minutes after pairing', async () => {
    clock = START + 600_001;
    const res = await post('/api/passkey/options', newDevice);
    expect(res.status).toBe(403);
  });

  it('refuses registration from the computer itself', async () => {
    const res = await post('/api/passkey/options', { host: `127.0.0.1:${PORT}` });
    expect(res.status).toBe(400);
  });
});

describe('a device without a passkey', () => {
  it('gets 401 on the board API', async () => {
    const res = await app.request('/api/tasks', { headers: newDevice });
    expect(res.status).toBe(401);
  });

  it('gets 401 on a write to the board API', async () => {
    const res = await post('/api/tasks/1/stop', newDevice);
    expect(res.status).toBe(401);
  });

  it('reaches the passkey check routes', async () => {
    const res = await post('/api/auth/challenge', newDevice);
    expect(res.status).toBe(409);
  });

  it('can use the board API with the session its passkey registration started', async () => {
    await post('/api/passkey/options', newDevice);
    const registered = await post('/api/passkey', newDevice, { valid: true });
    const { session } = (await registered.json()) as { session: string };
    const res = await app.request('/api/tasks', {
      headers: { ...newDevice, [SESSION_HEADER]: session },
    });
    expect(res.status).toBe(200);
  });
});

describe('a new board session of a device that passed a check', () => {
  it('is locked two minutes after the check without its session token', async () => {
    await challengeAndVerify({ counter: 4 });
    clock = START + 2 * 60_000;
    const res = await app.request('/api/tasks', { headers: device });
    expect([res.status, await res.json()]).toEqual([
      401,
      { error: 'this device is locked', locked: true },
    ]);
  });

  it('is refused a sensitive route two minutes after the check without its session', async () => {
    await challengeAndVerify({ counter: 4 });
    clock = START + 2 * 60_000;
    const res = await post('/api/tasks', device, {});
    expect(res.status).toBe(401);
  });

  it('is unlocked by the session token of its next passed check', async () => {
    await challengeAndVerify({ counter: 4 });
    clock = START + 2 * 60_000;
    const res = await challengeAndVerify({ counter: 5 });
    const { session } = (await res.json()) as { session: string };
    const tasks = await app.request('/api/tasks', {
      headers: { ...device, [SESSION_HEADER]: session },
    });
    expect(tasks.status).toBe(200);
  });

  it('is locked when it sends the session token of another device', async () => {
    await post('/api/passkey/options', newDevice);
    const registered = await post('/api/passkey', newDevice, { valid: true });
    const { session } = (await registered.json()) as { session: string };
    const res = await app.request('/api/tasks', {
      headers: { ...device, [SESSION_HEADER]: session },
    });
    expect(res.status).toBe(401);
  });
});

describe('the passkey check', () => {
  it('offers a challenge for the device passkey only', async () => {
    const res = await post('/api/auth/challenge', device);
    const options = (await res.json()) as { allowCredentials: { id: string }[] };
    expect(options.allowCredentials.map((c) => c.id)).toEqual(['cred-old']);
  });

  it('offers a challenge that requires user verification on the remote host', async () => {
    const res = await post('/api/auth/challenge', device);
    const options = (await res.json()) as { rpId: string; userVerification: string };
    expect([options.rpId, options.userVerification]).toEqual(['box.tail1234.ts.net', 'required']);
  });

  it('records when the device passed the check', async () => {
    clock = START + 5000;
    await challengeAndVerify({ counter: 4 });
    expect(stored(TOKEN).verifiedAt).toBe(1_005_000);
  });

  it('answers a passed check with a session token', async () => {
    const res = await challengeAndVerify({ counter: 4 });
    const body = (await res.json()) as { ok: boolean; session: string };
    expect([body.ok, body.session]).toEqual([true, expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)]);
  });

  it('stores the new signature counter', async () => {
    await challengeAndVerify({ counter: 4 });
    expect(stored(TOKEN).passkey!.counter).toBe(4);
  });

  it('refuses a counter lower than the stored one', async () => {
    clock = START + 5000;
    const res = await challengeAndVerify({ counter: 2 });
    expect([res.status, stored(TOKEN).verifiedAt]).toEqual([400, START]);
  });

  it('refuses a slower check that finishes after a check with a higher counter', async () => {
    const answers: ((counter: number) => void)[] = [];
    const deferred: PasskeyVerifier = {
      ...verifier,
      verifyAuthentication: () => new Promise((resolve) => answers.push(resolve)),
    };
    const sessions = new Sessions();
    app = new Hono();
    app.use(
      '*',
      access(harness, sessions, () => clock),
    );
    app.route('/api', createApi(harness, sessions, { now: () => clock, verifier: deferred }));
    clock = START + 1000;
    await post('/api/auth/challenge', device);
    const slower = post('/api/auth/verify', device, {});
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    clock = START + 5000;
    await post('/api/auth/challenge', device);
    const faster = post('/api/auth/verify', device, {});
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!(5);
    await faster;
    answers[0]!(4);
    const res = await slower;
    expect([res.status, stored(TOKEN).passkey!.counter, stored(TOKEN).verifiedAt]).toEqual([
      400, 5, 1_005_000,
    ]);
  });

  it('refuses a signature that does not verify', async () => {
    const res = await challengeAndVerify({});
    expect(res.status).toBe(400);
  });

  it('refuses an answer without a challenge', async () => {
    const res = await post('/api/auth/verify', device, { counter: 4 });
    expect(res.status).toBe(400);
  });

  it('answers 429 after 5 failed checks in a row', async () => {
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    const res = await challengeAndVerify({ counter: 4 });
    expect(res.status).toBe(429);
  });

  it('still accepts the passkey after 4 failed checks', async () => {
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    const res = await challengeAndVerify({ counter: 4 });
    expect(res.status).toBe(200);
  });

  it('accepts the passkey again once the 15-minute block has passed', async () => {
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    await challengeAndVerify({});
    clock = START + 900_000;
    const res = await challengeAndVerify({ counter: 4 });
    expect(res.status).toBe(200);
  });
});
