// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@harnessboard/shared';
import { Watchdog, WATCHDOG_DEFAULTS, environmentError } from '../src/watchdog.js';
import type { WatchdogAlert } from '../src/watchdog.js';

const MIN = 60_000;
let alerts: WatchdogAlert[];
let dog: Watchdog;

const use = (callId: string, name: string, summary: string, argsKey = summary): AgentEvent => ({
  kind: 'tool_use',
  callId,
  name,
  summary,
  argsKey,
});
const failed = (callId: string, text: string): AgentEvent => ({
  kind: 'tool_result',
  callId,
  isError: true,
  text,
});
const succeeded = (callId: string): AgentEvent => ({
  kind: 'tool_result',
  callId,
  isError: false,
  text: 'ok',
});

beforeEach(() => {
  vi.useFakeTimers();
  alerts = [];
  dog = new Watchdog(WATCHDOG_DEFAULTS, (alert) => alerts.push(alert));
});
afterEach(() => {
  dog.clear();
  vi.useRealTimers();
});

describe('environmentError', () => {
  it.each([
    ['bash: line 1: pnpm: command not found', 'command-not-found:pnpm'],
    ['/bin/bash: line 1: cargo: command not found', 'command-not-found:cargo'],
    ['sh: 1: eslint: not found', 'command-not-found:eslint'],
    ['Error: spawn git ENOENT', 'spawn-enoent:git'],
    ["Error: Cannot find module 'left-pad'", 'missing-module:left-pad'],
    ["ModuleNotFoundError: No module named 'numpy'", 'missing-module:numpy'],
    ['getaddrinfo ENOTFOUND registry.npmjs.org', 'dns:registry.npmjs.org'],
    ['fatal: unable to access: Could not resolve host: github.com', 'dns:github.com'],
    ['ENOSPC: no space left on device, write', 'disk-full'],
    ['touch: cannot touch x: Read-only file system', 'read-only-fs'],
  ])('recognizes %j as an environment error', (text, signature) => {
    expect(environmentError(text)).toBe(signature);
  });

  it.each([
    'AssertionError: expected 1 to be 2',
    ' FAIL  test/a.test.ts > adds numbers\nExpected: 3\nReceived: 4',
    "/src/a.ts\n  3:7  error  'x' is assigned a value but never used  @typescript-eslint/no-unused-vars",
    "src/a.ts(3,1): error TS2304: Cannot find name 'foo'.",
    "Error: Cannot find module './local-file.js'",
    "ENOENT: no such file or directory, open 'missing.txt'",
    'error: could not compile `app` due to 2 previous errors',
    'git: the file is not found in the index',
  ])('does not treat %j as an environment error', (text) => {
    expect(environmentError(text)).toBeNull();
  });
});

describe('deadline', () => {
  // Keep the idle clock out of the way: these tests advance time without any event.
  beforeEach(() => {
    dog = new Watchdog({ ...WATCHDOG_DEFAULTS, idleMinutes: 10_000 }, (a) => alerts.push(a));
  });

  it('fires once at the estimate times 1.5', () => {
    dog.start('w', { expectedMinutes: 10 });
    vi.advanceTimersByTime(15 * MIN - 1);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(alerts).toEqual([
      { workId: 'w', reason: 'deadline', expectedMinutes: 10, runMs: 15 * MIN },
    ]);
  });

  it('does not fire again after it was reported', () => {
    dog.start('w', { expectedMinutes: 10 });
    vi.advanceTimersByTime(15 * MIN);
    vi.advanceTimersByTime(300 * MIN);
    expect(alerts.filter((a) => a.reason === 'deadline')).toHaveLength(1);
  });

  it('uses the 30 minute default when there is no estimate', () => {
    dog.start('w', {});
    vi.advanceTimersByTime(45 * MIN - 1);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(alerts[0]).toMatchObject({ reason: 'deadline', expectedMinutes: 30 });
  });

  it('honors a configured multiplier', () => {
    dog = new Watchdog({ ...WATCHDOG_DEFAULTS, deadlineMultiplier: 2, idleMinutes: 10_000 }, (a) =>
      alerts.push(a),
    );
    dog.start('w', { expectedMinutes: 10 });
    vi.advanceTimersByTime(20 * MIN - 1);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(alerts).toHaveLength(1);
  });

  it('does not fire at once for a budget longer than the timer limit', () => {
    dog = new Watchdog(
      { ...WATCHDOG_DEFAULTS, deadlineMultiplier: 100, idleMinutes: 10_000 },
      (a) => alerts.push(a),
    );
    dog.start('w', { expectedMinutes: 10_080 });
    vi.advanceTimersByTime(60 * MIN);
    expect(alerts).toEqual([]);
  });

  it('keeps exactly one deadline timer per job', () => {
    dog.start('w', { expectedMinutes: 10 });
    dog.rearm('w', 20);
    dog.rearm('w', 30);
    // One deadline timer plus the idle timer.
    expect(vi.getTimerCount()).toBe(2);
  });

  it('starts the budget over when a running job gets a new estimate', () => {
    dog.start('w', { expectedMinutes: 10 });
    vi.advanceTimersByTime(14 * MIN);
    dog.rearm('w', 20);
    vi.advanceTimersByTime(29 * MIN);
    expect(alerts.filter((a) => a.reason === 'deadline')).toEqual([]);
    vi.advanceTimersByTime(1 * MIN);
    expect(alerts.filter((a) => a.reason === 'deadline')).toHaveLength(1);
  });

  it('arms from the recorded remaining time instead of the full budget', () => {
    dog.start('w', { expectedMinutes: 10, deadlineRemainingMs: 4 * MIN });
    vi.advanceTimersByTime(4 * MIN - 1);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(alerts).toHaveLength(1);
  });

  it('stays quiet when the recorded deadline was already reported', () => {
    dog.start('w', { expectedMinutes: 10, deadlineRemainingMs: null });
    vi.advanceTimersByTime(600 * MIN);
    expect(alerts.filter((a) => a.reason === 'deadline')).toEqual([]);
  });
});

