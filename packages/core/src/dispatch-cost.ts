// SPDX-License-Identifier: Apache-2.0
import type { PmWork, UsageRecord } from '@harnessboard/shared';
import type { Store } from './store.js';
import { usageTokens } from './token-watch.js';

/** Task-local, model-specific samples include retries and count resumed totals only once. */
export function dispatchCost(
  store: Store,
  taskId: number,
  works: PmWork[],
  agentId: string,
  model: string | null,
) {
  const usage = store.eventsOfKind(taskId, 'usage');
  const samples = works
    .filter(
      (w) =>
        w.agentId === agentId &&
        w.model === model &&
        ['completed', 'failed', 'stopped'].includes(w.status),
    )
    .map((work) => {
      const sessions = new Set([
        ...(work.sessionIds ?? []),
        ...(work.sessionId ? [work.sessionId] : []),
      ]);
      const previous = new Map<string, number>();
      let total = 0;
      let recorded = false;
      for (const event of usage) {
        if (!event.sessionId || !sessions.has(event.sessionId)) continue;
        const record = event.data as UsageRecord;
        if (!record.usage) continue;
        recorded = true;
        const tokens = usageTokens(record.usage);
        const before = previous.get(event.sessionId) ?? 0;
        total += record.cumulative === false ? tokens : tokens < before ? tokens : tokens - before;
        if (record.cumulative !== false) previous.set(event.sessionId, tokens);
      }
      return recorded ? total : null;
    })
    .filter((n): n is number => n !== null)
    .slice(-20);
  return {
    averageTokens: samples.length
      ? samples.reduce((sum, value) => sum + value, 0) / samples.length
      : null,
    sampleCount: samples.length,
    confidence: samples.length < 5 ? 'insufficient' : 'taskHistory',
  };
}
