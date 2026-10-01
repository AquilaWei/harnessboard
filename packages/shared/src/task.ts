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
 * `single`: one prompt, handed off across sessions until the agent finishes.
 * `loop`: an initializer session writes a feature list, then each session implements one
 * feature and the harness runs the task's verify command itself before counting it.
 */
export type TaskMode = 'single' | 'loop';

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
   * Allow tools the rules do not cover without asking, unless they look risky (see
   * `riskOf`). Absent on tasks from before it existed, which means off.
   */
  autoApprove?: boolean;
}

export interface Task {
  id: number;
  title: string;
  prompt: string;
  /** Absolute path of the repository the task works on. */
  repoPath: string;
  /** Git ref the task branch starts from. */
  baseRef: string;
  branch: string | null;
  worktreePath: string | null;
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
