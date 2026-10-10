// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { cachedTailscaleHost } from '../src/tailscale-host.js';

function counting(host: string | null) {
  const state = { calls: 0 };
  return {
    state,
    detect: () => {
      state.calls++;
      return Promise.resolve(host);
    },
  };
}

describe('cachedTailscaleHost', () => {
  it('looks up the name once for requests close together', async () => {
    const { state, detect } = counting('pc.ts.net');
    const get = cachedTailscaleHost(detect, () => 0);
    await Promise.all([get(), get(), get()]);
    expect(state.calls).toBe(1);
  });

  it('keeps a found name for minutes', async () => {
    const { state, detect } = counting('pc.ts.net');
    let clock = 0;
    const get = cachedTailscaleHost(detect, () => clock);
    await get();
    clock = 4 * 60_000;
    await get();
    expect(state.calls).toBe(1);
  });

  it('looks again after a found name has aged', async () => {
    const { state, detect } = counting('pc.ts.net');
    let clock = 0;
    const get = cachedTailscaleHost(detect, () => clock);
    await get();
    clock = 6 * 60_000;
    await get();
    expect(state.calls).toBe(2);
  });

  it('looks again within seconds when Tailscale was not found', async () => {
    const { state, detect } = counting(null);
    let clock = 0;
    const get = cachedTailscaleHost(detect, () => clock);
    await get();
    clock = 6_000;
    await get();
    expect(state.calls).toBe(2);
  });
});
