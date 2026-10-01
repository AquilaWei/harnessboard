// SPDX-License-Identifier: Apache-2.0

export interface QuotaWindow {
  utilization: number;
  resetsAt: number | null;
}

/**
 * A quota window as of `now`. The board only knows the last snapshot an agent reported, so a
 * window whose reset time has passed is shown as empty again, as the scheduler treats it.
 */
export function windowAt(
  utilization: number,
  resetsAt: number | null | undefined,
  now: number,
): QuotaWindow {
  if (resetsAt != null && resetsAt <= now) return { utilization: 0, resetsAt: null };
  return { utilization, resetsAt: resetsAt ?? null };
}
