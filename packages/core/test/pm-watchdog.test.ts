// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PmWork, Task } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { PmWorkflow, pmWork } from '../src/pm.js';
import type { PmHost, PmSessionPlan } from '../src/pm.js';
import type { SessionOutcome } from '../src/runner.js';
import { Store } from '../src/store.js';
import { DISPATCH_PLAN, makeRepo, tempDir } from './helpers.js';

const MIN = 60_000;
const completed: SessionOutcome = {
  reason: 'completed',
  finalText: 'done',
  quota: null,
  contextWindow: null,
  detail: null,
  usage: null,
};
const input = {
  plan: DISPATCH_PLAN,
  workspace: 'shared',
  agentId: 'claude',
  goal: 'Inspect',
  acceptance: 'Inspected',
  scope: 'repo',
  access: 'readOnly',
};

let store: Store;
let task: Task;
let host: PmHost;
let engine: PmWorkflow;
let controller: AbortController;
let pmActions: (() => Promise<void>)[];
let pmRuns: number;
/** One entry per worker turn, in start order. */
let turns: { plan: PmSessionPlan; signal: AbortSignal; finish: () => void }[];
let running: Promise<void>;

beforeEach(() => {
  // Only the clock is fake: git and file access use real I/O.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  store = new Store(':memory:');
  controller = new AbortController();
  const repo = makeRepo();
  task = store.createTask({
    title: 'Watchdog',
    prompt: 'Inspect',
    repoPath: repo,
    baseRef: 'main',
    workspace: 'base',
    workflow: 'pm',
    pm: {
      agentId: 'claude',
      model: null,
      effort: null,
      workers: [{ agentId: 'claude', models: [null] }],
    },
    mode: 'single',
    verifyCommand: null,
    acceptance: '- inspect',
    confirmPlan: true,
    contextPolicy: {},
    permission: { allowedTools: [], skipPermissions: false },
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
  });
  task = store.updateTask(task.id, { worktreePath: repo });
  store.appendEvent(task.id, null, 'criteria_approved', { criteria: task.acceptance });
  pmActions = [];
  pmRuns = 0;
  turns = [];
  host = {
    store,
    config: {
      ...defaultConfig({}),
      dataDir: tempDir('pm-watchdog'),
      // Idle alerts are tested on their own; elsewhere they would only add noise.
      pmWatchdog: { ...defaultConfig({}).pmWatchdog, idleMinutes: 10_000 },
    },
    run: vi.fn(async (_task, plan, _id, signal) => {
      if (plan.role === 'pm') {
        await pmActions[pmRuns++]?.();
        return completed;
      }
      if (plan.role !== 'worker') return completed;
      return new Promise<SessionOutcome>((resolve) => {
        const finish = () => resolve(completed);
        turns.push({ plan, signal, finish });
        signal.addEventListener('abort', () => resolve({ ...completed, reason: 'stopped' }), {
          once: true,
        });
      });
    }),
    status: (_id, status) => {
      store.updateTask(task.id, { status });
    },
    blocked: () => false,
    permissions: () => [],
    answer: vi.fn(),
    notice: vi.fn(),
  };
  engine = new PmWorkflow(host, task, controller.signal);
});

afterEach(async () => {
  controller.abort();
  await running?.catch(() => undefined);
  store.close();
  vi.useRealTimers();
});

/** Builds a fresh engine with changed watchdog settings, as after a restart of the process. */
function reconfigure(patch: Partial<PmHost['config']['pmWatchdog']>): void {
  host.config = { ...host.config, pmWatchdog: { ...host.config.pmWatchdog, ...patch } };
  engine = new PmWorkflow(host, task, controller.signal);
}

/** Waits for real I/O by yielding to the event loop; fake timers stay untouched. */
async function until(condition: () => boolean): Promise<void> {
  // performance.now is not faked; git runs in real child processes.
  const limit = performance.now() + 8000;
  while (!condition() && performance.now() < limit) await new Promise((r) => setImmediate(r));
  expect(condition()).toBe(true);
}
const works = (): PmWork[] => pmWork(store, task.id);
const watchdogEvents = () => store.eventsOfKind(task.id, 'watchdog').map((e) => e.data);
async function advance(minutes: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(minutes * MIN);
  // Let work triggered by a timer (event writes, PM turns) settle.
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}
/** The first PM turn dispatches one worker, then ends its turn waiting. */
async function startWorker(extra: Record<string, unknown> = {}): Promise<string> {
  let id = '';
  pmActions[0] = async () => {
    id = ((await engine.call('dispatch', { ...input, ...extra })) as { workId: string }).workId;
    await engine.call('wait', {});
  };
  running = engine.run();
  await until(() => turns.length === 1);
  return id;
}
const use = (callId: string, command: string) =>
  ({ kind: 'tool_use', callId, name: 'Bash', summary: command, argsKey: command }) as const;
