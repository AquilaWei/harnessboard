// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { TaskStatus, TaskView } from '@harnessboard/shared';
import {
  attentionTab,
  dropAction,
  groupByPhoneTab,
  primaryAction,
  stageOf,
  stageOfTask,
} from '../src/board';

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

describe('stageOfTask', () => {
  it('keeps a draft being planned in Draft while it waits for approval', () => {
    expect(stageOfTask({ status: 'awaiting_approval', deferred: true })).toBe('draft');
  });

  it('puts a pending task in Pending', () => {
    expect(stageOfTask({ status: 'pending', deferred: true })).toBe('pending');
  });

  it('puts a task that is not planned in Draft by its status', () => {
    expect(stageOfTask({ status: 'awaiting_approval', deferred: false })).toBe('attention');
  });
});

describe('primaryAction', () => {
  it('offers Plan the spec for a draft', () => {
    expect(primaryAction(task('backlog'))).toBe('plan');
  });

  it('offers Start now for a pending task', () => {
    expect(primaryAction(task('pending'))).toBe('start');
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
  it('refuses to bypass spec approval by dropping a draft in Pending', () => {
    expect(dropAction(task('backlog'), 'pending')).toBeNull();
  });

  it('takes a done task back to Draft', () => {
    expect(dropAction(task('done'), 'draft')).toBe('draft');
  });

  it('reopens a done task as Pending', () => {
    expect(dropAction(task('done'), 'pending')).toBe('pend');
  });

  it('starts a pending task now when dropped on In progress', () => {
    expect(dropAction(task('pending'), 'active')).toBe('queue');
  });

  it('does not move a running task to Draft', () => {
    expect(dropAction(task('running'), 'draft')).toBeNull();
  });

  it('does not queue a task waiting for permission when dropped on In progress', () => {
    expect(dropAction(task('awaiting_permission'), 'active')).toBeNull();
  });

  it('refuses to start a draft by dropping it on In progress', () => {
    expect(dropAction(task('backlog'), 'active')).toBeNull();
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

  it('completes a failed task dropped on Done', () => {
    expect(dropAction(task('failed'), 'done')).toBe('complete');
  });

  it('completes a stopped task dropped on Done', () => {
    expect(dropAction(task('stopped'), 'done')).toBe('complete');
  });

  it('refuses to complete a draft', () => {
    expect(dropAction(task('backlog'), 'done')).toBeNull();
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
      pending: [],
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

  it('orders pending tasks by queueOrder and falls back to id for legacy tasks', () => {
    const first = { ...withId(1, 'pending'), queueOrder: null } as TaskView;
    const second = { ...withId(2, 'pending'), queueOrder: 4 } as TaskView;
    const third = { ...withId(3, 'pending'), queueOrder: 2 } as TaskView;
    expect(groupByPhoneTab([first, second, third]).pending.map((item) => item.id)).toEqual([
      1, 3, 2,
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

it('keeps an active spec discussion in the phone waiting tab', () => {
  const discussing = { ...task('running'), deferred: true };
  expect(groupByPhoneTab([discussing]).waiting).toEqual([discussing]);
});

describe('safety pause on the board', () => {
  it('shows a safety-paused spec discussion in Needs you', () => {
    expect(stageOfTask({ status: 'paused_safety', deferred: true })).toBe('attention');
  });

  it('offers explicit Resume for a safety-paused task', () => {
    expect(primaryAction(task('paused_safety'))).toBe('resume');
  });

  it('keeps a safety-paused task in the phone waiting tab', () => {
    expect(groupByPhoneTab([task('paused_safety')]).waiting).toEqual([task('paused_safety')]);
  });
});

it('offers answering the PM when work continues behind an unanswered question', () => {
  expect(
    primaryAction({
      ...task('running'),
      workflow: 'pm',
      pmQuestion: { kind: 'question', message: 'Install tool?' },
    }),
  ).toBe('answerPm');
});
