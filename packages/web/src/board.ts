// SPDX-License-Identifier: Apache-2.0
import type { TaskStatus, TaskView } from '@harnessboard/shared';

/**
 * Board columns, grouped by who has to act: nobody yet (draft), the harness once quota
 * allows (pending), the agents (active), you (attention), or nobody any more (done).
 */
export const STAGES = ['draft', 'pending', 'active', 'attention', 'done'] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_OF: Record<TaskStatus, Stage> = {
  backlog: 'draft',
  pending: 'pending',
  queued: 'active',
  running: 'active',
  awaiting_permission: 'attention',
  waiting_quota: 'active',
  awaiting_approval: 'attention',
  review: 'attention',
  failed: 'attention',
  stopped: 'attention',
  paused_safety: 'attention',
  done: 'done',
};

export function stageOf(status: TaskStatus): Stage {
  return STAGE_OF[status];
}

/**
 * The column a task sits in. A draft whose spec is being discussed stays in Draft while its
 * agent works or waits for your approval, since approving only moves it to Pending.
 */
export function stageOfTask(task: Pick<TaskView, 'status' | 'deferred'>): Stage {
  const stage = STAGE_OF[task.status];
  return task.status !== 'paused_safety' &&
    task.deferred &&
    (stage === 'active' || stage === 'attention')
    ? 'draft'
    : stage;
}

/**
 * Tabs of the board at phone width, where only one column fits. They split the desktop's
 * Needs you stage, so a finished task to review is not buried among questions waiting for
 * an answer. Drafts wait for you to start them, so they sit under `waiting`.
 */
export const PHONE_TABS = ['waiting', 'pending', 'active', 'review', 'done'] as const;
export type PhoneTab = (typeof PHONE_TABS)[number];

const PHONE_TAB_OF: Record<TaskStatus, PhoneTab> = {
  backlog: 'waiting',
  pending: 'pending',
  queued: 'active',
  running: 'active',
  awaiting_permission: 'waiting',
  waiting_quota: 'active',
  awaiting_approval: 'waiting',
  review: 'review',
  failed: 'waiting',
  stopped: 'waiting',
  paused_safety: 'waiting',
  done: 'done',
};

/** Tasks grouped by phone tab, each group in the order the tasks were given. */
export function groupByPhoneTab(tasks: TaskView[]): Record<PhoneTab, TaskView[]> {
  const groups: Record<PhoneTab, TaskView[]> = {
    waiting: [],
    pending: [],
    active: [],
    review: [],
    done: [],
  };
  for (const task of tasks) {
    groups[stageOfTask(task) === 'draft' ? 'waiting' : PHONE_TAB_OF[task.status]].push(task);
  }
  groups.pending.sort((a, b) => (a.queueOrder ?? a.id) - (b.queueOrder ?? b.id) || a.id - b.id);
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
export type TaskAction = 'queue' | 'stop' | 'complete' | 'plan' | 'pend' | 'draft';

/**
 * The one button a card offers, if any. `review` opens the task on its changes,
 * `approvePlan` on its proposed plan, `approveCriteria` on its proposed acceptance
 * criteria, `answerPermission` on the tool use it waits on.
 */
export type PrimaryAction =
  | 'plan'
  | 'start'
  | 'stop'
  | 'review'
  | 'retry'
  | 'resume'
  | 'approvePlan'
  | 'approveCriteria'
  | 'answerPermission';

export function primaryAction(task: TaskView): PrimaryAction | null {
  switch (task.status) {
    case 'backlog':
      return 'plan';
    case 'pending':
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
    case 'paused_safety':
      return 'resume';
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
  const from = stageOfTask(task);
  // A plan or a tool use waiting for you moves on through your answer, not by queueing.
  const waitsForAnswer =
    task.status === 'awaiting_approval' || task.status === 'awaiting_permission';
  const queueable = task.status === 'pending' || (from === 'attention' && !waitsForAnswer);
  // Idle tasks can be put back in line or taken back to discuss; a session or a question
  // in progress has to be stopped or answered first.
  const resting = ['backlog', 'pending', 'stopped', 'failed', 'review', 'done'].includes(
    task.status,
  );
  if (target === 'active' && queueable) return 'queue';
  if (target === 'pending' && task.status !== 'backlog' && resting && task.status !== 'pending')
    return 'pend';
  if (target === 'draft' && resting && task.status !== 'backlog') return 'draft';
  if (target === 'attention' && from === 'active') return 'stop';
  if (target === 'done' && ['review', 'failed', 'stopped'].includes(task.status)) return 'complete';
  return null;
}
