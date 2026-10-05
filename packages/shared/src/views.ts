// SPDX-License-Identifier: Apache-2.0
import type {
  ContextPolicy,
  CriteriaProposal,
  MergeRecord,
  Session,
  Task,
  TaskMode,
} from './task.js';
import type { Feature, LoopProgress } from './loop.js';
import type { ReviewRecord, TaskActivity } from './review.js';
import type { AgentProvider, TaskAgents } from './agents.js';
import type { QuotaInfo } from './events.js';
import type { PermissionRequest } from './permissions.js';
import type { TaskUsage } from './usage.js';

/** Context usage of a task's latest session, as shown in the CLI and web UI. */
export interface ContextView {
  tokens: number;
  window: number;
  pct: number;
  compactPct: number | null;
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
  /** Latest acceptance criteria a single task's agent proposed, until they are approved. */
  criteria: CriteriaProposal | null;
  /** Set once the task's branch was merged into its base. */
  merge: MergeRecord | null;
  /** Tool uses the running session waits on the user to allow or deny, oldest first. */
  permissionRequests: PermissionRequest[];
  /** Tokens, estimated cost and time over all the task's sessions. */
  usage: TaskUsage;
}

export interface TaskDetail extends TaskView {
  sessions: Session[];
  /** Latest feature list of a loop task, as the harness last read it. */
  features: Feature[] | null;
}

/** The server's version, for showing next to the board's name. */
export interface VersionInfo {
  version: string;
}

/** Reply of `POST /api/pairing`: the one-time code the phone sends to `POST /api/pair`. */
export interface PairingCode {
  code: string;
  /** Epoch ms after which the code is refused. */
  expiresAt: number;
}

/** Reply of `GET /api/pairing/setup`: what the computer needs to let a phone reach it. */
export interface PairingSetup {
  /** This machine's Tailscale name, or `null` when Tailscale is missing or not running. */
  tailscaleHost: string | null;
  /** The port the board listens on, for the `tailscale serve --bg <port>` command. */
  port: number;
}

/** Body of `POST /api/pair`. */
export interface PairRequest {
  code: string;
  /** What the device list calls the phone, e.g. "Pixel 9". */
  name: string;
}

/**
 * Reply of a passed `POST /api/passkey` or `POST /api/auth/verify`. The web sends `session` in
 * the `x-harnessboard-session` header (`?session=` on `GET /api/events`) and keeps it in page
 * memory only, so opening the board again needs another passkey check.
 */
export interface PasskeySession {
  ok: true;
  session: string;
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
  /** Tool rules every task may use without asking, on top of its own. */
  allowedTools: string[];
  /** Files with the rules every reviewer checks the work against; `~` is the home folder. */
  reviewGuidelines: string[];
  /** Host names a paired device may reach the board through; empty for loopback only. */
  remoteHosts: string[];
}

/** A phone or other remote device paired with the board. */
export interface Device {
  id: number;
  name: string;
  createdAt: number;
  /** Time of the device's last request, or of pairing before it made one. */
  lastSeenAt: number;
}

/** Body of `GET /api/push/key`: the board's VAPID public key, for `PushManager.subscribe`. */
export interface PushKey {
  /** Uncompressed P-256 public key, base64url. */
  publicKey: string;
}

/**
 * Body of `POST /api/push/subscribe`: what `PushSubscription.toJSON()` gives, without the
 * expiration time the board does not use.
 */
export interface PushSubscriptionInfo {
  /** The push service URL the board posts to; always https. */
  endpoint: string;
  keys: { p256dh: string; auth: string };
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
  /** Writes the acceptance criteria; omitted or `null` lets the implementer do it. */
  spec?: string | null;
  specModel?: string | null;
  /** Tests each finished step before review; omitted or `null` skips testing. */
  tester?: string | null;
  testerModel?: string | null;
  /**
   * Loop tasks: optional while `confirmPlan` is on (the default), because it can be set
   * when the plan is approved; otherwise required unless `.harnessboard.json` sets one.
   */
  verifyCommand?: string;
  /** What must hold for the work to count as done; see {@link Task.acceptance}. */
  acceptance?: string;
  /**
   * Wait for the user to approve a plan before building. Loop tasks default to true; single
   * tasks default to true only without `acceptance`, and their agent then proposes criteria
   * (refining `acceptance` as a draft when both are given).
   */
  confirmPlan?: boolean;
  size?: ContextPolicy['size'];
  compactPct?: number;
  softPct?: number;
  hardPct?: number;
  allowedTools?: string[];
  skipPermissions?: boolean;
  /** Allow unlisted tools without asking unless they are dangerous; see `PermissionPolicy`. */
  autoApprove?: boolean;
  /** Queue immediately instead of leaving the task in the backlog. */
  queue?: boolean;
}

/** One entry of a task's event log (`GET /api/tasks/:id/events`). */
/** A task's notes file (`GET /api/tasks/:id/notes`); `markdown` is `null` before any role reported. */
export interface TaskNotes {
  markdown: string | null;
}

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
  Pick<
    TaskAgents,
    | 'implementer'
    | 'reviewer'
    | 'implementerModel'
    | 'reviewerModel'
    | 'spec'
    | 'specModel'
    | 'tester'
    | 'testerModel'
  >
>;