describe('idle', () => {
  it('fires after 15 minutes without an event', () => {
    dog.start('w', { expectedMinutes: 600 });
    vi.advanceTimersByTime(15 * MIN - 1);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(alerts).toEqual([{ workId: 'w', reason: 'idle', idleMinutes: 15 }]);
  });

  it('restarts the 15 minutes at every event', () => {
    dog.start('w', { expectedMinutes: 600 });
    vi.advanceTimersByTime(10 * MIN);
    dog.event('w', { kind: 'text', text: 'working' });
    vi.advanceTimersByTime(14 * MIN);
    expect(alerts).toEqual([]);
    vi.advanceTimersByTime(1 * MIN);
    expect(alerts).toHaveLength(1);
  });

  it('reports one idle stretch once, until the next event', () => {
    dog.start('w', { expectedMinutes: 6000 });
    vi.advanceTimersByTime(200 * MIN);
    expect(alerts).toHaveLength(1);
  });

  it('honors a configured idle time', () => {
    dog = new Watchdog({ ...WATCHDOG_DEFAULTS, idleMinutes: 5 }, (a) => alerts.push(a));
    dog.start('w', { expectedMinutes: 600 });
    vi.advanceTimersByTime(5 * MIN);
    expect(alerts).toEqual([{ workId: 'w', reason: 'idle', idleMinutes: 5 }]);
  });
});

