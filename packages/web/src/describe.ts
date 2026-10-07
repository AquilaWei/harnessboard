// SPDX-License-Identifier: Apache-2.0
import type { ReviewRecord, TaskView } from '@harnessboard/shared';

/** How a description should read: neutral, work in progress, needs you, or went wrong. */
export type Tone = 'idle' | 'working' | 'attention' | 'problem' | 'done';

/** A translation key under `describe.` with its values, so the rules stay testable. */
export interface Description {
  key: string;
  vars: Record<string, string | number>;
  tone: Tone;
}

const d = (key: string, tone: Tone, vars: Record<string, string | number> = {}): Description => ({
  key,
  tone,
  vars,
});

/**
 * One sentence that says what is happening with a task and, when it waits for you, what
 * to decide. Shown on cards and at the top of the task panel.
 */
export function describeTask(task: TaskView): Description {
  const review = task.lastReview;
  const reviewer = task.agents.reviewer ?? '';
  switch (task.status) {
    case 'backlog':
      return d('draft', 'idle');
    case 'queued':
      // Only an answered tool use waiting for quota is queued with its agent still open.
      if (task.activity) return d('answerHeld', 'working');
      // The spec author answers a request to change the spec before anything else runs.
      if (task.specRevisionPending) return d('specRevisionQueued', 'working');
      if (task.planFeedbackPending) {
        return d(
          task.mode === 'single' ? 'revisingCriteriaQueued' : 'revisingPlanQueued',
          'working',
        );
      }
      if (task.reviewPending) return d('queuedForReview', 'working', { agent: reviewer });
      if (review?.verdict === 'changes') return d('queuedForFixes', 'working', { agent: reviewer });
      return d('queued', 'working');
    case 'running':
      return describeRunning(task);
    case 'waiting_quota':
      return task.resumeAt
        ? d('waitingQuota', 'working', { time: task.resumeAt })
        : d('waitingQuotaUnknown', 'working');
    case 'awaiting_permission': {
      const request = task.permissionRequests[0];
      return d('permissionAsked', 'attention', {
        agent: task.activity?.agentId ?? '',
        tool: request?.toolName ?? '',
        summary: request?.summary ?? '',
      });
    }
    case 'awaiting_approval':
      if (task.specChange) {
        return d(task.specChange.criteria ? 'specChangeReady' : 'specChangeMissing', 'attention');
      }
      if (task.mode === 'single') {
        return d(task.criteria?.criteria ? 'criteriaReady' : 'criteriaMissing', 'attention', {
          agent: task.agents.implementer,
        });
      }
      return d(task.plan?.questions ? 'planReadyQuestions' : 'planReady', 'attention', {
        total: task.plan?.total ?? 0,
        questions: task.plan?.questions ?? 0,
      });
    case 'review':
      return describeReview(task);
    case 'failed':
      return d('failed', 'problem', { reason: task.lastNotice ?? '' });
    case 'stopped':
      return d('stopped', 'attention');
    case 'done':
      return task.merge ? d('merged', 'done', { base: task.merge.base }) : d('done', 'done');
  }
}

function describeRunning(task: TaskView): Description {
  const activity = task.activity;
  if (!activity) return d('starting', 'working');
  const agent = activity.agentId ?? '';
  switch (activity.phase) {
    case 'planning':
      // An earlier proposal exists: this session is revising it with the user's feedback.
      if (task.specRevisionPending) return d('revisingSpec', 'working', { agent });
      if (task.mode === 'single') {
        return d(task.criteria ? 'revisingCriteria' : 'discussing', 'working', { agent });
      }
      return d(task.plan ? 'revisingPlan' : 'planning', 'working', { agent });
    case 'writingSpec':
      return d('writingSpec', 'working', { agent });
    case 'designing':
      return d('designing', 'working', { agent });
    case 'testing':
      return d('testing', 'working', { agent });
    case 'implementing':
      if (task.lastReview?.verdict === 'changes') {
        return d('fixingReview', 'working', { agent, reviewer: task.lastReview.agentId });
      }
      if (task.loop) {
        const next = Math.min(task.loop.verified + 1, task.loop.total);
        return d('buildingFeature', 'working', { agent, n: next, total: task.loop.total });
      }
      return d('implementing', 'working', { agent });
    case 'verifying':
      return d('verifying', 'working', { command: task.verifyCommand ?? '' });
    case 'reviewing':
      return d('reviewing', 'working', { agent });
    case 'chatting':
      return d('chatting', 'working', { agent });
  }
}

function describeReview(task: TaskView): Description {
  const review = task.lastReview;
  if (review?.verdict === 'approve') {
    return task.loop
      ? d('loopApproved', 'attention', { agent: review.agentId, total: task.loop.total })
      : d('approved', 'attention', { agent: review.agentId });
  }
  if (review?.verdict === 'changes') {
    return d('stillChanges', 'attention', { agent: review.agentId, rounds: review.round });
  }
  if (review && review.verdict === null)
    return d('noVerdict', 'attention', { agent: review.agentId });
  if (task.loop) return d('loopFinished', 'attention', { total: task.loop.total });
  return d('finished', 'attention');
}

/**
 * The review a task in Review is waiting on you about, shown in the task panel's status box:
 * the last one, unless it approved the work or has nothing to say.
 */
export function openReview(task: TaskView): ReviewRecord | null {
  const review = task.lastReview;
  if (task.status !== 'review' || !review || review.verdict === 'approve') return null;
  return review.findings.trim() === '' ? null : review;
}

/** Translation key under `actions.` for sending a task in Review back to work. */
export function sendBackKey(task: TaskView): 'continueWithReview' | 'sendBack' {
  return task.lastReview?.verdict === 'changes' ? 'continueWithReview' : 'sendBack';
}

/**
 * Whether the user can ask for a change to a task's spec: once the spec file is written and
 * while work is under way. The server refuses it before, while an approval waits, and once
 * the task is done.
 */
export function canChangeSpec(task: TaskView): boolean {
  if (task.mode !== 'single' || !task.specFile) return false;
  return task.status !== 'backlog' && task.status !== 'awaiting_approval' && task.status !== 'done';
}
