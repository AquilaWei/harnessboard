// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import type { HarnessStatus } from '@harnessboard/shared';
import { access, CLIENT_HEADER } from '../src/access.js';
import { createApi } from '../src/api.js';
import { Sessions } from '../src/session.js';

let harness: Harness;
let app: Hono;
const headers = {
  host: '127.0.0.1:4999',
  [CLIENT_HEADER]: 'test',
  'content-type': 'application/json',
};
const binary = fileURLToPath(new URL('../../core/test/fixtures/fake-localai.mjs', import.meta.url));

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hb-localai-api-'));
  const scenario = path.join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      delayMs: 100,
      lines: [
        { type: 'start', data: {} },
        { type: 'delta', data: { channel: 'answer', text: 'answer' } },
        { type: 'usage', data: {} },
        { type: 'done', data: {} },
      ],
    }),
  );
  vi.stubEnv('FAKE_LOCALAI_SCENARIO', scenario);
  const config = defaultConfig({});
  config.dataDir = dir;
  config.port = 4999;
  config.localAi.enabled = true;
  config.localAi.command = binary;
  harness = Harness.open(config);
  const sessions = new Sessions();
  app = new Hono();
  app.use('*', access(harness, sessions));
  app.route('/api', createApi(harness, sessions));
});
afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
  vi.unstubAllEnvs();
});

const request = (body: unknown) =>
  app.request('/api/local-ai/request', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

describe('server local AI foundation', () => {
  it('includes the shared local AI snapshot in the status response', async () => {
    const response = await app.request('/api/status', { headers });
    expect(response.status).toBe(200);
    expect(((await response.json()) as HarnessStatus).localAi).toEqual({
      state: 'idle',
      command: binary,
      models: { pricing: 'gpt-oss-20b', slug: 'mellum2.1', commit: 'lfm2.5' },
      running: null,
      queued: 0,
      lastError: null,
    });
  });

  it('sends local AI status changes through the quota SSE channel', async () => {
    const events = vi.fn();
    const unsubscribe = harness.subscribe(events);
    const response = await app.request('/api/events', { headers });
    const reader = response.body!.getReader();
    await reader.read(); // Initial ping means the live subscription is installed.
    try {
      const pending = request({ useCase: 'pricing', prompt: 'hello', timeoutMs: 10_000 });
      const event = await reader.read();
      expect(new TextDecoder().decode(event.value)).toContain('event: localAi');
      expect(await (await pending).json()).toEqual({
        status: 'ok',
        answer: 'answer',
        reasoning: '',
      });
      expect(events).toHaveBeenCalledWith({
        type: 'localAi',
        localAi: expect.objectContaining({
          state: 'running',
          running: { useCase: 'pricing', model: 'gpt-oss-20b', startedAt: expect.any(Number) },
        }),
      });
      expect(events).toHaveBeenLastCalledWith({
        type: 'localAi',
        localAi: expect.objectContaining({ state: 'idle', running: null, queued: 0 }),
      });
    } finally {
      unsubscribe();
      await reader.cancel();
    }
  });

  it('shares the server queue across concurrent HTTP requests', async () => {
    const events = vi.fn();
    const unsubscribe = harness.subscribe(events);
    const responses = await Promise.all([
      request({ useCase: 'pricing', prompt: 'first', timeoutMs: 10_000 }),
      request({ useCase: 'slug', prompt: 'second', timeoutMs: 10_000 }),
    ]);
    expect(await responses[0]!.json()).toMatchObject({ status: 'ok' });
    expect(await responses[1]!.json()).toMatchObject({ status: 'ok' });
    expect(events).toHaveBeenCalledWith({
      type: 'localAi',
      localAi: expect.objectContaining({
        queued: 1,
        running: expect.objectContaining({ useCase: 'pricing' }),
      }),
    });
    unsubscribe();
  });

  it.each([
    { useCase: 'unknown', prompt: 'x', timeoutMs: 100 },
    { useCase: 'pricing', prompt: 1, timeoutMs: 100 },
    { useCase: 'pricing', prompt: 'x', timeoutMs: 0 },
    { useCase: 'pricing', prompt: 'x', timeoutMs: 2_147_483_648 },
  ])('rejects an invalid request: %j', async (body) => {
    expect((await request(body)).status).toBe(400);
  });
});
