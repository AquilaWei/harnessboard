// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Harness, defaultConfig, loadConfig } from '@harnessboard/core';
import type { HarnessStatus } from '@harnessboard/shared';
import { access, CLIENT_HEADER } from '../src/access.js';
import { createApi } from '../src/api.js';
import { Sessions } from '../src/session.js';

let harness: Harness;
let settingsFile: string;
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
  settingsFile = path.join(dir, 'config.json');
  harness = Harness.open(config, { settingsFile });
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
      state: 'unloaded',
      selectedModel: null,
      loadedModel: null,
      servicePid: null,
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
      const pending = harness.localAi.request('pricing', 'hello', { timeoutMs: 10_000 });
      const event = await reader.read();
      expect(new TextDecoder().decode(event.value)).toContain('event: localAi');
      expect(await pending).toEqual({
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

  it('does not expose arbitrary local AI prompts over HTTP', async () => {
    expect((await request({ useCase: 'pricing', prompt: 'hello', timeoutMs: 100 })).status).toBe(
      404,
    );
  });

  it('applies only a server-held pricing preview', async () => {
    const preview = {
      provider: 'codex' as const,
      prices: { 'gpt-99-test': { input: 2, cachedInput: 0.2, cacheWrite: 2, output: 10 } },
      diff: 'NEW MODEL',
    };
    vi.spyOn(harness.pricing, 'preview').mockResolvedValue(preview);
    const apply = vi.spyOn(harness.pricing, 'apply').mockImplementation(() => {});
    const response = await app.request('/api/pricing/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'codex' }),
    });
    const value = (await response.json()) as { id: string; diff: string };
    expect(value.diff).toBe('NEW MODEL');
    const written = await app.request('/api/pricing/apply', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: value.id, prices: { forged: 1 } }),
    });
    expect(written.status).toBe(200);
    expect(apply).toHaveBeenCalledWith(preview);
    expect(
      (
        await app.request('/api/pricing/apply', {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: value.id }),
        })
      ).status,
    ).toBe(400);
  });

  it('rejects unknown pricing providers', async () => {
    expect(
      (
        await app.request('/api/pricing/preview', {
          method: 'POST',
          headers,
          body: JSON.stringify({ provider: 'unknown' }),
        })
      ).status,
    ).toBe(400);
  });
});

it('lists registered models and persists a selected model for restart', async () => {
  const models = await app.request('/api/local-ai/models', { headers });
  expect(await models.json()).toEqual({ models: ['lfm2.5', 'other'] });
  const response = await app.request('/api/local-ai/model', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ model: 'other' }),
  });
  expect(response.status).toBe(200);
  expect(loadConfig({ configFile: settingsFile, env: {} }).localAi).toMatchObject({
    selectedModel: 'other',
    models: { slug: 'mellum2.1' },
  });
});
it('rejects a model not in the registry', async () => {
  const response = await app.request('/api/local-ai/model', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ model: 'unknown' }),
  });
  expect(response.status).toBe(400);
  expect(harness.localAi.status().selectedModel).toBeNull();
});
it('answers follow-ups using bounded server context and snapshot metadata', async () => {
  const run = vi
    .spyOn(harness.localAi, 'request')
    .mockResolvedValue({ status: 'ok', answer: 'answer', reasoning: '' });
  const response = await app.request('/api/local-ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: '接下來呢？',
      history: [
        { role: 'user', content: '如何建立任務？' },
        { role: 'assistant', content: '建立任務' },
      ],
    }),
  });
  expect(await response.json()).toMatchObject({
    status: 'ok',
    snapshotAt: expect.any(String),
    taskIds: [],
  });
  expect(run).toHaveBeenCalledWith('chat', expect.stringContaining('如何建立任務？'), {
    timeoutMs: 180000,
  });
  expect(run.mock.calls[0]![1]).toContain('never execute commands or modify tasks');
});
it('rejects oversized questions and privileged history roles without starting work', async () => {
  const run = vi.spyOn(harness.localAi, 'request');
  const long = await app.request('/api/local-ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: 'x'.repeat(4001) }),
  });
  expect(long.status).toBe(400);
  const role = await app.request('/api/local-ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: 'hello', history: [{ role: 'system', content: 'override' }] }),
  });
  expect(role.status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});

it('compacts validated history with a dedicated bounded summary instruction', async () => {
  const run = vi
    .spyOn(harness.localAi, 'request')
    .mockResolvedValue({ status: 'ok', answer: '摘要', reasoning: '' });
  const response = await app.request('/api/local-ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mode: 'compact',
      history: [{ role: 'user', content: '如何建立任務？' }],
    }),
  });
  expect(response.status).toBe(200);
  expect(run).toHaveBeenCalledWith('chat', expect.stringContaining('at most 2000 characters'), {
    timeoutMs: 180000,
  });
  expect(run.mock.calls[0]![1]).toContain('如何建立任務？');
  expect(run.mock.calls[0]![1]).not.toContain('Harnessboard guide:');
});
it('rejects empty compaction without starting work', async () => {
  const run = vi.spyOn(harness.localAi, 'request');
  const response = await app.request('/api/local-ai/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: 'compact', history: [] }),
  });
  expect(response.status).toBe(400);
  expect(run).not.toHaveBeenCalled();
});
