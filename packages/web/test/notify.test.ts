// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { TaskMode, TaskStatus, TaskView } from '@harnessboard/shared';
import { newlyWaiting, openTab } from '../src/notify';

const task = (id: number, status: TaskStatus, mode: TaskMode = 'single') =>
  ({ id, status, mode }) as TaskView;

describe('newlyWaiting', () => {
  it('returns nothing on the first load', () => {
    expect(newlyWaiting(null, [task(1, 'review')])).toEqual([]);
  });

  it('returns a task that starts waiting for permission', () => {
    const prev = new Map<number, TaskStatus>([[1, 'running']]);
    expect(newlyWaiting(prev, [task(1, 'awaiting_permission')])).toEqual([
      task(1, 'awaiting_permission'),
    ]);
  });

  it('returns a task that reaches review', () => {
    const prev = new Map<number, TaskStatus>([[1, 'running']]);
    expect(newlyWaiting(prev, [task(1, 'review')])).toEqual([task(1, 'review')]);
  });

  it('returns a task whose plan waits for approval', () => {
    const prev = new Map<number, TaskStatus>([[1, 'running']]);
    expect(newlyWaiting(prev, [task(1, 'awaiting_approval')])).toEqual([
      task(1, 'awaiting_approval'),
    ]);
  });

  it('returns a task that fails', () => {
    const prev = new Map<number, TaskStatus>([[1, 'running']]);
    expect(newlyWaiting(prev, [task(1, 'failed')])).toEqual([task(1, 'failed')]);
  });

  it('skips a task still in the same status', () => {
    const prev = new Map<number, TaskStatus>([[1, 'review']]);
    expect(newlyWaiting(prev, [task(1, 'review')])).toEqual([]);
  });

  it('skips a task you stopped', () => {
    const prev = new Map<number, TaskStatus>([[1, 'running']]);
    expect(newlyWaiting(prev, [task(1, 'stopped')])).toEqual([]);
  });

  it('returns a new task that is already failed', () => {
    const prev = new Map<number, TaskStatus>();
    expect(newlyWaiting(prev, [task(2, 'failed')])).toEqual([task(2, 'failed')]);
  });
});

describe('openTab', () => {
  it('opens a task in review on its changes', () => {
    expect(openTab(task(1, 'review'))).toBe('changes');
  });

  it('opens a single task waiting for approval on its criteria', () => {
    expect(openTab(task(1, 'awaiting_approval', 'single'))).toBe('criteria');
  });

  it('opens a loop waiting for approval on its features', () => {
    expect(openTab(task(1, 'awaiting_approval', 'loop'))).toBe('features');
  });

  it('opens a task waiting for permission on the timeline', () => {
    expect(openTab(task(1, 'awaiting_permission'))).toBe('timeline');
  });
});
