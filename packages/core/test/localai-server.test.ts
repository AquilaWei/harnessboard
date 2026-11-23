// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalAiService } from '../src/localai.js';
import { loadFailure } from '../src/localai-server.js';
import { tempDir } from './helpers.js';

let ai: LocalAiService;
let dir: string;
beforeEach(() => {
  dir = tempDir('localai-http');
  const scenario = path.join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      pidFile: path.join(dir, 'pid'),
      lines: [{ type: 'delta', data: { channel: 'answer', text: '你好' } }],
    }),
  );
  vi.stubEnv('FAKE_LOCALAI_SCENARIO', scenario);
  ai = new LocalAiService({
    enabled: true,
    command: fileURLToPath(new URL('./fixtures/fake-localai.mjs', import.meta.url)),
    models: { pricing: 'a', slug: 'b', commit: 'c' },
  });
});
afterEach(async () => {
  await ai.close();
  vi.unstubAllEnvs();
});
it('reuses one HTTP service for consecutive questions and reaps it on close', async () => {
  expect(await ai.request('chat', 'one', { timeoutMs: 5000 })).toEqual({
    status: 'ok',
    answer: '你好',
    reasoning: '',
  });
  const pid = readFileSync(path.join(dir, 'pid'), 'utf8');
  expect(await ai.request('chat', 'two', { timeoutMs: 5000 })).toMatchObject({ status: 'ok' });
  expect(readFileSync(path.join(dir, 'pid'), 'utf8')).toBe(pid);
  await ai.close();
  expect(() => process.kill(Number(pid), 0)).toThrow();
});
it('reports unexpected exit and starts a fresh service on the next question', async () => {
  await ai.request('chat', 'one', { timeoutMs: 5000 });
  const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8'));
  process.kill(pid, 'SIGTERM');
  await vi.waitFor(() => expect(ai.status().state).toBe('error'));
  expect(await ai.request('chat', 'two', { timeoutMs: 5000 })).toMatchObject({ status: 'ok' });
  expect(Number(readFileSync(path.join(dir, 'pid'), 'utf8'))).not.toBe(pid);
});
it('does not launch any service when disabled', async () => {
  await ai.close();
  ai = new LocalAiService({
    enabled: false,
    command: null,
    models: { pricing: 'a', slug: 'b', commit: 'c' },
  });
  expect(await ai.request('chat', 'one', { timeoutMs: 5000 })).toMatchObject({
    status: 'unavailable',
  });
  expect(existsSync(path.join(dir, 'pid'))).toBe(false);
});
it('tells the user how to fix a memory preflight block', () => {
  expect(
    loadFailure('gpt-oss', 'error: memory preflight blocked; close workloads or reduce context\n'),
  ).toBe(
    'Not enough free memory to load gpt-oss: close other programs or select a smaller model, then retry (LocalAICLI: error: memory preflight blocked; close workloads or reduce context)',
  );
});
it('keeps LocalAICLI wording for other load failures', () => {
  expect(loadFailure('gpt-oss', 'bad gguf\n')).toBe('LocalAICLI failed to load: bad gguf');
});
