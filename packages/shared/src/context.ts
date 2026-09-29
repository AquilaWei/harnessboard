// SPDX-License-Identifier: Apache-2.0
import type { ContextPolicy, TaskSize } from './task.js';

/** Soft threshold per task size; the user-facing range is 30–50 %. */
export const SOFT_PCT_BY_SIZE: Record<TaskSize, number> = {
  small: 30,
  medium: 40,
  large: 50,
};
/** Gap between the soft (wrap up) and hard (end session) thresholds. */
export const HARD_GAP_PCT = 10;
export const DEFAULT_TASK_SIZE: TaskSize = 'medium';

export interface Thresholds {
  softPct: number;
  hardPct: number;
}

/**
 * Resolves the effective thresholds for a task.
 * Throws when the explicit values are out of range or soft is not below hard,
 * so a bad policy is rejected when the task is created rather than mid-run.
 */
export function resolveThresholds(policy: ContextPolicy): Thresholds {
  const softPct = policy.softPct ?? SOFT_PCT_BY_SIZE[policy.size ?? DEFAULT_TASK_SIZE];
  const hardPct = policy.hardPct ?? Math.min(softPct + HARD_GAP_PCT, 100);
  if (softPct <= 0 || hardPct > 100 || softPct >= hardPct) {
    throw new RangeError(`invalid context thresholds: soft ${softPct}%, hard ${hardPct}%`);
  }
  return { softPct, hardPct };
}

/** Context usage as a percentage of the window, rounded to one decimal. */
export function contextPct(tokens: number, window: number): number {
  return Math.round((tokens / window) * 1000) / 10;
}
