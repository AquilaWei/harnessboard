// SPDX-License-Identifier: Apache-2.0
import type { AgentRole, TaskAgents } from './agents.js';

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
  softPct?: number;
  hardPct?: number;
}

export interface PermissionPolicy {
  /** Tool rules passed to `--allowedTools`, e.g. `Bash(npm test)`. */
  allowedTools: string[];
  /** Maps to `--dangerously-skip-permissions`; must be opted into per task. */
  skipPermissions: boolean;
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
  /** Loop tasks: wait for the user to approve the planned features before building. */
  confirmPlan: boolean;
  contextPolicy: ContextPolicy;
  permission: PermissionPolicy;
  agents: TaskAgents;
  /** Unix ms; set while `status` is `waiting_quota`. */
  resumeAt: number | null;
  createdAt: number;
  updatedAt: number;
}

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
