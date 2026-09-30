// SPDX-License-Identifier: Apache-2.0
import { contextPct, resolveThresholds } from '@harnessboard/shared';
import type {
  ContextView,
  FeatureSnapshot,
  LoopProgress,
  Session,
  Task,
  TaskView,
} from '@harnessboard/shared';
import type { Store } from '@harnessboard/core';

export function taskView(task: Task, store: Store, fallbackWindow: number): TaskView {
  const sessions = store.listSessions(task.id);
  const latest = sessions.at(-1);
  return {
    ...task,
    sessionCount: sessions.length,
    latestSessionId: latest?.id ?? null,
    context: latest ? contextView(task, latest, store, fallbackWindow) : null,
    loop: task.mode === 'loop' ? loopProgress(task, store) : null,
  };
}

function contextView(task: Task, session: Session, store: Store, fallback: number): ContextView {
  const window = session.contextWindow ?? store.lastKnownContextWindow() ?? fallback;
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
