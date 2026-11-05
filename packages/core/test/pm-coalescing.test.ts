// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Task } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { PmWorkflow, pmWork } from '../src/pm.js';
import { Secretary } from '../src/pm-secretary.js';
import type { PmHost, PmSessionPlan } from '../src/pm.js';
import type { SessionOutcome } from '../src/runner.js';
import { Store } from '../src/store.js';
import { DISPATCH_PLAN, makeRepo, tempDir } from './helpers.js';

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
let running: Promise<void>;
let ids: string[];
/** Worker turns, with the way to end each. Workers start concurrently, so find by session. */
let turns: { sessionId: string; finish: () => void; fail: () => void }[];
/** Prompt of every secretary batch and PM turn, in order. */
let batches: string[];
let pmPrompts: string[];
let pmActions: (() => Promise<void>)[];
/** One call per coordination pass that consults the secretary; see `pass`. */
let consulted: ReturnType<typeof vi.spyOn>;

function build(): void {
  engine = new PmWorkflow(host, task, controller.signal);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  store = new Store(':memory:');
  controller = new AbortController();
  const repo = makeRepo();
  task = store.createTask({
    title: 'Coalescing',
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
      dispatchPolicy: { strategy: 'costFirst', maxWorkers: 6, maxExtraTokenRatio: 0.2 },
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
  ids = [];
  turns = [];
  batches = [];
  pmPrompts = [];
  pmActions = [];
  host = {
    store,
    config: {
      ...defaultConfig({}),
      dataDir: tempDir('pm-coalescing'),
      // The watchdog has its own tests; keep its clocks out of these.
      pmWatchdog: { ...defaultConfig({}).pmWatchdog, idleMinutes: 10_000, defaultMinutes: 10_000 },
    },
    run: vi.fn(async (_task, plan: PmSessionPlan, sessionId, signal) => {
      if (plan.role === 'pm') {
        pmPrompts.push(plan.prompt);
        await pmActions[pmPrompts.length - 1]?.();
        return completed;
      }
      if (plan.role === 'secretary') {
        batches.push(plan.prompt);
        return completed;
      }
      return new Promise<SessionOutcome>((resolve) => {
        turns.push({
          sessionId,
          finish: () => resolve(completed),
          fail: () => resolve({ ...completed, reason: 'error', detail: 'boom' }),
        });
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
  build();
  consulted = vi.spyOn(Secretary.prototype, 'pending');
});

afterEach(async () => {
  consulted.mockRestore();
  controller.abort();
  await running?.catch(() => undefined);
  store.close();
  vi.useRealTimers();
});

async function until(condition: () => boolean): Promise<void> {
  // performance.now is not faked; git runs in real child processes.
  const limit = performance.now() + 8000;
  while (!condition() && performance.now() < limit) await new Promise((r) => setImmediate(r));
  expect(condition()).toBe(true);
}
const updates = () => store.eventsOfKind(task.id, 'pm_worker_update');
/**
 * Runs one more coordination pass and waits for it to consult the secretary. Use it before
 * asserting that nothing happened: the pass sees every event stored so far.
 */
async function pass(): Promise<void> {
  engine.notify('state');
  const seen = consulted.mock.calls.length;
  await until(() => consulted.mock.calls.length > seen);
}
async function advanceSeconds(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}
/** The first PM turn dispatches `count` read-only workers and waits. */
async function startWorkers(count: number, agentId = 'claude'): Promise<void> {
  pmActions[0] = async () => {
    for (let i = 0; i < count; i++) {
      const work = (await engine.call('dispatch', { ...input, agentId })) as { workId: string };
      ids.push(work.workId);
    }
    await engine.call('wait', {});
  };
  running = engine.run();
  await until(() => turns.length === count);
}
/** Ends a worker and waits until its result event is stored. */
async function deliver(index: number, how: 'finish' | 'fail' = 'finish'): Promise<void> {
  const before = updates().length;
  const sessionId = pmWork(store, task.id).find((w) => w.id === ids[index])!.sessionId;
  turns.find((t) => t.sessionId === sessionId)![how]();
  await until(() => updates().length === before + 1);
}
/** Worker ids a prompt mentions, in the order they first appear. */
const mentioned = (prompt: string): string[] =>
  ids.filter((id) => prompt.includes(id)).sort((a, b) => prompt.indexOf(a) - prompt.indexOf(b));
/** The mock secretary escalates, so a finished batch is followed by one PM turn. */
async function batchDone(): Promise<void> {
  await until(() => pmPrompts.length === batches.length + 1);
}
function stopTask(): Promise<void> {
  controller.abort();
  return running;
}
function restart(): void {
  controller = new AbortController();
  build();
  running = engine.run();
}

it('starts a secretary batch at once when only one worker runs', async () => {
  await startWorkers(1);
  await deliver(0);
  await until(() => batches.length === 1);
});

it('holds the first delivery while three workers run', async () => {
  await startWorkers(3);
  await deliver(0);
  await pass();
  expect(batches).toHaveLength(0);
});

it('starts one batch with both results once the events reach the number of running workers', async () => {
  await startWorkers(4);
  await deliver(0);
  await deliver(1);
  await until(() => batches.length === 1);
  expect(mentioned(batches[0]!)).toEqual([ids[0], ids[1]]);
});

it('starts a batch when the oldest event has waited 20 seconds', async () => {
  await startWorkers(3);
  await deliver(0);
  await pass();
  await advanceSeconds(19);
  await pass();
  expect(batches).toHaveLength(0);
  await advanceSeconds(1);
  await until(() => batches.length === 1);
  expect(mentioned(batches[0]!)).toEqual([ids[0]]);
});

it('measures the 20 seconds from the first held event, not from a later one', async () => {
  await startWorkers(5);
  await deliver(0);
  await advanceSeconds(15);
  await deliver(1);
  await pass();
  expect(batches).toHaveLength(0);
  await advanceSeconds(5);
  await until(() => batches.length === 1);
  expect(mentioned(batches[0]!)).toEqual([ids[0], ids[1]]);
});

it('starts the batch at once when a worker fails', async () => {
  await startWorkers(3);
  await deliver(0, 'fail');
  await until(() => batches.length === 1);
});

it('takes the earlier held results along when a worker fails', async () => {
  await startWorkers(5);
  await deliver(0);
  await deliver(1, 'fail');
  await until(() => batches.length === 1);
  expect(mentioned(batches[0]!)).toEqual([ids[0], ids[1]]);
});

it('starts the batch at once when fewer than two workers remain running', async () => {
  await startWorkers(3);
  await deliver(0);
  await deliver(1);
  await until(() => batches.length === 1);
  expect(mentioned(batches[0]!)).toEqual([ids[0], ids[1]]);
});

it('starts a batch at once for the delivery of the last running worker', async () => {
  await startWorkers(3);
  await deliver(0);
  await deliver(1);
  await until(() => batches.length === 1);
  await batchDone();
  await deliver(2);
  await until(() => batches.length === 2);
  expect(mentioned(batches[1]!)).toEqual([ids[2]]);
});

it('gives the PM the held worker results when a user message flushes at once', async () => {
  await startWorkers(3);
  await deliver(0);
  await pass();
  engine.notify();
  await until(() => pmPrompts.length === 2);
  expect(pmPrompts[1]).toContain('workerResultsNotYetReviewedBySecretary');
  expect(pmPrompts[1]).toContain(ids[0]);
});

it('does not start a stale batch for events a user-message PM turn already showed', async () => {
  await startWorkers(3);
  await deliver(0);
  await pass();
  engine.notify();
  await until(() => pmPrompts.length === 2);
  await advanceSeconds(60);
  await pass();
  expect(batches).toHaveLength(0);
});

it('turns grouping off with a delay of 0', async () => {
  host.config = { ...host.config, pmCoalescing: { maxDelaySeconds: 0, thresholdCap: 3 } };
  build();
  await startWorkers(3);
  await deliver(0);
  await until(() => batches.length === 1);
});

it('batches each result once and in arrival order', async () => {
  await startWorkers(4);
  await deliver(0);
  await deliver(1);
  await until(() => batches.length === 1);
  await batchDone();
  await deliver(2);
  await until(() => batches.length === 2);
  await batchDone();
  await deliver(3);
  await until(() => batches.length === 3);
  expect(batches.map(mentioned)).toEqual([[ids[0], ids[1]], [ids[2]], [ids[3]]]);
});

it('keeps no timer after the task stops with results held', async () => {
  await startWorkers(3);
  await deliver(0);
  await pass();
  await stopTask();
  expect(vi.getTimerCount()).toBe(0);
});

it('presents results that were held when the process restarted to the first PM turn', async () => {
  await startWorkers(3);
  await deliver(0);
  await pass();
  await stopTask();
  restart();
  await until(() => pmPrompts.length === 2);
  expect(pmPrompts[1]).toContain('workerResultsNotYetReviewedBySecretary');
  expect(pmPrompts[1]).toContain(ids[0]);
});

it('does not start a batch for held results that the restarted PM turn already showed', async () => {
  await startWorkers(3);
  await deliver(0);
  await pass();
  await stopTask();
  restart();
  await until(() => pmPrompts.length === 2);
  await advanceSeconds(120);
  await pass();
  expect(batches).toHaveLength(0);
});

it('wakes the PM for every result at once while the secretary has failed', async () => {
  store.appendEvent(task.id, null, 'pm_secretary', {
    id: 's',
    parentSessionId: 'p',
    agentId: 'claude',
    model: null,
    effort: null,
    status: 'failed',
    sessionIds: [],
    summary: 'down',
    updatedAt: 1,
  });
  await startWorkers(3);
  await deliver(0);
  await until(() => pmPrompts.length === 2);
  expect(batches).toHaveLength(0);
});

it('wakes the PM for every result at once when no secretary can be appointed', async () => {
  host.config = {
    ...host.config,
    agents: { ...host.config.agents, gem: { provider: 'gemini', command: 'gemini', model: null } },
  };
  store.updateTask(task.id, {
    pm: { ...task.pm!, workers: [{ agentId: 'gem', models: [null] }] },
  });
  build();
  await startWorkers(3, 'gem');
  await deliver(0);
  await until(() => pmPrompts.length === 2);
  expect(batches).toHaveLength(0);
});
