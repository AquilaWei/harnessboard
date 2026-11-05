// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent } from '@harnessboard/shared';
import { excerpt } from './tool-events.js';

/** Thresholds for the watchdog; all durations are in the units named by the key. */
export interface WatchdogSettings {
  /** The deadline is the caller's estimate times this. */
  deadlineMultiplier: number;
  /** Estimate used when the caller gave none. */
  defaultMinutes: number;
  /** No transport event for this long raises an idle alert. */
  idleMinutes: number;
  /** Identical failed tool calls in a row that pause the worker. */
  repeatedCallLimit: number;
  /** The same environment error in a row that pauses the worker. */
  environmentRepeatLimit: number;
}

export const WATCHDOG_DEFAULTS: WatchdogSettings = {
  deadlineMultiplier: 1.5,
  defaultMinutes: 30,
  idleMinutes: 15,
  repeatedCallLimit: 3,
  environmentRepeatLimit: 2,
};

export type WatchdogAlert =
  | { workId: string; reason: 'deadline'; expectedMinutes: number; runMs: number }
  | { workId: string; reason: 'idle'; idleMinutes: number }
  | {
      workId: string;
      reason: 'repeated_failure';
      /** `environment`: the same environment error; `identical_call`: the same failed call. */
      kind: 'environment' | 'identical_call';
      count: number;
      tool: string;
      summary: string;
      /** Bounded excerpt of the last failing output. */
      excerpt: string;
    };

/** What a turn leaves on the work record when it stops. */
export interface WatchdogTiming {
  runMs: number;
  /** `null`: the deadline was already reported. */
  deadlineRemainingMs: number | null;
}

/** Longest estimate or idle time accepted, in minutes (one week). */
export const MAX_EXPECTED_MINUTES = 10_080;

/** Longest delay `setTimeout` accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Environment failures that retrying cannot fix: a missing program or dependency, a full or
 * read-only disk, no name resolution. Returns a normalized signature (same cause, same text)
 * or `null`. Deliberately narrow: assertion failures, compiler or lint errors and missing
 * project files are code problems the worker can fix, so they never match.
 */
export function environmentError(text: string): string | null {
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/(?:^|[\s:])([\w./+-]+): command not found\b/im, (m) => `command-not-found:${m[1]}`],
    [/\bsh: \d+: ([\w./+-]+): not found\b/i, (m) => `command-not-found:${m[1]}`],
    [/\bspawn (\S+) (ENOENT|EACCES)\b/i, (m) => `spawn-${m[2]!.toLowerCase()}:${m[1]}`],
    [
      /\bCannot find (?:module|package) '([^./'][^']*)'/i,
      (m) => `missing-module:${m[1]!.toLowerCase()}`,
    ],
    [/\bNo module named '?([\w.-]+)'?/i, (m) => `missing-module:${m[1]!.toLowerCase()}`],
    [/\bgetaddrinfo (?:ENOTFOUND|EAI_AGAIN) (\S+)/i, (m) => `dns:${m[1]!.toLowerCase()}`],
    [/\bCould not resolve host:? (\S+)/i, (m) => `dns:${m[1]!.toLowerCase()}`],
    [/\bTemporary failure in name resolution\b/i, () => 'dns:resolution'],
    [/\bENOSPC\b|\bNo space left on device\b/i, () => 'disk-full'],
    [/\bEROFS\b|\bRead-only file system\b/i, () => 'read-only-fs'],
  ];
  for (const [pattern, signature] of patterns) {
    const match = text.match(pattern);
    if (match) return signature(match);
  }
  return null;
}

interface Call {
  callId?: string;
  name: string;
  summary: string;
  key: string;
}

interface Job {
  runMs: number;
  /** Remaining deadline budget while armed; `null` once reported. */
  remaining: number | null;
  /** Start of the current un-paused stretch; `null` while paused. */
  since: number | null;
  deadline: ReturnType<typeof setTimeout> | null;
  idle: ReturnType<typeof setTimeout> | null;
  expectedMinutes: number;
  calls: Call[];
  /** Run of equal failures: the key, the count so far. */
  environment: { signature: string; count: number } | null;
  identical: { key: string; count: number } | null;
}

/**
 * Detects stuck managed workers without a model. Each running job owns at most one deadline
 * timer and one idle timer; nothing polls. Timers run only while the job executes and is not
 * waiting for a permission answer, and are rebuilt from the recorded remaining time on every
 * turn, so a restart never replays a trigger. The watchdog reports; it never acts on a worker.
 */
