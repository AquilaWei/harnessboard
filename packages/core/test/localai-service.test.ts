// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalAiService } from '../src/localai.js';
import { LocalAiServer } from '../src/localai-server.js';

let ai: LocalAiService;
let start: ReturnType<typeof vi.spyOn>;
let stop: ReturnType<typeof vi.spyOn>;
let generate: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  start = vi.spyOn(LocalAiServer.prototype, 'start').mockImplementation(async function (
    this: LocalAiServer,
    _command,
    model,
  ) {
    this.model = model;
  });
  stop = vi.spyOn(LocalAiServer.prototype, 'stop').mockImplementation(async function (
    this: LocalAiServer,
  ) {
    this.model = null;
  });
  generate = vi
    .spyOn(LocalAiServer.prototype, 'generate')
    .mockResolvedValue({ answer: 'answer', reasoning: '' });
  ai = new LocalAiService({
    enabled: true,
    command: process.execPath,
    models: { pricing: 'price', slug: 'slug', commit: 'commit' },
  });
});
afterEach(async () => {
  await ai.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('keeps a loaded model across consecutive questions and unloads after five idle minutes', async () => {
  await ai.request('chat', 'one', { timeoutMs: 10000 });
  await vi.advanceTimersByTimeAsync(299999);
  expect(stop).not.toHaveBeenCalled();
  await ai.request('chat', 'two', { timeoutMs: 10000 });
  await vi.advanceTimersByTimeAsync(299999);
  expect(stop).not.toHaveBeenCalled();
  expect(ai.status().loadedModel).toBe('lfm2.5');
  await vi.advanceTimersByTimeAsync(1);
  expect(ai.status().state).toBe('unloaded');
  await ai.request('chat', 'three', { timeoutMs: 10000 });
  expect(start).toHaveBeenLastCalledWith(process.execPath, 'lfm2.5', expect.any(AbortSignal));
});
it('does not unload while work is active or queued and applies selection after active work', async () => {
  let finish!: (value: { answer: string; reasoning: string }) => void;
  generate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = ai.request('slug', 'one', { timeoutMs: 1000000 });
  const second = ai.request('commit', 'two', { timeoutMs: 1000000 });
  await vi.advanceTimersByTimeAsync(300001);
  expect(stop).not.toHaveBeenCalled();
  expect(ai.status()).toMatchObject({ running: { model: 'slug' }, queued: 1 });
  ai.selectModel('global');
  expect(ai.status()).toMatchObject({ selectedModel: 'global', loadedModel: 'slug' });
  finish({ answer: 'first', reasoning: '' });
  await Promise.all([first, second]);
  expect(start).toHaveBeenLastCalledWith(process.execPath, 'global', expect.any(AbortSignal));
});
it('recovers the queue after a failed service request', async () => {
  generate.mockRejectedValueOnce(new Error('service exited'));
  expect(await ai.request('chat', 'one', { timeoutMs: 10000 })).toEqual({
    status: 'failed',
    reason: 'service exited',
  });
  expect(await ai.request('chat', 'two', { timeoutMs: 10000 })).toMatchObject({ status: 'ok' });
  expect(ai.status().lastError).toBeNull();
});
it('reaps its service on shutdown and refuses later requests', async () => {
  await ai.request('chat', 'one', { timeoutMs: 10000 });
  await ai.close();
  expect(stop).toHaveBeenCalled();
  expect(await ai.request('chat', 'two', { timeoutMs: 10000 })).toMatchObject({ status: 'failed' });
});
it('retains purpose defaults until a global model is selected', async () => {
  await ai.request('pricing', 'one', { timeoutMs: 10000 });
  expect(ai.status().loadedModel).toBe('price');
  ai.selectModel('global');
  await ai.request('slug', 'two', { timeoutMs: 10000 });
  expect(ai.status().loadedModel).toBe('global');
});

it('times out active work, unloads its service and permits the next request', async () => {
  generate.mockImplementationOnce(
    (_prompt: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const first = ai.request('chat', 'one', { timeoutMs: 100 });
  const second = ai.request('chat', 'two', { timeoutMs: 10000 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await first).toEqual({ status: 'failed', reason: 'timed out after 100 ms' });
  expect(await second).toMatchObject({ status: 'ok' });
  expect(stop).toHaveBeenCalled();
});
it('recovers from a failed model load', async () => {
  start.mockRejectedValueOnce(new Error('model load failed'));
  expect(await ai.request('chat', 'one', { timeoutMs: 10000 })).toEqual({
    status: 'failed',
    reason: 'model load failed',
  });
  expect(ai.status()).toMatchObject({ state: 'error', loadedModel: null });
  expect(await ai.request('chat', 'two', { timeoutMs: 10000 })).toMatchObject({ status: 'ok' });
});