describe('repeated failure', () => {
  it('alerts when the same environment error happens twice in a row', () => {
    dog.start('w', {});
    dog.event('w', use('1', 'Bash', 'pnpm test'));
    dog.event('w', failed('1', 'bash: pnpm: command not found'));
    expect(alerts).toEqual([]);
    dog.event('w', use('2', 'Bash', 'pnpm lint'));
    dog.event('w', failed('2', 'bash: pnpm: command not found'));
    expect(alerts).toEqual([
      {
        workId: 'w',
        reason: 'repeated_failure',
        kind: 'environment',
        count: 2,
        tool: 'Bash',
        summary: 'pnpm lint',
        excerpt: 'bash: pnpm: command not found',
      },
    ]);
  });

  it('does not alert for two different environment errors', () => {
    dog.start('w', {});
    dog.event('w', use('1', 'Bash', 'a'));
    dog.event('w', failed('1', 'bash: pnpm: command not found'));
    dog.event('w', use('2', 'Bash', 'b'));
    dog.event('w', failed('2', 'bash: cargo: command not found'));
    expect(alerts).toEqual([]);
  });

  it('does not alert when a success separates two environment errors', () => {
    dog.start('w', {});
    dog.event('w', use('1', 'Bash', 'a'));
    dog.event('w', failed('1', 'bash: pnpm: command not found'));
    dog.event('w', use('2', 'Read', 'b'));
    dog.event('w', succeeded('2'));
    dog.event('w', use('3', 'Bash', 'c'));
    dog.event('w', failed('3', 'bash: pnpm: command not found'));
    expect(alerts).toEqual([]);
  });

  it('does not alert for a test failure repeated twice', () => {
    dog.start('w', {});
    dog.event('w', use('1', 'Bash', 'pnpm test', 'k1'));
    dog.event('w', failed('1', 'AssertionError: expected 1 to be 2'));
    dog.event('w', use('2', 'Bash', 'pnpm test', 'k2'));
    dog.event('w', failed('2', 'AssertionError: expected 1 to be 2'));
    expect(alerts).toEqual([]);
  });

  it('alerts at the third identical failed call in a row', () => {
    dog.start('w', {});
    for (const id of ['1', '2']) {
      dog.event('w', use(id, 'Bash', 'pnpm test', 'same'));
      dog.event('w', failed(id, 'AssertionError: expected 1 to be 2'));
    }
    expect(alerts).toEqual([]);
    dog.event('w', use('3', 'Bash', 'pnpm test', 'same'));
    dog.event('w', failed('3', 'AssertionError: expected 1 to be 2'));
    expect(alerts).toMatchObject([
      { reason: 'repeated_failure', kind: 'identical_call', count: 3 },
    ]);
  });

  it('does not alert when the third failed call has different arguments', () => {
    dog.start('w', {});
    dog.event('w', use('1', 'Bash', 'pnpm test', 'a'));
    dog.event('w', failed('1', 'boom'));
    dog.event('w', use('2', 'Bash', 'pnpm test', 'a'));
    dog.event('w', failed('2', 'boom'));
    dog.event('w', use('3', 'Bash', 'pnpm test -u', 'b'));
    dog.event('w', failed('3', 'boom'));
    expect(alerts).toEqual([]);
  });

  it('honors a configured identical-call limit', () => {
    dog = new Watchdog({ ...WATCHDOG_DEFAULTS, repeatedCallLimit: 2 }, (a) => alerts.push(a));
    dog.start('w', {});
    for (const id of ['1', '2']) {
      dog.event('w', use(id, 'Bash', 'x', 'same'));
      dog.event('w', failed(id, 'boom'));
    }
    expect(alerts).toHaveLength(1);
  });

  it('bounds the evidence excerpt to 2000 characters', () => {
    dog.start('w', {});
    const text = `${'x'.repeat(5000)}\nbash: pnpm: command not found`;
    for (const id of ['1', '2']) {
      dog.event('w', use(id, 'Bash', 'pnpm', id));
      dog.event('w', failed(id, text));
    }
    expect((alerts[0] as { excerpt: string }).excerpt).toHaveLength(2000);
  });
});

describe('pausing the clocks', () => {
  it('stops the deadline while paused and resumes with the remaining time', () => {
    dog.start('w', { expectedMinutes: 10 });
    vi.advanceTimersByTime(5 * MIN);
    dog.pause('w');
    vi.advanceTimersByTime(100 * MIN);
    expect(alerts.filter((a) => a.reason === 'deadline')).toEqual([]);
    dog.resume('w');
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(alerts.filter((a) => a.reason === 'deadline')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(alerts.filter((a) => a.reason === 'deadline')).toHaveLength(1);
  });

  it('stops the idle clock while paused', () => {
    dog.start('w', { expectedMinutes: 6000 });
    dog.pause('w');
    vi.advanceTimersByTime(100 * MIN);
    expect(alerts).toEqual([]);
  });

  it('counts only the time spent running, not the time spent paused', () => {
    dog.start('w', { expectedMinutes: 600 });
    vi.advanceTimersByTime(3 * MIN);
    dog.pause('w');
    vi.advanceTimersByTime(50 * MIN);
    dog.resume('w');
    vi.advanceTimersByTime(2 * MIN);
    expect(dog.stop('w')).toEqual({ runMs: 5 * MIN, deadlineRemainingMs: 895 * MIN });
  });
});

describe('stopping', () => {
  it('reports run time and remaining budget when a turn stops', () => {
    dog.start('w', { expectedMinutes: 10, runMs: 2 * MIN });
    vi.advanceTimersByTime(4 * MIN);
    expect(dog.stop('w')).toEqual({ runMs: 6 * MIN, deadlineRemainingMs: 11 * MIN });
  });

  it('reports a reported deadline as null so it is not replayed', () => {
    dog.start('w', { expectedMinutes: 10 });
    vi.advanceTimersByTime(20 * MIN);
    expect(dog.stop('w')?.deadlineRemainingMs).toBeNull();
  });

  it('clears every timer when a job stops', () => {
    dog.start('w', { expectedMinutes: 10 });
    dog.stop('w');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears every timer of every job on clear', () => {
    dog.start('a', {});
    dog.start('b', {});
    dog.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns null for a job that is not running', () => {
    expect(dog.stop('unknown')).toBeNull();
  });
});
