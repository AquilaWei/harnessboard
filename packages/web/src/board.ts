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

/**
 * Tabs of the board at phone width, where only one column fits. They split the desktop's
 * Needs you stage, so a finished task to review is not buried among questions waiting for
 * an answer. Drafts wait for you to start them, so they sit under `waiting`.
 */
export const PHONE_TABS = ['waiting', 'active', 'review', 'done'] as const;
export type PhoneTab = (typeof PHONE_TABS)[number];

const PHONE_TAB_OF: Record<TaskStatus, PhoneTab> = {
  backlog: 'waiting',
  queued: 'active',
  running: 'active',
  awaiting_permission: 'waiting',
  waiting_quota: 'active',
  awaiting_approval: 'waiting',
  review: 'review',
  failed: 'waiting',
  stopped: 'waiting',
  done: 'done',
};

/** Tasks grouped by phone tab, each group in the order the tasks were given. */
export function groupByPhoneTab(tasks: TaskView[]): Record<PhoneTab, TaskView[]> {
  const groups: Record<PhoneTab, TaskView[]> = { waiting: [], active: [], review: [], done: [] };
  for (const task of tasks) groups[PHONE_TAB_OF[task.status]].push(task);
  return groups;
}

/**
 * The phone tab that holds the tasks counted as needing you. Drafts are under `waiting` too
 * but are not counted, so `waiting` is chosen only when a counted task is there.
 */
export function attentionTab(tasks: TaskView[]): PhoneTab {
  const waiting = tasks.some(
    (task) => stageOf(task.status) === 'attention' && PHONE_TAB_OF[task.status] === 'waiting',
  );
  return waiting ? 'waiting' : 'review';
}

/** API calls the board can make for a task. */
export type TaskAction = 'queue' | 'stop' | 'complete';

/**
 * The one button a card offers, if any. `review` opens the task on its changes,
 * `approvePlan` on its proposed plan, `approveCriteria` on its proposed acceptance
 * criteria, `answerPermission` on the tool use it waits on.
 */
export type PrimaryAction =
  'start' | 'stop' | 'review' | 'retry' | 'approvePlan' | 'approveCriteria' | 'answerPermission';

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
      return task.mode === 'single' ? 'approveCriteria' : 'approvePlan';
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
