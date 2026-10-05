// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { TaskStatus, TaskView } from '@harnessboard/shared';
import { attentionTab, dropAction, groupByPhoneTab, primaryAction, stageOf } from '../src/board';

const task = (status: TaskStatus) => ({ status }) as TaskView;

describe('stageOf', () => {
  it('puts quota-paused tasks with the active ones', () => {
    expect(stageOf('waiting_quota')).toBe('active');
  });

  it('puts a task waiting for permission in Needs you', () => {
    expect(stageOf('awaiting_permission')).toBe('attention');
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

  it('offers an answer for a task waiting for permission', () => {
    expect(primaryAction(task('awaiting_permission'))).toBe('answerPermission');
  });

  it('offers nothing for a done task', () => {
    expect(primaryAction(task('done'))).toBeNull();
  });
});

describe('dropAction', () => {
  it('does not queue a task waiting for permission when dropped on In progress', () => {
    expect(dropAction(task('awaiting_permission'), 'active')).toBeNull();
  });

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

  it('offers Review criteria for a single task', () => {
    const single = { ...task('awaiting_approval'), mode: 'single' } as TaskView;
    expect(primaryAction(single)).toBe('approveCriteria');
  });

  it('cannot be dragged back into progress', () => {
    expect(dropAction(task('awaiting_approval'), 'active')).toBeNull();
  });
});

describe('groupByPhoneTab', () => {
  const withId = (id: number, status: TaskStatus) => ({ id, status }) as TaskView;

  it('puts a task waiting for permission under Waiting for you', () => {
    expect(groupByPhoneTab([withId(1, 'awaiting_permission')]).waiting).toEqual([
      withId(1, 'awaiting_permission'),
    ]);
  });

  it('puts a draft under Waiting for you', () => {
    expect(groupByPhoneTab([withId(1, 'backlog')]).waiting).toEqual([withId(1, 'backlog')]);
  });

  it('puts a quota-paused task under In progress', () => {
    expect(groupByPhoneTab([withId(1, 'waiting_quota')]).active).toEqual([
      withId(1, 'waiting_quota'),
    ]);
  });

  it('puts a finished task to review under Review, not Waiting for you', () => {
    expect(groupByPhoneTab([withId(1, 'review')])).toEqual({
      waiting: [],
      active: [],
      review: [withId(1, 'review')],
      done: [],
    });
  });

  it('puts a done task under Done', () => {
    expect(groupByPhoneTab([withId(1, 'done')]).done).toEqual([withId(1, 'done')]);
  });

  it('keeps the given order within a tab', () => {
    expect(groupByPhoneTab([withId(1, 'failed'), withId(2, 'stopped')]).waiting).toEqual([
      withId(1, 'failed'),
      withId(2, 'stopped'),
    ]);
  });
});

describe('attentionTab', () => {
  it('opens Review when the only other waiting tasks are drafts', () => {
    expect(attentionTab([task('backlog'), task('review')])).toBe('review');
  });

  it('opens Waiting for you when a question is waiting', () => {
    expect(attentionTab([task('awaiting_permission'), task('review')])).toBe('waiting');
  });

  it('opens Waiting for you when a task failed', () => {
    expect(attentionTab([task('failed')])).toBe('waiting');
  });
});
