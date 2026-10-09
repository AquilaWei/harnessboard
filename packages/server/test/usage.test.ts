// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@harnessboard/core';
import { taskUsage } from '../src/views.js';

const newTask = {
  title: 't',
  prompt: 'do it',
  repoPath: '/repo',
  baseRef: 'main',
  workspace: 'worktree' as const,
  mode: 'single' as const,
  verifyCommand: null,
  acceptance: null,
  confirmPlan: false,
  agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
  contextPolicy: { size: 'small' as const },
  permission: { allowedTools: [], skipPermissions: false },
};

/** One run's record: the conversation's totals on one model. */
const run = (durationMs: number, input: number, output: number, costUsd: number) => ({
  role: 'implementer',
  agentId: 'claude',
  durationMs,
  usage: {
    costUsd,
    models: { haiku: { input, output, cacheRead: 0, cacheWrite: 0, costUsd } },
  },
});

let store: Store;
let id: number;

beforeEach(() => {
  store = new Store(':memory:');
  id = store.createTask(newTask).id;
  store.startSession('s1', id, 'implementer', 'claude', 's1', 1_000);
  store.startSession('s2', id, 'reviewer', 'claude', 's2', 5_000);
  store.endSession('s2', 'completed', 9_000);
});

afterEach(() => store.close());

const usage = () => taskUsage(id, store, store.listSessions(id), false);

describe('taskUsage', () => {
  it('adds per-run reports when a provider resumes the same conversation', () => {
    store.appendEvent(id, 's1', 'usage', { ...run(100, 10, 40, 0.02), cumulative: false });
    store.appendEvent(id, 's1', 'usage', { ...run(200, 25, 90, 0.05), cumulative: false });
    expect([usage().tokens, usage().costUsd]).toEqual([
      { input: 35, output: 130, cacheRead: 0, cacheWrite: 0 },
      0.07,
    ]);
  });
  it('adds up the sessions', () => {
    store.appendEvent(id, 's1', 'usage', run(100, 10, 40, 0.02));
    store.appendEvent(id, 's2', 'usage', run(200, 5, 20, 0.01));
    expect([usage().tokens, usage().costUsd]).toEqual([
      { input: 15, output: 60, cacheRead: 0, cacheWrite: 0 },
      0.03,
    ]);
  });

  it("counts a session's later report instead of adding it to the earlier", () => {
    store.appendEvent(id, 's1', 'usage', run(100, 10, 40, 0.02));
    store.appendEvent(id, 's1', 'usage', run(100, 25, 90, 0.05));
    expect([usage().tokens, usage().costUsd]).toEqual([
      { input: 25, output: 90, cacheRead: 0, cacheWrite: 0 },
      0.05,
    ]);
  });

  it('adds a report lower than the one before on top of it', () => {
    store.appendEvent(id, 's1', 'usage', run(100, 10, 40, 0.02));
    store.appendEvent(id, 's1', 'usage', run(100, 3, 7, 0.01));
    expect([usage().tokens, usage().costUsd]).toEqual([
      { input: 13, output: 47, cacheRead: 0, cacheWrite: 0 },
      0.03,
    ]);
  });

  it('adds up the runs and their time', () => {
    store.appendEvent(id, 's1', 'usage', run(100, 10, 40, 0.02));
    store.appendEvent(id, 's1', 'usage', { ...run(250, 0, 0, 0), usage: null });
    expect([usage().runs, usage().agentMs]).toEqual([2, 350]);
  });

  it('measures elapsed time from the first start to the last end', () => {
    expect(usage().elapsedMs).toBe(8_000);
  });

  it('has no tokens or cost for a task without usage records', () => {
    expect([usage().tokens, usage().costUsd]).toEqual([null, null]);
  });

  it('estimates historical model usage without rewriting the stored record', () => {
    const record = {
      ...run(100, 0, 0, 0),
      agentId: 'codex',
      usage: {
        costUsd: null,
        models: {
          'gpt-6.1-sol': {
            input: 1000000,
            output: 100000,
            cacheRead: 200000,
            cacheWrite: 0,
            costUsd: null,
          },
        },
      },
    };
    store.appendEvent(id, 's1', 'usage', record);
    expect(usage().costUsd).toBeCloseTo(3.02);
    expect(usage().byModel['gpt-6.1-sol']?.costUsd).toBeCloseTo(3.02);
    expect(store.eventsOfKind(id, 'usage')[0]?.data).toEqual(record);
  });

  it('preserves a recorded model cost even when its current price differs', () => {
    store.appendEvent(id, 's1', 'usage', {
      ...run(100, 0, 0, 0),
      usage: {
        costUsd: 7,
        models: {
          'gpt-6.1-sol': {
            input: 1000000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: 7,
          },
        },
      },
    });
    expect(usage().costUsd).toBe(7);
  });

  it('leaves historical generic Codex usage unpriced', () => {
    store.appendEvent(id, 's1', 'usage', {
      ...run(100, 0, 0, 0),
      usage: {
        costUsd: null,
        models: {
          codex: {
            input: 1000000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: null,
          },
        },
      },
    });
    expect(usage().costUsd).toBeNull();
  });

  it('prices only the latest cumulative historical report', () => {
    store.appendEvent(id, 's1', 'usage', {
      ...run(100, 0, 0, 0),
      usage: {
        costUsd: null,
        models: {
          'gpt-6.1-sol': {
            input: 1000000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: null,
          },
        },
      },
    });
    store.appendEvent(id, 's1', 'usage', {
      ...run(100, 0, 0, 0),
      usage: {
        costUsd: null,
        models: {
          'gpt-6.1-sol': {
            input: 2000000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: null,
          },
        },
      },
    });
    expect(usage().costUsd).toBe(4);
  });

  it('banks historical cost when cumulative tokens reset', () => {
    store.appendEvent(id, 's1', 'usage', {
      ...run(100, 0, 0, 0),
      usage: {
        costUsd: null,
        models: {
          'gpt-6.1-sol': {
            input: 2000000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: null,
          },
        },
      },
    });
    store.appendEvent(id, 's1', 'usage', {
      ...run(100, 0, 0, 0),
      usage: {
        costUsd: null,
        models: {
          'gpt-6.1-sol': {
            input: 1000000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: null,
          },
        },
      },
    });
    expect(usage().costUsd).toBe(6);
  });

  it('combines recorded and estimated model costs while keeping unknown models unpriced', () => {
    store.appendEvent(id, 's1', 'usage', run(100, 10, 40, 0.02));
    store.appendEvent(id, 's2', 'usage', {
      ...run(100, 0, 0, 0),
      usage: {
        costUsd: null,
        models: {
          'gpt-6.1-sol': { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
          codex: { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
        },
      },
    });
    expect(usage().costUsd).toBeCloseTo(2.02);
    expect(usage().byModel.codex?.costUsd).toBeNull();
  });
});
