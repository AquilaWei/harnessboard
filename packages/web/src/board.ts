// SPDX-License-Identifier: Apache-2.0
import type { TaskStatus, TaskView } from '@harnessboard/shared';

/**
 * Board columns, grouped by who has to act: nobody yet (draft), the agents (active),
 * you (attention), or nobody any more (done).
 */
export const STAGES = ['draft', 'active', 'attention', 'done'] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_OF: Record<TaskStatus, Stage> = {
  backlog: 'draft',
  queued: 'active',
  running: 'active',
  awaiting_permission: 'attention',
  waiting_quota: 'active',
  awaiting_approval: 'attention',
  review: 'attention',
  failed: 'attention',
  stopped: 'attention',
  done: 'done',
};

export function stageOf(status: TaskStatus): Stage {
  return STAGE_OF[status];
}

/** API calls the board can make for a task. */
export type TaskAction = 'queue' | 'stop' | 'complete';

/**
 * The one button a card offers, if any. `review` opens the task on its changes,
 * `approvePlan` on its proposed plan, `answerPermission` on the tool use it waits on.
 */
export type PrimaryAction =
  'start' | 'stop' | 'review' | 'retry' | 'approvePlan' | 'answerPermission';

export function primaryAction(task: TaskView): PrimaryAction | null {
  switch (task.status) {
    case 'backlog':
      return 'start';
    case 'queued':
    case 'running':
    case 'waiting_quota':
      return 'stop';
    case 'review':
      return 'review';
    case 'awaiting_approval':
      return 'approvePlan';
    case 'awaiting_permission':
      return 'answerPermission';
    case 'failed':
    case 'stopped':
      return 'retry';
    case 'done':
      return null;
  }
}

/**
 * The API call that dropping a task on a stage stands for, or `null` when that move
 * is not possible (e.g. a running task cannot be dropped on Done).
 */
export function dropAction(task: TaskView, target: Stage): TaskAction | null {
  const from = stageOf(task.status);
  // A plan or a tool use waiting for you moves on through your answer, not by queueing.
  const waitsForAnswer =
    task.status === 'awaiting_approval' || task.status === 'awaiting_permission';
  const queueable = from === 'draft' || (from === 'attention' && !waitsForAnswer);
  if (target === 'active' && queueable) return 'queue';
  if (target === 'attention' && from === 'active') return 'stop';
  if (target === 'done' && task.status === 'review') return 'complete';
  return null;
}