const fail = (callId: string, text: string) =>
  ({ kind: 'tool_result', callId, isError: true, text }) as const;

it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, '10', 10081])(
  'rejects dispatch with expectedMinutes %j',
  async (value) => {
    pmActions[0] = async () => {
      await expect(engine.call('dispatch', { ...input, expectedMinutes: value })).rejects.toThrow(
        /expectedMinutes must be a number/,
      );
    };
    running = engine.run();
    await until(() => pmRuns === 1);
    expect(works()).toEqual([]);
  },
);

it('rejects edit_work with an invalid expectedMinutes', async () => {
  pmActions[0] = async () => {
    await expect(
      engine.call('edit_work', {
        goal: 'g',
        acceptance: 'a',
        scope: 's',
        writePaths: ['src/'],
        plan: DISPATCH_PLAN,
        expectedMinutes: -1,
      }),
    ).rejects.toThrow(/expectedMinutes must be a number/);
  };
  running = engine.run();
  await until(() => pmRuns === 1);
  expect(works()).toEqual([]);
});

it('rejects continue_work with an invalid expectedMinutes', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  let rejected = '';
  pmActions[1] = async () => {
    rejected = await engine
      .call('continue_work', { id, message: 'go on', expectedMinutes: 0 })
      .then(
        () => 'accepted',
        (e: Error) => e.message,
      );
  };
  engine.notify();
  await until(() => rejected !== '');
  expect(rejected).toMatch(/expectedMinutes must be a number/);
});

it('records the estimate on the work record', async () => {
  await startWorker({ expectedMinutes: 12.5 });
  expect(works()[0]!.expectedMinutes).toBe(12.5);
});

it('records the actual run time when the worker delivers', async () => {
  await startWorker({ expectedMinutes: 10 });
  await advance(4);
  turns[0]!.finish();
  await until(() => works()[0]!.status === 'completed');
  expect(works()[0]).toMatchObject({ expectedMinutes: 10, runMs: 4 * MIN });
});

it('reports the deadline once at the estimate times 1.5', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  await advance(15 - 0.001);
  expect(watchdogEvents()).toEqual([]);
  await advance(0.001);
  await advance(120);
  expect(watchdogEvents()).toMatchObject([{ workId: id, reason: 'deadline', expectedMinutes: 10 }]);
});

it('uses 30 minutes times 1.5 when the PM gave no estimate', async () => {
  await startWorker();
  await advance(44);
  expect(watchdogEvents()).toEqual([]);
  await advance(1);
  expect(watchdogEvents()).toMatchObject([{ reason: 'deadline', expectedMinutes: 30 }]);
});

it('wakes the PM once for a deadline', async () => {
  await startWorker({ expectedMinutes: 1 });
  await advance(2);
  await until(() => pmRuns === 2);
  await advance(200);
  expect(pmRuns).toBe(2);
});

it('does not stop the worker when its deadline passes', async () => {
  await startWorker({ expectedMinutes: 1 });
  await advance(2);
  expect(turns[0]!.signal.aborted).toBe(false);
  expect(works()[0]!.status).toBe('running');
});

it('re-arms the deadline when continue_work gives the running worker a new estimate', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  pmActions[1] = async () => {
    await engine.call('continue_work', { id, message: 'extend', expectedMinutes: 20 });
  };
  await advance(16);
  await until(() => pmRuns === 2);
  expect(watchdogEvents()).toHaveLength(1);
  await advance(29);
  expect(watchdogEvents()).toHaveLength(1);
  await advance(1);
  expect(watchdogEvents()).toHaveLength(2);
});

it('tells the PM that a running worker got the estimate but not the message', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  let result: unknown;
  pmActions[1] = async () => {
    result = await engine.call('continue_work', { id, message: 'extend', expectedMinutes: 20 });
  };
  engine.notify();
  await until(() => result !== undefined);
  expect(result).toMatchObject({
    id,
    expectedMinutes: 20,
    estimateUpdated: true,
    messageDelivered: false,
  });
});

