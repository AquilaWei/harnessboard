// SPDX-License-Identifier: Apache-2.0
import type { TaskStatus, TaskView } from '@harnessboard/shared';

/** Board columns; `halted` groups stopped and failed tasks. */
export const COLUMNS = [
  'backlog',
  'queued',
  'running',
  'waiting_quota',
  'review',
  'done',
  'halted',
] as const;
export type ColumnId = (typeof COLUMNS)[number];

export function columnOf(status: TaskStatus): ColumnId {
  return status === 'stopped' || status === 'failed' ? 'halted' : status;
}

export type MoveAction = 'queue' | 'stop' | 'complete';

/**
 * The API call that dropping a task on a column stands for, or `null` when the
 * move is not a real transition (e.g. dragging into Running: only the scheduler starts tasks).
 */
export function moveAction(task: TaskView, target: ColumnId): MoveAction | null {
  const from = task.status;
  if (
    target === 'queued' &&
    ['backlog', 'stopped', 'failed', 'review', 'waiting_quota'].includes(from)
  ) {
    return 'queue';
  }
  if (target === 'halted' && ['running', 'queued', 'waiting_quota'].includes(from)) return 'stop';
  if (target === 'done' && from === 'review') return 'complete';
  return null;
}
