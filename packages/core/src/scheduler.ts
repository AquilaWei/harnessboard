// SPDX-License-Identifier: Apache-2.0
import type { QuotaInfo, Task } from '@harnessboard/shared';
import { isQuotaLimited } from './runner.js';

/**
 * True while no new session should start: the agent reported requests are refused, or
 * five-hour usage is at or above `pauseAt`. Each condition ends when its own window resets:
 * a refusal with the limiting window, high usage with the five-hour window.
 */
export function quotaBlocks(quota: QuotaInfo | null, now: number, pauseAt: number): boolean {
  if (!quota) return false;
  if (isQuotaLimited(quota)) return !hasPassed(quota.resetsAt, now);
  if (hasPassed(quota.fiveHourResetsAt ?? quota.resetsAt, now)) return false;
  return (quota.fiveHourUtilization ?? 0) >= pauseAt;
}

function hasPassed(time: number | null, now: number): boolean {
  return time !== null && time <= now;
}

/** Tasks waiting for quota whose retry time has come. */
export function dueForRetry(tasks: Task[], now: number): Task[] {
  return tasks.filter(
    (t) => t.status === 'waiting_quota' && t.resumeAt !== null && t.resumeAt <= now,
  );
}

/**
 * Queued tasks to start now, oldest first, without exceeding `maxConcurrent`.
 * A task stays `queued` in the store until its worktree is ready, so `running` is checked
 * to avoid starting it twice.
 */
export function startable(
  tasks: Task[],
  running: ReadonlyMap<number, unknown>,
  maxConcurrent: number,
): Task[] {
  const free = Math.max(0, maxConcurrent - running.size);
  return tasks.filter((t) => t.status === 'queued' && !running.has(t.id)).slice(0, free);
}
