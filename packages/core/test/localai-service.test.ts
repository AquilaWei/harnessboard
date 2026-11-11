// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAiService } from '../src/localai.js';
import type { LocalAiConfig } from '../src/localai.js';
import { tempDir } from './helpers.js';

const binary = fileURLToPath(new URL('./fixtures/fake-localai.mjs', import.meta.url));
const models = { pricing: 'gpt-oss-20b', slug: 'mellum2.1', commit: 'lfm2.5' };
const options = { timeoutMs: 10_000 };
const success = {
  delayMs: 100,
  lines: [
    { type: 'start', data: {} },
    { type: 'delta', data: { channel: 'answer', text: 'answer' } },
    { type: 'usage', data: {} },
    { type: 'done', data: {} },
  ],
};
let dir: string;

beforeEach(() => {
  dir = tempDir('localai-service');
  writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(success));
  vi.stubEnv('FAKE_LOCALAI_SCENARIO', path.join(dir, 'scenario.json'));
  vi.stubEnv('FAKE_LOCALAI_LOG', path.join(dir, 'log'));
  vi.stubEnv('FAKE_LOCALAI_LIFECYCLE', path.join(dir, 'lifecycle'));
});
afterEach(() => vi.unstubAllEnvs());

function service(overrides: Partial<LocalAiConfig> = {}) {
  return new LocalAiService({ enabled: true, command: binary, models, ...overrides });
}

describe('LocalAiService', () => {
  it('runs all use cases in FIFO order without overlapping processes', async () => {
    const ai = service();
    const results = await Promise.all([
      ai.request('pricing', 'first', options),
      ai.request('slug', 'second', options),
      ai.request('commit', 'third', options),
    ]);
    expect(results).toEqual([
      { status: 'ok', answer: 'answer', reasoning: '' },
      { status: 'ok', answer: 'answer', reasoning: '' },
      { status: 'ok', answer: 'answer', reasoning: '' },
    ]);
    expect(readFileSync(path.join(dir, 'lifecycle'), 'utf8')).toBe(
      '{"event":"start","stdin":"first"}\n{"event":"end","stdin":"first"}\n' +
        '{"event":"start","stdin":"second"}\n{"event":"end","stdin":"second"}\n' +
        '{"event":"start","stdin":"third"}\n{"event":"end","stdin":"third"}\n',
    );
    expect(
      readFileSync(path.join(dir, 'log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).args),
    ).toEqual([
      ['run', '--json', '--model', 'gpt-oss-20b'],
      ['run', '--json', '--model', 'mellum2.1'],
      ['run', '--json', '--model', 'lfm2.5'],
    ]);
  });

  it('reports the running use case, model and number waiting', async () => {
    const ai = service();
    const first = ai.request('slug', 'first', options);
    const second = ai.request('commit', 'second', options);
    await Promise.resolve();
    expect(ai.status()).toEqual({
      state: 'running',
      command: binary,
      models,
      running: { useCase: 'slug', model: 'mellum2.1', startedAt: expect.any(Number) },
      queued: 1,
      lastError: null,
    });
    await Promise.all([first, second]);
    expect(ai.status()).toMatchObject({ state: 'idle', running: null, queued: 0 });
  });

  it('returns unavailable without spawning when disabled', async () => {
    const ai = service({ enabled: false });
    expect(ai.status()).toEqual({
      state: 'disabled',
      command: null,
      models,
      running: null,
      queued: 0,
      lastError: null,
    });
    expect(await ai.request('pricing', 'hello', options)).toMatchObject({ status: 'unavailable' });
    expect(existsSync(path.join(dir, 'log'))).toBe(false);
  });

  it('reports a missing binary without spawning', async () => {
    const ai = service({ command: path.join(dir, 'missing') });
    expect(ai.status()).toMatchObject({ state: 'missing', command: null });
    expect(await ai.request('pricing', 'hello', options)).toMatchObject({ status: 'unavailable' });
    expect(existsSync(path.join(dir, 'log'))).toBe(false);
  });

  it('records a timeout and still runs the next queued request', async () => {
    const ai = service();
    const first = ai.request('pricing', 'first', { timeoutMs: 10 });
    const second = ai.request('commit', 'second', options);
    expect(await first).toEqual({ status: 'failed', reason: 'timed out after 10 ms' });
    expect(await second).toMatchObject({ status: 'ok' });
    expect(ai.status()).toMatchObject({
      state: 'idle',
      queued: 0,
      lastError: { useCase: 'pricing', message: 'timed out after 10 ms', at: expect.any(Number) },
    });
  });

  it('returns failure and records malformed output', async () => {
    writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ lines: ['bad output'] }));
    const ai = service();
    expect(await ai.request('slug', 'hello', options)).toEqual({
      status: 'failed',
      reason: 'localai printed a line that is not JSON',
    });
    expect(ai.status().lastError).toEqual({
      useCase: 'slug',
      message: 'localai printed a line that is not JSON',
      at: expect.any(Number),
    });
  });

  it('cancels a queued request without spawning it', async () => {
    const ai = service();
    const first = ai.request('pricing', 'first', options);
    const controller = new AbortController();
    const second = ai.request('slug', 'second', { ...options, signal: controller.signal });
    controller.abort();
    await first;
    expect(await second).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('returns snapshots that cannot mutate service status', () => {
    const ai = service();
    ai.status().models.slug = 'other';
    expect(ai.status().models.slug).toBe('mellum2.1');
  });
});
