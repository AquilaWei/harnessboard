// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/client.js';

afterEach(() => vi.unstubAllGlobals());
it('CLI client previews with GET and executes with POST', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ entries: [], estimatedBytes: 0, removedBytes: 0 }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const client = new ApiClient('http://localhost:4317');
  await client.previewCleanup(19);
  expect(fetch.mock.calls[0]?.[0]).toBe('http://localhost:4317/api/tasks/19/cleanup');
  expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ entries: [], estimatedBytes: 0, removedBytes: 0 })),
  );
  await client.cleanupTask(19);
  expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
});
