// SPDX-License-Identifier: Apache-2.0
import { contextPct, resolveThresholds, toQuestions } from '@harnessboard/shared';
import type {
  ChatEnd,
  ChatEntry,
  ChatMessage,
  ChatQueueCleared,
  ChatQueued,
  ContextView,
  CriteriaApproval,
  CriteriaProposal,
  MergeConflict,
  MergeRecord,
  FeatureSnapshot,
  LoopProgress,
  PermissionDecisionRecord,
  PermissionRequest,
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
    criteria: harness.criteriaProposal(task),
    merge: harness.lastMerge(task.id),
    permissionRequests: harness.permissionRequests(task.id),
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
      questions: toQuestions(proposal?.questions),
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
    'criteria',
    'criteria_approved',
    'chat_message',
    'merge_conflict',
    'merged',
    'permission_request',
    'permission_decision',
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
    | 'plan_approved'
    | 'criteria'
    | 'criteria_approved'
    | 'chat_message'
    | 'merge_conflict'
    | 'merged'
    | 'permission_request'
    | 'permission_decision',
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
    case 'criteria':
      return { kind, ts, proposal: data as CriteriaProposal };
    case 'criteria_approved':
      return { kind, ts, approval: data as CriteriaApproval };
    case 'chat_message':
      return { kind, ts, message: data as ChatMessage };
    case 'merge_conflict':
      return { kind, ts, conflict: data as MergeConflict };
    case 'merged':
      return { kind, ts, merge: data as MergeRecord };
    case 'permission_request':
      return { kind, ts, request: data as PermissionRequest };
    case 'permission_decision':
      return { kind, ts, decision: data as PermissionDecisionRecord };
  }
}

/**
 * The user's chat messages with the agent's text and tool uses in reply, oldest first,
 * then the messages still waiting to be sent. Only what happened in chats is included;
 * the workflow's sessions are on the timeline. Pending messages that were sent appear once,
 * as the message they were sent in.
 */
export function chatTranscript(taskId: number, store: Store): ChatEntry[] {
  const first = store.eventsOfKinds(taskId, ['chat_message', 'chat_queued'])[0];
  if (!first) return [];
  const entries: ChatEntry[] = [];
  let pending: { ts: number; text: string }[] = [];
  let inChat = false;
  const kinds = [
    'chat_message',
    'chat_end',
    'chat_queued',
    'chat_queue_cleared',
    'text',
    'tool_use',
    'compact',
  ];
  for (const e of store.eventsOfKinds(taskId, kinds, first.id - 1)) {
    if (e.kind === 'chat_queued') {
      pending.push({ ts: e.ts, text: (e.data as ChatQueued).text });
    } else if (e.kind === 'chat_queue_cleared') {
      const text = pending.map((p) => p.text).join('\n\n');
      entries.push({ kind: 'dropped', ts: e.ts, text, cleared: e.data as ChatQueueCleared });
      pending = [];
    } else if (e.kind === 'chat_message') {
      inChat = true;
      pending = [];
      entries.push({ kind: 'user', ts: e.ts, text: (e.data as ChatMessage).text });
    } else if (e.kind === 'chat_end') {
      inChat = false;
      entries.push({ kind: 'end', ts: e.ts, reason: (e.data as ChatEnd).reason });
    } else if (inChat && e.kind === 'text') {
      entries.push({ kind: 'agent', ts: e.ts, text: (e.data as { text: string }).text });
    } else if (inChat && e.kind === 'tool_use') {
      const tool = e.data as { name: string; summary: string };
      entries.push({ kind: 'tool', ts: e.ts, name: tool.name, summary: tool.summary });
    } else if (inChat && e.kind === 'compact') {
      const { preTokens, postTokens } = e.data as { preTokens: number; postTokens: number };
      entries.push({ kind: 'compact', ts: e.ts, preTokens, postTokens });
    }
  }
  return [...entries, ...pending.map((p) => ({ kind: 'pending' as const, ...p }))];
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
