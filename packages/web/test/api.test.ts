// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, isNotPaired } from '../src/api';

const answer = (status: number, body: string) =>
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status })));

afterEach(() => vi.unstubAllGlobals());

describe('isNotPaired', () => {
  it('is true for the 401 a device that is not paired gets', async () => {
    answer(401, '{"error":"this device is not paired"}');
    const err: unknown = await api.tasks().catch((e: unknown) => e);
    expect(isNotPaired(err)).toBe(true);
  });

  it('is false for other API errors', async () => {
    answer(403, '{"error":"forbidden host"}');
    const err: unknown = await api.tasks().catch((e: unknown) => e);
    expect(isNotPaired(err)).toBe(false);
  });

  it('keeps the server message on the error', async () => {
    answer(401, '{"error":"this device is not paired"}');
    await expect(api.tasks()).rejects.toThrow('this device is not paired');
  });
});
