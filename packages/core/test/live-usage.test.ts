// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { LiveUsage } from '../src/live-usage.js';

const usage = (input: number, output = 0) => ({
  costUsd: null,
  models: { model: { input, output, cacheRead: 0, cacheWrite: 0, costUsd: null } },
});

describe('partial conversation usage', () => {
  it('starts unavailable when the provider has reported nothing', () => {
    expect(new LiveUsage().usage).toBeNull();
  });

  it('retains consumption from different calls', () => {
    const live = new LiveUsage();
    live.call('one', usage(10, 5));
    live.call('two', usage(20, 6));
    expect(live.usage).toEqual(usage(30, 11));
  });

  it('counts only field increments for repeated message blocks', () => {
    const live = new LiveUsage();
    live.call('one', usage(10, 5));
    live.call('one', usage(10, 6));
    live.call('one', usage(9, 4));
    live.call('one', usage(10, 6));
    expect(live.usage).toEqual(usage(10, 6));
  });

  it('retains the previous conversation totals when a resumed run is stopped', () => {
    const before = usage(100, 10);
    const live = new LiveUsage(before);
    live.call('new', usage(20, 5));
    expect(live.usage).toEqual(usage(120, 15));
    expect(before).toEqual(usage(100, 10));
  });

  it('uses the final provider report rather than adding partial usage again', () => {
    const live = new LiveUsage();
    live.call('one', usage(10, 5));
    live.snapshot(usage(10, 5));
    expect(live.usage).toEqual(usage(10, 5));
  });
});
