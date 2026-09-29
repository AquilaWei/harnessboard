// SPDX-License-Identifier: Apache-2.0

export const TASK_STATUSES = [
  'backlog',
  'queued',
  'running',
  'waiting_quota',
  'review',
  'done',
  'failed',
  'stopped',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

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
  contextPolicy: ContextPolicy;
  permission: PermissionPolicy;
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
  startedAt: number;
  endedAt: number | null;
  endReason: SessionEndReason | null;
  /** Tokens in context after the latest model call. */
  contextTokens: number;
  contextWindow: number | null;
}
