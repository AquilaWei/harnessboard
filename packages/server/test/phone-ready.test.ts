// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepPhoneReady } from '../src/phone-ready.js';
import type { PhoneReadyDeps } from '../src/phone-ready.js';

function deps(over: Partial<PhoneReadyDeps> = {}) {
  const served: number[] = [];
  const logs: string[] = [];
  const all: PhoneReadyDeps = {
    hasDevices: () => true,
    detect: () => Promise.resolve('pc.tailnet.ts.net'),
    serve: (port) => {
      served.push(port);
      return Promise.resolve();
    },
    log: (m) => logs.push(m),
    ...over,
  };
  return { all, served, logs };
}

describe('keepPhoneReady', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves the port at start when a phone is paired and Tailscale runs', async () => {
    const { all, served } = deps();
    keepPhoneReady(4317, all)();
    await vi.advanceTimersByTimeAsync(0);
    expect(served).toEqual([4317]);
  });

  it('exposes nothing while no phone is paired', async () => {
    const { all, served } = deps({ hasDevices: () => false });
    keepPhoneReady(4317, all)();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(served).toEqual([]);
  });

  it('tries again after five minutes when Tailscale was not running', async () => {
    let name: string | null = null;
    const { all, served } = deps({ detect: () => Promise.resolve(name) });
    const stop = keepPhoneReady(4317, all);
    await vi.advanceTimersByTimeAsync(0);
    name = 'pc.tailnet.ts.net';
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    stop();
    expect(served).toEqual([4317]);
  });

  it('logs a refused serve and keeps trying', async () => {
    const { all, logs } = deps({ serve: () => Promise.reject(new Error('certs are off')) });
    const stop = keepPhoneReady(4317, all);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    stop();
    expect(logs).toEqual(['Phone access: certs are off', 'Phone access: certs are off']);
  });

  it('stops retrying once stopped', async () => {
    const { all, served } = deps({ detect: () => Promise.resolve(null) });
    keepPhoneReady(4317, all)();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(served).toEqual([]);
  });
});
