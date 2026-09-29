// SPDX-License-Identifier: Apache-2.0
import { contextPct, resolveThresholds } from '@harnessboard/shared';
import type { Session, Task } from '@harnessboard/shared';
import type { Store } from '@harnessboard/core';

/** Context usage of a task's latest session, as shown in the CLI and web UI. */
export interface ContextView {
  tokens: number;
  window: number;
  pct: number;
  softPct: number;
  hardPct: number;
}

export interface TaskView extends Task {
  sessionCount: number;
  latestSessionId: string | null;
  context: ContextView | null;
}

export function taskView(task: Task, store: Store, fallbackWindow: number): TaskView {
  const sessions = store.listSessions(task.id);
  const latest = sessions.at(-1);
  return {
    ...task,
    sessionCount: sessions.length,
    latestSessionId: latest?.id ?? null,
    context: latest ? contextView(task, latest, store, fallbackWindow) : null,
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
