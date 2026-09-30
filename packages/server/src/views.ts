// SPDX-License-Identifier: Apache-2.0
import { contextPct, resolveThresholds } from '@harnessboard/shared';
import type {
  ContextView,
  FeatureSnapshot,
  LoopProgress,
  ReviewRecord,
  ReviewRequest,
  Session,
  Task,
  TaskView,
  TimelineEntry,
} from '@harnessboard/shared';
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
  };
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
  for (const kind of ['features', 'review_request', 'review', 'handoff'] as const) {
    for (const e of store.eventsOfKind(taskId, kind)) {
      entries.push(timelineEvent(kind, e.ts, e.data));
    }
  }
  // Stable sort keeps a session ahead of events stamped in the same millisecond.
  return entries.sort((a, b) => a.ts - b.ts);
}

function timelineEvent(
  kind: 'features' | 'review_request' | 'review' | 'handoff',
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
