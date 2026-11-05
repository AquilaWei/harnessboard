// SPDX-License-Identifier: Apache-2.0
import type { CoalescingSettings } from './config.js';

/** Worker events a secretary batch would take now. */
export interface PendingEvents {
  count: number;
  /** Timestamp of the oldest waiting event; `null` when none wait. */
  oldestTs: number | null;
  /** A worker failed or stopped: the PM needs to hear about it without delay. */
  urgent: boolean;
  /** A high-risk permission is waiting; it goes straight to the PM. */
  highRisk: boolean;
}

/**
 * Groups worker events while two or more workers run, so the secretary reads them in one
 * model call instead of one call per event. Nothing is dropped or reordered: events stay in
 * the store and a batch takes all of them; this only decides *when* a batch starts. It owns
 * one timer, armed from the oldest waiting event's own timestamp, so a restart recomputes the
 * same deadline and an event can never wait on a timer that was lost.
 */
export class EventCoalescer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly settings: CoalescingSettings,
    /** Called when the delay of the oldest event ends, to run the coordination loop again. */
    private readonly wake: () => void,
  ) {}

  /** `true`: start a batch now. `false`: keep waiting; the timer or a later event decides. */
  ready(running: number, pending: PendingEvents): boolean {
    const { maxDelaySeconds, thresholdCap } = this.settings;
    if (
      maxDelaySeconds === 0 ||
      running < 2 ||
      pending.count === 0 ||
      pending.oldestTs === null ||
      pending.urgent ||
      pending.highRisk ||
      pending.count >= Math.min(running, thresholdCap)
    ) {
      this.clear();
      return true;
    }
    const wait = pending.oldestTs + maxDelaySeconds * 1000 - Date.now();
    if (wait <= 0) {
      this.clear();
      return true;
    }
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, wait);
    return false;
  }

  /** Drops the timer: a batch or PM turn took the events, or the task stops or restarts. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
