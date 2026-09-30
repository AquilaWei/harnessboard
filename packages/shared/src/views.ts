// SPDX-License-Identifier: Apache-2.0
import type { ContextPolicy, Session, Task, TaskMode } from './task.js';
import type { Feature, LoopProgress } from './loop.js';
import type { AgentProvider } from './agents.js';
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
  /** Feature progress of a loop task, once its feature list exists. */
  loop: LoopProgress | null;
}

export interface TaskDetail extends TaskView {
  sessions: Session[];
  /** Latest feature list of a loop task, as the harness last read it. */
  features: Feature[] | null;
}

export interface HarnessStatus {
  running: number[];
  /** Latest quota snapshot per provider that has reported one. */
  quotas: Partial<Record<AgentProvider, QuotaInfo>>;
  /** Providers whose quota currently holds back new sessions. */
  quotaPaused: AgentProvider[];
  maxConcurrent: number;
}

export interface Settings {
  maxConcurrent: number;
  quotaPauseUtilization: number;
  defaultContextPolicy: ContextPolicy;
  /** Reviewer profile for new tasks; `null` for no review. */
  defaultReviewer: string | null;
}

/** Body of `POST /api/tasks`. */
export interface CreateTaskInput {
  prompt: string;
  /** Any directory inside the target repository. */
  repo: string;
  title?: string;
  baseRef?: string;
  mode?: TaskMode;
  /** Agent profile ids; default to `claude` and the configured default reviewer. */
  implementer?: string;
  /** `null` turns review off even when a default reviewer is configured. */
  reviewer?: string | null;
  /** Required for loop tasks unless the project's `.harnessboard.json` sets one. */
  verifyCommand?: string;
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
