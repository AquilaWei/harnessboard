// SPDX-License-Identifier: Apache-2.0
import type { ContextPolicy, Session, Task, TaskMode } from './task.js';
import type { Feature, LoopProgress } from './loop.js';
import type { ReviewRecord, TaskActivity } from './review.js';
import type { AgentProvider, TaskAgents } from './agents.js';
import type { QuotaInfo } from './events.js';
import type { PermissionRequest } from './permissions.js';

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
  /** What the running session is doing; `null` when the task is not running. */
  activity: TaskActivity | null;
  /** Latest reviewer verdict, when the task has a reviewer and one has run. */
  lastReview: ReviewRecord | null;
  /** True while a finished step waits for its reviewer. */
  reviewPending: boolean;
  /** The harness's latest message about the task, e.g. why it failed. */
  lastNotice: string | null;
  /** Latest plan proposal of a loop task, until it is approved. */
  plan: { total: number; questions: number; suggestedVerify: string | null } | null;
  /** True while user feedback on the plan waits for the planner. */
  planFeedbackPending: boolean;
  /** Tool uses the running session waits on the user to allow or deny, oldest first. */
  permissionRequests: PermissionRequest[];
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
  /** User config file that holds agent profiles; `null` when settings are not saved. */
  configFile: string | null;
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
  /** Models for this task only; omitted or `null` uses the profile's model. */
  implementerModel?: string | null;
  reviewerModel?: string | null;
  /**
   * Loop tasks: optional while `confirmPlan` is on (the default), because it can be set
   * when the plan is approved; otherwise required unless `.harnessboard.json` sets one.
   */
  verifyCommand?: string;
  /** Loop tasks: wait for the user to approve the plan before building (default true). */
  confirmPlan?: boolean;
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

/** Reply to deleting a task; the branch is kept so its commits can still be merged. */
export interface DeletedTask {
  id: number;
  branch: string | null;
}

/** One commit on a task's branch since it left its base. */
export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  /** Unix ms of the commit. */
  ts: number;
}

/** Body of `PUT /api/tasks/:id/agents`: only the given fields change. */
export type AgentsUpdate = Partial<
  Pick<TaskAgents, 'implementer' | 'reviewer' | 'implementerModel' | 'reviewerModel'>
>;
