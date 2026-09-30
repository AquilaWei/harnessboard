// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { TaskStatus, TaskView } from '@harnessboard/shared';
import { dropAction, primaryAction, stageOf } from '../src/board';

const task = (status: TaskStatus) => ({ status }) as TaskView;

describe('stageOf', () => {
  it('puts quota-paused tasks with the active ones', () => {
    expect(stageOf('waiting_quota')).toBe('active');
  });

  it('puts failed tasks in Needs you', () => {
    expect(stageOf('failed')).toBe('attention');
  });
});

describe('primaryAction', () => {
  it('offers Start for a draft', () => {
    expect(primaryAction(task('backlog'))).toBe('start');
  });

  it('offers Stop while waiting for quota', () => {
    expect(primaryAction(task('waiting_quota'))).toBe('stop');
  });

  it('offers Review for a finished task', () => {
    expect(primaryAction(task('review'))).toBe('review');
  });

  it('offers Retry for a failed task', () => {
    expect(primaryAction(task('failed'))).toBe('retry');
  });

  it('offers nothing for a done task', () => {
    expect(primaryAction(task('done'))).toBeNull();
  });
});

describe('dropAction', () => {
  it('queues a draft dropped on In progress', () => {
    expect(dropAction(task('backlog'), 'active')).toBe('queue');
  });

  it('queues a failed task dropped back on In progress', () => {
    expect(dropAction(task('failed'), 'active')).toBe('queue');
  });

  it('stops a running task dropped on Needs you', () => {
    expect(dropAction(task('running'), 'attention')).toBe('stop');
  });

  it('completes a reviewed task dropped on Done', () => {
    expect(dropAction(task('review'), 'done')).toBe('complete');
  });

  it('refuses to complete a failed task', () => {
    expect(dropAction(task('failed'), 'done')).toBeNull();
  });

  it('refuses to complete a running task', () => {
    expect(dropAction(task('running'), 'done')).toBeNull();
  });
});

describe('a plan waiting for approval', () => {
  it('is in Needs you', () => {
    expect(stageOf('awaiting_approval')).toBe('attention');
  });

  it('offers Review plan', () => {
    expect(primaryAction(task('awaiting_approval'))).toBe('approvePlan');
  });

  it('cannot be dragged back into progress', () => {
    expect(dropAction(task('awaiting_approval'), 'active')).toBeNull();
  });
});
