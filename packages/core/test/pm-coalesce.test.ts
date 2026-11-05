// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventCoalescer } from '../src/pm-coalesce.js';
import type { PendingEvents } from '../src/pm-coalesce.js';

const settings = { maxDelaySeconds: 20, thresholdCap: 3 };
let woken: number;
let coalescer: EventCoalescer;
const events = (patch: Partial<PendingEvents> = {}): PendingEvents => ({
  count: 1,
  oldestTs: Date.now(),
  urgent: false,
  highRisk: false,
  ...patch,
});

beforeEach(() => {
  vi.useFakeTimers();
  woken = 0;
  coalescer = new EventCoalescer(settings, () => woken++);
});
afterEach(() => {
  coalescer.clear();
  vi.useRealTimers();
});

describe('EventCoalescer.ready', () => {
  it('starts a batch at once with fewer than two running workers', () => {
    expect(coalescer.ready(1, events())).toBe(true);
  });

  it('holds one event while three workers run', () => {
    expect(coalescer.ready(3, events({ count: 1 }))).toBe(false);
  });

  it('starts a batch once the events reach the number of running workers', () => {
    expect(coalescer.ready(2, events({ count: 2 }))).toBe(true);
  });

  it('caps the threshold at 3 when more workers run', () => {
    expect(coalescer.ready(6, events({ count: 2 }))).toBe(false);
    expect(coalescer.ready(6, events({ count: 3 }))).toBe(true);
  });

  it('honors a configured threshold cap', () => {
    coalescer = new EventCoalescer({ ...settings, thresholdCap: 2 }, () => woken++);
    expect(coalescer.ready(6, events({ count: 2 }))).toBe(true);
  });

  it('starts a batch when the oldest event has waited the maximum delay', () => {
    expect(coalescer.ready(3, events({ oldestTs: Date.now() - 20_000 }))).toBe(true);
  });

  it('wakes the loop when the oldest event reaches the maximum delay', () => {
    coalescer.ready(3, events({ oldestTs: Date.now() - 5_000 }));
    vi.advanceTimersByTime(14_999);
    expect(woken).toBe(0);
    vi.advanceTimersByTime(1);
    expect(woken).toBe(1);
  });

  it('keeps a single timer however often it is asked', () => {
    coalescer.ready(3, events());
    coalescer.ready(3, events());
    coalescer.ready(3, events());
    expect(vi.getTimerCount()).toBe(1);
  });

  it('turns grouping off with a delay of 0', () => {
    coalescer = new EventCoalescer({ ...settings, maxDelaySeconds: 0 }, () => woken++);
    expect(coalescer.ready(3, events())).toBe(true);
  });

  it('starts a batch at once for a failed or stopped worker', () => {
    expect(coalescer.ready(3, events({ urgent: true }))).toBe(true);
  });

  it('starts a batch at once for a high-risk permission', () => {
    expect(coalescer.ready(3, events({ highRisk: true }))).toBe(true);
  });

  it('drops its timer when a batch starts', () => {
    coalescer.ready(3, events());
    coalescer.ready(1, events());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops its timer on clear', () => {
    coalescer.ready(3, events());
    coalescer.clear();
    expect(vi.getTimerCount()).toBe(0);
  });
});
