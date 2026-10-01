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
/** Context use at which a session is compacted with `/compact` and continues. */
export const DEFAULT_COMPACT_PCT = 30;

export interface Thresholds {
  /** `null` when compaction is turned off (a policy `compactPct` of 0). */
  compactPct: number | null;
  softPct: number;
  hardPct: number;
}

/**
 * Resolves the effective thresholds for a task.
 * Throws when the explicit values are out of range, soft is not below hard, or compaction
 * would only start at or past hard, so a bad policy is rejected when the task is created
 * rather than mid-run.
 */
export function resolveThresholds(policy: ContextPolicy): Thresholds {
  const softPct = policy.softPct ?? SOFT_PCT_BY_SIZE[policy.size ?? DEFAULT_TASK_SIZE];
  const hardPct = policy.hardPct ?? Math.min(softPct + HARD_GAP_PCT, 100);
  if (softPct <= 0 || hardPct > 100 || softPct >= hardPct) {
    throw new RangeError(`invalid context thresholds: soft ${softPct}%, hard ${hardPct}%`);
  }
  const compact = policy.compactPct;
  if (compact !== undefined && (compact < 0 || compact >= hardPct)) {
    throw new RangeError(`invalid compact threshold: ${compact}% (hard is ${hardPct}%)`);
  }
  // The default only applies where it comes before the hard limit (not with a low custom one).
  const compactPct =
    compact === undefined ? (DEFAULT_COMPACT_PCT < hardPct ? DEFAULT_COMPACT_PCT : null) : compact;
  return { compactPct: compactPct === 0 ? null : compactPct, softPct, hardPct };
}

/** Context usage as a percentage of the window, rounded to one decimal. */
export function contextPct(tokens: number, window: number): number {
  return Math.round((tokens / window) * 1000) / 10;
}
