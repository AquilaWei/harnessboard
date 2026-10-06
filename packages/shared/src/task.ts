// SPDX-License-Identifier: Apache-2.0
import type { AgentRole, TaskAgents } from './agents.js';
import type { PlanQuestion } from './loop.js';

export const TASK_STATUSES = [
  'backlog',
  'queued',
  'running',
  'awaiting_permission',
  'waiting_quota',
  'awaiting_approval',
  'review',
  'done',
  'failed',
  'stopped',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Statuses worth a notification: the task waits for your answer or your review. `stopped`
 * is left out because only your own stop sets it. The board's notifications and the push to
 * paired phones both use this list.
 */
export const NOTIFY_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'awaiting_permission',
  'awaiting_approval',
  'review',
  'failed',
]);

/**
 * `single`: one prompt, handed off across sessions until the agent finishes.
 * `loop`: an initializer session writes a feature list, then each session implements one
 * feature and the harness runs the task's verify command itself before counting it.
 */
export type TaskMode = 'single' | 'loop';

/**
 * Where a task works. `worktree`: on its own branch in a worktree of its own, merged into
 * the base after review. `base`: directly on the base branch in the repository folder, with
 * no worktree or branch, so its commits land on the base as it goes and nothing is merged.
 */
export type TaskWorkspace = 'worktree' | 'base';

/** Commits after `from` up to and including `to`, as in `git log from..to`. */
export interface CommitSpan {
  from: string;
  to: string;
}

/** Rough task size; selects the default soft context threshold. */
export type TaskSize = 'small' | 'medium' | 'large';

/**
 * Per-task context budget. `softPct`/`hardPct` override the values derived from `size`.
 * Percentages are of the model's context window (0–100).
 */
export interface ContextPolicy {
  size?: TaskSize;
  /**
   * Context use at which a session is compacted (`/compact`) and carries on; 0 turns it off.
   * Defaults to 30. Wrap-up at `softPct` and the hard limit still apply after compacting.
   */
  compactPct?: number;
  softPct?: number;
  hardPct?: number;
}

export interface PermissionPolicy {
  /** Tool rules passed to `--allowedTools`, e.g. `Bash(npm test)`. */
  allowedTools: string[];
  /** Maps to `--dangerously-skip-permissions`; must be opted into per task. */
  skipPermissions: boolean;
  /**
   * Allow tools the rules do not cover without asking, unless they are dangerous (see
   * `riskOf`). On by default; absent on tasks from before it was the default, which means off.
   */
  autoApprove?: boolean;
}

