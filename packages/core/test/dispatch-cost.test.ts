// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import type { PmWork } from '@harnessboard/shared';
import type { Store } from '../src/store.js';
import { dispatchCost } from '../src/dispatch-cost.js';

it('counts cumulative resumes by difference and retains failed attempt consumption', () => {
  const records: { sessionId: string; data: unknown }[] = [];
  const store = { eventsOfKind: () => records } as unknown as Store;
  const snapshot = (input: number) => ({
    role: 'worker',
    agentId: 'claude',
    durationMs: 1,
    usage: {
      costUsd: null,
      models: { model: { input, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null } },
    },
  });
  // Usage samples need no live CLI or billable model call.
  records.push({ sessionId: 'thread', data: snapshot(100) });
  records.push({ sessionId: 'thread', data: snapshot(150) });
  records.push({ sessionId: 'retry', data: snapshot(50) });
  const work = {
    agentId: 'claude',
    model: null,
    status: 'failed',
    sessionIds: ['thread', 'retry'],
  } as PmWork;
  expect(dispatchCost(store, 1, [work], 'claude', null)).toEqual({
    averageTokens: 200,
    sampleCount: 1,
    confidence: 'insufficient',
  });
});
