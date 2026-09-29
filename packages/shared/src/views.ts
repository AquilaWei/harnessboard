// SPDX-License-Identifier: Apache-2.0
import type { ContextPolicy, Session, Task } from './task.js';
import type { QuotaInfo } from './events.js';

/** Context usage of a task's latest session, as shown in the CLI and web UI. */
export interface ContextView {
  tokens: number;
  window: number;
  pct: number;
  softPct: number;
  hardPct: number;
}

/** A task plus the derived fields list views need. */
export interface TaskView extends Task {
  sessionCount: number;
  latestSessionId: string | null;
  context: ContextView | null;
}

export interface TaskDetail extends TaskView {
  sessions: Session[];
}

export interface HarnessStatus {
  running: number[];
  quota: QuotaInfo | null;
  /** True while the scheduler holds back new sessions because of quota. */
  quotaPaused: boolean;
  maxConcurrent: number;
}

/** Body of `POST /api/tasks`. */
export interface CreateTaskInput {
  prompt: string;
  /** Any directory inside the target repository. */
  repo: string;
  title?: string;
  baseRef?: string;
  size?: ContextPolicy['size'];
  softPct?: number;
  hardPct?: number;
  allowedTools?: string[];
  skipPermissions?: boolean;
  /** Queue immediately instead of leaving the task in the backlog. */
  queue?: boolean;
}

/** One entry of a task's event log (`GET /api/tasks/:id/events`). */
export interface StoredEvent {
  id: number;
  taskId: number;
  sessionId: string | null;
  ts: number;
  kind: string;
  data: unknown;
}

export interface WorktreeDiff {
  /** Unified diff of commits plus uncommitted edits to tracked files. */
  diff: string;
  /** New files git does not track yet; not part of `diff`. */
  untracked: string[];
}
