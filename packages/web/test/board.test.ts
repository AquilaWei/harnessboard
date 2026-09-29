// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { TaskStatus, TaskView } from '@harnessboard/shared';
import { columnOf, moveAction } from '../src/board';

const task = (status: TaskStatus) => ({ status }) as TaskView;

describe('moveAction', () => {
  it('queues a backlog task dropped on Queued', () => {
    expect(moveAction(task('backlog'), 'queued')).toBe('queue');
  });

  it('stops a running task dropped on Stopped / failed', () => {
    expect(moveAction(task('running'), 'halted')).toBe('stop');
  });

  it('completes a review task dropped on Done', () => {
    expect(moveAction(task('review'), 'done')).toBe('complete');
  });

  it('refuses to start a task by dropping it on Running', () => {
    expect(moveAction(task('queued'), 'running')).toBeNull();
  });

  it('refuses to mark a running task done', () => {
    expect(moveAction(task('running'), 'done')).toBeNull();
  });
});

describe('columnOf', () => {
  it('puts failed tasks in the Stopped / failed column', () => {
    expect(columnOf('failed')).toBe('halted');
  });
});
