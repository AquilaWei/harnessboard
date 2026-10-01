// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Task } from '@harnessboard/shared';
import { dueForRetry, quotaBlocks, startable } from '../src/scheduler.js';

const task = (id: number, status: Task['status'], resumeAt: number | null = null) =>
  ({ id, status, resumeAt }) as Task;

const quota = (fiveHour: number, status = 'allowed', resetsAt: number | null = 10_000) => ({
  status,
  fiveHourUtilization: fiveHour,
  sevenDayUtilization: null,
  fiveHourResetsAt: resetsAt,
  sevenDayResetsAt: null,
  resetsAt,
});

describe('quotaBlocks', () => {
  it('blocks at the pause threshold', () => {
    expect(quotaBlocks(quota(0.95), 0, 0.95)).toBe(true);
  });

  it('allows below the pause threshold', () => {
    expect(quotaBlocks(quota(0.5), 0, 0.95)).toBe(false);
  });

  it('blocks while requests are refused', () => {
    expect(quotaBlocks(quota(0.1, 'rejected'), 0, 0.95)).toBe(true);
  });

  it('ignores a snapshot whose window has reset', () => {
    expect(quotaBlocks(quota(1, 'rejected', 10_000), 10_000, 0.95)).toBe(false);
  });

  it('allows again once the five-hour window resets while the weekly one is limiting', () => {
    const weeklyLimiting = { ...quota(0.97), fiveHourResetsAt: 10_000, resetsAt: 900_000 };
    expect(quotaBlocks(weeklyLimiting, 10_000, 0.95)).toBe(false);
  });

  it('keeps blocking a refused request until the limiting window resets', () => {
    const weeklyRefused = {
      ...quota(0.2, 'rejected'),
      fiveHourResetsAt: 10_000,
      resetsAt: 900_000,
    };
    expect(quotaBlocks(weeklyRefused, 10_000, 0.95)).toBe(true);
  });
});

describe('dueForRetry', () => {
  it('returns quota-paused tasks whose retry time has passed', () => {
    const tasks = [task(1, 'waiting_quota', 50), task(2, 'waiting_quota', 200), task(3, 'queued')];
    expect(dueForRetry(tasks, 100).map((t) => t.id)).toEqual([1]);
  });
});

describe('startable', () => {
  it('fills the free slots with the oldest queued tasks', () => {
    const tasks = [task(1, 'queued'), task(2, 'queued'), task(3, 'queued')];
    expect(startable(tasks, new Map([[9, null]]), 3).map((t) => t.id)).toEqual([1, 2]);
  });

  it('skips a queued task that is already starting', () => {
    const tasks = [task(1, 'queued'), task(2, 'queued')];
    expect(startable(tasks, new Map([[1, null]]), 2).map((t) => t.id)).toEqual([2]);
  });
});