it('still refuses continue_work on a running worker when no estimate is given', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  let rejected = '';
  pmActions[1] = async () => {
    rejected = await engine.call('continue_work', { id, message: 'go on' }).then(
      () => 'accepted',
      (e: Error) => e.message,
    );
  };
  engine.notify();
  await until(() => rejected !== '');
  expect(rejected).toBe('Worker is already active or still finishing');
});

it('records the new estimate of a running worker', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  pmActions[1] = async () => {
    await engine.call('continue_work', { id, message: 'extend', expectedMinutes: 20 });
  };
  await advance(16);
  await until(() => pmRuns === 2);
  expect(works()[0]!.expectedMinutes).toBe(20);
});

it('reports 15 minutes without any event as idle', async () => {
  reconfigure({ idleMinutes: 15 });
  const id = await startWorker({ expectedMinutes: 600 });
  await advance(14);
  expect(watchdogEvents()).toEqual([]);
  await advance(1);
  expect(watchdogEvents()).toMatchObject([{ workId: id, reason: 'idle', idleMinutes: 15 }]);
});

it('restarts the idle time whenever the worker emits an event', async () => {
  reconfigure({ idleMinutes: 15 });
  await startWorker({ expectedMinutes: 600 });
  await advance(10);
  turns[0]!.plan.onEvent?.({ kind: 'text', text: 'working' });
  await advance(14);
  expect(watchdogEvents()).toEqual([]);
  await advance(1);
  expect(watchdogEvents()).toHaveLength(1);
});

it('pauses the worker and escalates when the same environment error happens twice', async () => {
  const id = await startWorker();
  const plan = turns[0]!.plan;
  plan.onEvent?.(use('1', 'pnpm test'));
  plan.onEvent?.(fail('1', 'bash: pnpm: command not found'));
  plan.onEvent?.(use('2', 'pnpm lint'));
  plan.onEvent?.(fail('2', 'bash: pnpm: command not found'));
  await until(() => works()[0]!.status === 'awaiting_pm');
  expect(watchdogEvents()).toMatchObject([
    {
      workId: id,
      reason: 'repeated_failure',
      kind: 'environment',
      count: 2,
      excerpt: 'bash: pnpm: command not found',
    },
  ]);
});

it('ends only the current turn when pausing and keeps the session', async () => {
  await startWorker();
  const sessionBefore = works()[0]!.sessionId;
  const plan = turns[0]!.plan;
  plan.onEvent?.(use('1', 'a'));
  plan.onEvent?.(fail('1', 'bash: pnpm: command not found'));
  plan.onEvent?.(use('2', 'b'));
  plan.onEvent?.(fail('2', 'bash: pnpm: command not found'));
  await until(() => works()[0]!.status === 'awaiting_pm');
  expect(turns[0]!.signal.aborted).toBe(true);
  expect(works()[0]).toMatchObject({ sessionId: sessionBefore, status: 'awaiting_pm' });
});

it('wakes the PM directly for a pause, without a secretary update', async () => {
  await startWorker();
  const plan = turns[0]!.plan;
  for (const id of ['1', '2']) {
    plan.onEvent?.(use(id, id));
    plan.onEvent?.(fail(id, 'bash: pnpm: command not found'));
  }
  await until(() => pmRuns === 2);
  expect(store.eventsOfKind(task.id, 'pm_worker_update')).toEqual([]);
});

it('resumes a paused worker when the PM continues it', async () => {
  const id = await startWorker();
  const plan = turns[0]!.plan;
  for (const call of ['1', '2']) {
    plan.onEvent?.(use(call, call));
    plan.onEvent?.(fail(call, 'bash: pnpm: command not found'));
  }
  pmActions[1] = async () => {
    await engine.call('continue_work', { id, message: 'pnpm is installed now' });
  };
  await until(() => turns.length === 2);
  expect(turns[1]!.signal.aborted).toBe(false);
});

it('pauses at the third identical failed call', async () => {
  const id = await startWorker();
  const plan = turns[0]!.plan;
  for (const call of ['1', '2', '3']) {
    plan.onEvent?.(use(call, 'pnpm test'));
    plan.onEvent?.(fail(call, 'AssertionError: expected 1 to be 2'));
  }
  await until(() => works()[0]!.status === 'awaiting_pm');
  expect(watchdogEvents()).toMatchObject([
    { workId: id, reason: 'repeated_failure', kind: 'identical_call', count: 3 },
  ]);
});