export interface Task {
  id: number;
  title: string;
  prompt: string;
  /** Absolute path of the repository the task works on. */
  repoPath: string;
  /** Git ref the task branch starts from, or the branch a `base` task works on. */
  baseRef: string;
  /** Always `null` for a `base` task. */
  branch: string | null;
  /** Where the task's sessions run; the repository folder itself for a `base` task. */
  worktreePath: string | null;
  workspace: TaskWorkspace;
  /**
   * The base's commit where a `base` task's current stretch of work started; its diff and
   * commits count from here. `null` for `worktree` tasks, which count from where their
   * branch left the base.
   */
  startCommit: string | null;
  /**
   * HEAD of the repository folder when a `base` task's latest session there ended. Once the
   * task lets go of the folder its history stops here, so later tasks' commits are not
   * counted as its work. `null` for `worktree` tasks and before the first session.
   */
  endCommit: string | null;
  /**
   * Earlier stretches of a `base` task's work, oldest first. A stretch ends when the task
   * comes back to a folder whose HEAD moved after its last session; empty otherwise.
   */
  priorSpans: CommitSpan[];
  status: TaskStatus;
  mode: TaskMode;
  /**
   * Shell command the harness runs to check the work. A loop task needs one before it
   * starts building; with `confirmPlan` it may be set when the plan is approved.
   */
  verifyCommand: string | null;
  /**
   * What must hold for the work to count as done, agreed with the user. Both the
   * implementer and the reviewer are given it; `null` when none was set.
   */
  acceptance: string | null;
  /**
   * Wait for the user to approve a plan before changing anything: the feature list of a
   * loop task, or the acceptance criteria a single task's agent proposes in a read-only
   * discussion first.
   */
  confirmPlan: boolean;
  contextPolicy: ContextPolicy;
  permission: PermissionPolicy;
  agents: TaskAgents;
  /** Unix ms; set while `status` is `waiting_quota`. */
  resumeAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Stored as the `criteria` event each time a single task's discussion session finishes
 * (first proposal and every revision). Nothing is changed until the user approves.
 */
export interface CriteriaProposal {
  /** The criteria section of the reply; `null` when the agent did not write one. */
  criteria: string | null;
  /** The agent's whole reply, with its questions for the user. */
  reply: string;
  /** The questions section of the reply, with the options it lists for each. */
  questions: PlanQuestion[];
}

/** Stored as the `criteria_approved` event; the criteria are saved on the task too. */
export interface CriteriaApproval {
  criteria: string;
}

/** Who asked for a change to a spec that work has already started on. */
export type SpecChangeOrigin = 'user' | 'implementer';

/**
 * Stored as the `spec_revision` event when the user asks to change a single task's spec
 * after the spec file was written, and again for each reply to a proposed change. The spec
 * author answers it in a read-only session with a {@link SpecChangeProposal}.
 */
export interface SpecRevisionRequest {
  message: string;
  /** The task's status when asked; a rejected change returns a task that was in review there. */
  status: TaskStatus;
}

/**
 * Stored as the `spec_change` event: revised acceptance criteria waiting for the user, from
 * the spec author answering a {@link SpecRevisionRequest} or from the implementer's
 * `SPEC CHANGE:` block. Nothing more is built until the user approves or rejects it.
 */
export interface SpecChangeProposal {
  from: SpecChangeOrigin;
  /** Why: the user's message, or the reason on the implementer's marker line. */
  reason: string;
  /** The criteria in force when the change was proposed. */
  previous: string;
  /** The complete revised criteria; `null` when the reply had none, so the user writes them. */
  criteria: string | null;
  /** The reply the proposal was read from. */
  reply: string;
  /** Status a rejection returns the task to. */
  onReject: 'queued' | 'review';
  /**
   * The spec author's read-only session that wrote a proposal from the user's request;
   * `null` for the implementer's. Later implementer sessions never continue it.
   */
  sessionId: string | null;
  /**
   * Id of the `spec_revision` event the spec author was given and answered; `null` for the
   * implementer's. A request made while it answered stays waiting for its own answer.
   */
  requestId: number | null;
}

/**
 * Stored as the `spec_delivered` event in the session whose prompt carries a request for a
 * spec change or a decision on one, so it counts as told only once that session heard it.
 */
export interface SpecDelivery {
  /** Id of the `spec_revision` or `spec_change_decision` event. */
  eventId: number;
}

/** Stored as the `spec_change_decision` event when the user approves or rejects a change. */
export interface SpecChangeDecision {
  approved: boolean;
  from: SpecChangeOrigin;
  reason: string;
  previous: string;
  /** The criteria now in force: the approved ones, or the unchanged `previous`. */
  criteria: string;
}

/** Stored as the `merged` event when a task's branch was merged into its base. */
export interface MergeRecord {
  base: string;
  branch: string;
  /** The merge commit on `base`. */
  commit: string;
}

/**
 * Stored as the `merge_conflict` event when the base had conflicting changes: the harness
 * started merging the base into the task's worktree, and its agent resolves `files`.
 */
export interface MergeConflict {
  base: string;
  files: string[];
}

/** Reply to `POST /api/tasks/:id/merge`. */
export type MergeResult =
  ({ status: 'merged' } & MergeRecord) | ({ status: 'conflicts' } & MergeConflict);

export type SessionEndReason =
  'completed' | 'handoff' | 'context_hard_limit' | 'quota' | 'stopped' | 'error';

export interface Session {
  id: string;
  taskId: number;
  role: AgentRole;
  /** Agent profile id the session ran with. */
  agentId: string;
  /** The agent CLI's own id for the session, used to resume it; `null` until it reports one. */
  agentSessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: SessionEndReason | null;
  /** Tokens in context after the latest model call. */
  contextTokens: number;
  contextWindow: number | null;
}