export class Watchdog {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly settings: WatchdogSettings,
    private readonly alert: (alert: WatchdogAlert) => void,
  ) {}

  /**
   * Starts the clocks for one turn. `deadlineRemainingMs`: absent re-derives the budget from the
   * estimate, `null` means the deadline was already reported. `runMs` is the time earlier turns used.
   */
  start(
    workId: string,
    options: { expectedMinutes?: number; deadlineRemainingMs?: number | null; runMs?: number },
  ): void {
    this.stop(workId);
    const expectedMinutes = options.expectedMinutes ?? this.settings.defaultMinutes;
    const job: Job = {
      runMs: options.runMs ?? 0,
      remaining:
        options.deadlineRemainingMs === undefined
          ? expectedMinutes * this.settings.deadlineMultiplier * 60_000
          : options.deadlineRemainingMs,
      since: Date.now(),
      deadline: null,
      idle: null,
      expectedMinutes,
      calls: [],
      environment: null,
      identical: null,
    };
    this.jobs.set(workId, job);
    this.arm(workId, job);
  }

  /** A new estimate replaces the budget of a running job and starts its deadline over. */
  rearm(workId: string, expectedMinutes: number): void {
    const job = this.jobs.get(workId);
    if (!job) return;
    this.account(job);
    job.expectedMinutes = expectedMinutes;
    job.remaining = expectedMinutes * this.settings.deadlineMultiplier * 60_000;
    this.clearDeadline(job);
    if (job.since !== null) this.armDeadline(workId, job);
  }

  /** The agent waits for a permission answer: stop both clocks and keep the remaining time. */
  pause(workId: string): void {
    const job = this.jobs.get(workId);
    if (!job || job.since === null) return;
    this.account(job);
    job.since = null;
    this.clearDeadline(job);
    this.clearIdle(job);
  }

  resume(workId: string): void {
    const job = this.jobs.get(workId);
    if (!job || job.since !== null) return;
    job.since = Date.now();
    this.arm(workId, job);
  }

  /** Ends the turn's clocks. Returns what to record, or `null` when no turn was running. */
  stop(workId: string): WatchdogTiming | null {
    const job = this.jobs.get(workId);
    if (!job) return null;
    this.account(job);
    this.clearDeadline(job);
    this.clearIdle(job);
    this.jobs.delete(workId);
    return { runMs: job.runMs, deadlineRemainingMs: job.remaining };
  }

  /** Clears every clock (task stop or restart) without recording anything. */
  clear(): void {
    for (const id of [...this.jobs.keys()]) this.stop(id);
  }

  /** Feeds one transport event: resets the idle clock and checks tool results for repeats. */
  event(workId: string, event: AgentEvent): void {
    const job = this.jobs.get(workId);
    if (!job) return;
    if (job.since !== null) this.armIdle(workId, job);
    if (event.kind === 'tool_use') {
      job.calls.push({
        ...(event.callId ? { callId: event.callId } : {}),
        name: event.name,
        summary: event.summary,
        key: `${event.name}\0${event.argsKey ?? event.summary}`,
      });
    } else if (event.kind === 'tool_result') this.result(workId, job, event);
  }

  private result(
    workId: string,
    job: Job,
    event: Extract<AgentEvent, { kind: 'tool_result' }>,
  ): void {
    const index = event.callId ? job.calls.findIndex((c) => c.callId === event.callId) : 0;
    const call = job.calls.splice(Math.max(index, 0), 1)[0];
    if (!event.isError) {
      job.environment = null;
      job.identical = null;
      return;
    }
    const tool = call?.name ?? 'tool';
    const summary = call?.summary ?? '';
    const signature = environmentError(event.text);
    job.environment =
      signature === null
        ? null
        : {
            signature,
            count: job.environment?.signature === signature ? job.environment.count + 1 : 1,
          };
    job.identical = call
      ? { key: call.key, count: job.identical?.key === call.key ? job.identical.count + 1 : 1 }
      : null;
    const kind =
      job.environment && job.environment.count >= this.settings.environmentRepeatLimit
        ? ('environment' as const)
        : job.identical && job.identical.count >= this.settings.repeatedCallLimit
          ? ('identical_call' as const)
          : null;
    if (!kind) return;
    const count = kind === 'environment' ? job.environment!.count : job.identical!.count;
    job.environment = null;
    job.identical = null;
    this.alert({
      workId,
      reason: 'repeated_failure',
      kind,
      count,
      tool,
      summary,
      excerpt: excerpt(event.text),
    });
  }

  private account(job: Job): void {
    if (job.since === null) return;
    const spent = Date.now() - job.since;
    job.runMs += spent;
    if (job.remaining !== null) job.remaining = Math.max(0, job.remaining - spent);
    job.since = Date.now();
  }

  private arm(workId: string, job: Job): void {
    this.armDeadline(workId, job);
    this.armIdle(workId, job);
  }

  private armDeadline(workId: string, job: Job): void {
    this.clearDeadline(job);
    if (job.remaining === null) return;
    // A delay above the platform limit would fire at once, so long budgets wait in chunks.
    job.deadline = setTimeout(
      () => {
        job.deadline = null;
        this.account(job);
        if (job.remaining !== null && job.remaining > 0) {
          this.armDeadline(workId, job);
          return;
        }
        job.remaining = null; // reported once; a new estimate re-arms it
        this.alert({
          workId,
          reason: 'deadline',
          expectedMinutes: job.expectedMinutes,
          runMs: job.runMs,
        });
      },
      Math.min(job.remaining, MAX_TIMER_MS),
    );
  }

  private armIdle(workId: string, job: Job): void {
    this.clearIdle(job);
    job.idle = setTimeout(() => {
      job.idle = null;
      this.alert({ workId, reason: 'idle', idleMinutes: this.settings.idleMinutes });
    }, this.settings.idleMinutes * 60_000);
  }

  private clearDeadline(job: Job): void {
    if (job.deadline) clearTimeout(job.deadline);
    job.deadline = null;
  }

  private clearIdle(job: Job): void {
    if (job.idle) clearTimeout(job.idle);
    job.idle = null;
  }
}