it('does not pause after two identical failed calls', async () => {
  await startWorker();
  const plan = turns[0]!.plan;
  for (const call of ['1', '2']) {
    plan.onEvent?.(use(call, 'pnpm test'));
    plan.onEvent?.(fail(call, 'AssertionError: expected 1 to be 2'));
  }
  await advance(1);
  expect(works()[0]!.status).toBe('running');
});

it('stops the clocks while the agent waits for a permission answer', async () => {
  await startWorker({ expectedMinutes: 10 });
  await advance(5);
  turns[0]!.plan.onPermission?.(true);
  await advance(100);
  expect(watchdogEvents()).toEqual([]);
});

it('resumes the deadline with the remaining time after the permission answer', async () => {
  await startWorker({ expectedMinutes: 10 });
  await advance(5);
  turns[0]!.plan.onPermission?.(true);
  await advance(100);
  turns[0]!.plan.onPermission?.(false);
  await advance(9);
  expect(watchdogEvents()).toEqual([]);
  await advance(1);
  expect(watchdogEvents()).toMatchObject([{ reason: 'deadline' }]);
});

it('keeps no clocks while a worker waits for the PM to answer', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  await engine.call('ask_pm', { message: 'which file?' }, id);
  turns[0]!.finish();
  await until(() => works()[0]!.status === 'awaiting_pm');
  await advance(1000);
  expect(watchdogEvents()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start the clocks of a queued worker', async () => {
  store.updateTask(task.id, {
    pm: {
      ...task.pm!,
      dispatchPolicy: { strategy: 'costFirst', maxWorkers: 1, maxExtraTokenRatio: 0.2 },
    },
  });
  pmActions[0] = async () => {
    await engine.call('dispatch', { ...input, expectedMinutes: 10 });
    await engine.call('dispatch', { ...input, expectedMinutes: 10 });
    await engine.call('wait', {});
  };
  running = engine.run();
  await until(() => turns.length === 1);
  // Either worker may win the single slot; the other stays queued.
  const executing = works().find((w) => w.status === 'running')!.id;
  await advance(100);
  expect(watchdogEvents()).toMatchObject([{ workId: executing }]);
});

it('clears the timers when the worker completes', async () => {
  await startWorker({ expectedMinutes: 10 });
  turns[0]!.finish();
  await until(() => works()[0]!.status === 'completed');
  await until(() => vi.getTimerCount() === 0);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the timers when the PM cancels the worker', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  pmActions[1] = async () => {
    await engine.call('cancel_work', { id });
  };
  engine.notify();
  await until(() => works()[0]!.status === 'cancelled');
  await advance(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the timers when the task stops', async () => {
  await startWorker({ expectedMinutes: 10 });
  controller.abort();
  await running;
  expect(vi.getTimerCount()).toBe(0);
});

it('never cancels a worker on its own, however late it is', async () => {
  await startWorker({ expectedMinutes: 1 });
  await advance(1000);
  expect(works()[0]!.status).toBe('running');
});

it('re-arms after a restart from the recorded remaining time', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  await advance(6);
  controller.abort();
  await running;
  expect(works()[0]).toMatchObject({
    status: 'stopped',
    runMs: 6 * MIN,
    deadlineRemainingMs: 9 * MIN,
  });
  controller = new AbortController();
  engine = new PmWorkflow(host, task, controller.signal);
  pmActions[pmRuns] = async () => {
    await engine.call('continue_work', { id, message: 'resume' });
  };
  running = engine.run();
  await until(() => turns.length === 2);
  await advance(8);
  expect(watchdogEvents()).toEqual([]);
  await advance(1);
  expect(watchdogEvents()).toMatchObject([{ reason: 'deadline' }]);
});

it('does not replay a deadline that was already reported before the restart', async () => {
  const id = await startWorker({ expectedMinutes: 10 });
  await advance(20);
  expect(watchdogEvents()).toHaveLength(1);
  controller.abort();
  await running;
  controller = new AbortController();
  engine = new PmWorkflow(host, task, controller.signal);
  pmActions[pmRuns] = async () => {
    await engine.call('continue_work', { id, message: 'resume' });
  };
  running = engine.run();
  await until(() => turns.length === 2);
  await advance(1000);
  expect(watchdogEvents()).toHaveLength(1);
});
