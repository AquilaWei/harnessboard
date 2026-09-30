// SPDX-License-Identifier: Apache-2.0
import { contextPct, resolveThresholds } from '@harnessboard/shared';
import type {
  ContextView,
  FeatureSnapshot,
  LoopProgress,
  PlanApproval,
  PlanProposal,
  PlanView,
  ReviewRecord,
  ReviewRequest,
  Session,
  Task,
  TaskView,
  TimelineEntry,
} from '@harnessboard/shared';
import { readPlan } from '@harnessboard/core';
import type { Harness, HarnessConfig, Store } from '@harnessboard/core';

const SUMMARY_CHARS = 600;

export function taskView(task: Task, harness: Harness): TaskView {
  const { store, config } = harness;
  const sessions = store.listSessions(task.id);
  const latest = sessions.at(-1);
  return {
    ...task,
    sessionCount: sessions.length,
    latestSessionId: latest?.id ?? null,
    context: latest ? contextView(task, latest, store, config) : null,
    loop: task.mode === 'loop' ? loopProgress(task, store) : null,
    activity: harness.activity(task.id),
    lastReview: (store.lastEvent(task.id, 'review')?.data as ReviewRecord | undefined) ?? null,
    reviewPending: harness.pendingReview(task.id) !== null,
    plan: task.mode === 'loop' ? planSummary(task.id, store) : null,
    planFeedbackPending: harness.pendingPlanFeedback(task.id) !== null,
    lastNotice:
      (store.lastEvent(task.id, 'notice')?.data as { message?: string } | undefined)?.message ??
      null,
  };
}

/** Latest proposal while a loop task's plan is not approved yet. */
function planSummary(taskId: number, store: Store): TaskView['plan'] {
  if (store.lastEvent(taskId, 'plan_approved')) return null;
  const proposal = store.lastEvent(taskId, 'plan')?.data as PlanProposal | undefined;
  if (!proposal) return null;
  return {
    total: proposal.features.length,
    questions: proposal.questions.length,
    suggestedVerify: proposal.suggestedVerify,
  };
}

/**
 * The plan as it is in the worktree right now (it may have been edited in an interactive
 * session), with the planner's latest reply and questions.
 */
export function planView(task: Task, store: Store): PlanView {
  const proposal = store.lastEvent(task.id, 'plan')?.data as PlanProposal | undefined;
  const approved = store.lastEvent(task.id, 'plan_approved') !== undefined;
  const base = {
    reply: proposal?.reply ?? null,
    approved,
  };
  if (!task.worktreePath) {
    return { ...base, features: null, error: null, suggestedVerify: null, questions: [] };
  }
  try {
    const plan = readPlan(task.worktreePath);
    return { ...base, ...plan, error: null };
  } catch (err) {
    return {
      ...base,
      features: null,
      error: (err as Error).message,
      suggestedVerify: proposal?.suggestedVerify ?? null,
      questions: proposal?.questions ?? [],
    };
  }
}

/**
 * A task's history as steps: sessions (at their start, with the final reply) interleaved
 * with feature snapshots, review requests, reviews and handoffs.
 */
export function timeline(taskId: number, store: Store): TimelineEntry[] {
  const entries: TimelineEntry[] = store.listSessions(taskId).map((session) => {
    const result = store.lastSessionEvent(session.id, 'result')?.data as
      { text?: string } | undefined;
    const text = result?.text?.trim();
    const summary = text
      ? text.length > SUMMARY_CHARS
        ? `${text.slice(0, SUMMARY_CHARS)}…`
        : text
      : null;
    return { kind: 'session', ts: session.startedAt, session, summary };
  });
  const kinds = [
    'features',
    'review_request',
    'review',
    'handoff',
    'plan',
    'plan_feedback',
    'plan_approved',
  ] as const;
  for (const kind of kinds) {
    for (const e of store.eventsOfKind(taskId, kind)) {
      entries.push(timelineEvent(kind, e.ts, e.data));
    }
  }
  // Stable sort keeps a session ahead of events stamped in the same millisecond.
  return entries.sort((a, b) => a.ts - b.ts);
}

function timelineEvent(
  kind:
    | 'features'
    | 'review_request'
    | 'review'
    | 'handoff'
    | 'plan'
    | 'plan_feedback'
    | 'plan_approved',
  ts: number,
  data: unknown,
): TimelineEntry {
  switch (kind) {
    case 'features':
      return { kind, ts, snapshot: data as FeatureSnapshot };
    case 'review_request':
      return { kind, ts, request: data as ReviewRequest };
    case 'review':
      return { kind, ts, review: data as ReviewRecord };
    case 'handoff':
      return { kind, ts, note: (data as { note: string | null }).note };
    case 'plan':
      return { kind, ts, proposal: data as PlanProposal };
    case 'plan_feedback':
      return { kind, ts, message: (data as { message: string }).message };
    case 'plan_approved':
      return { kind, ts, approval: data as PlanApproval };
  }
}

function contextView(
  task: Task,
  session: Session,
  store: Store,
  config: HarnessConfig,
): ContextView {
  const window =
    session.contextWindow ??
    store.lastKnownContextWindow(session.agentId) ??
    config.agents[session.agentId]?.contextWindow ??
    config.fallbackContextWindow;
  return {
    tokens: session.contextTokens,
    window,
    pct: contextPct(session.contextTokens, window),
    ...resolveThresholds(task.contextPolicy),
  };
}

/** Latest feature list the harness recorded for a loop task. */
export function latestSnapshot(store: Store, taskId: number): FeatureSnapshot | null {
  return (store.lastEvent(taskId, 'features')?.data as FeatureSnapshot | undefined) ?? null;
}

function loopProgress(task: Task, store: Store): LoopProgress | null {
  const snapshot = latestSnapshot(store, task.id);
  if (!snapshot) return null;
  return {
    total: snapshot.features.length,
    claimed: snapshot.features.filter((f) => f.passes).length,
    verified: snapshot.verifiedPassing,
    lastVerify: snapshot.verify,
  };
}
