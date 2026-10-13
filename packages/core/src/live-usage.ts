// SPDX-License-Identifier: Apache-2.0
import type { RunUsage } from '@harnessboard/shared';

const COUNTS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/** Keeps partial message usage available when a process is stopped before its result. */
export class LiveUsage {
  private readonly calls = new Map<string, RunUsage>();
  private current: RunUsage | null;

  constructor(initial: RunUsage | null = null) {
    this.current = initial ? structuredClone(initial) : null;
  }

  snapshot(usage: RunUsage): void {
    this.current = usage;
  }

  call(id: string, usage: RunUsage): void {
    const previous = this.calls.get(id);
    const models = structuredClone(this.current?.models ?? {});
    for (const [model, counts] of Object.entries(usage.models)) {
      const before = previous?.models[model];
      const total = models[model] ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: null,
      };
      for (const key of COUNTS) total[key] += Math.max(0, counts[key] - (before?.[key] ?? 0));
      total.costUsd = null; // Partial token readings do not include a reported price.
      models[model] = total;
    }
    // Preserve each field's high-water mark if repeated message blocks report less usage.
    const maxima = structuredClone(usage);
    for (const [model, before] of Object.entries(previous?.models ?? {})) {
      const next = maxima.models[model];
      if (next) for (const key of COUNTS) next[key] = Math.max(next[key], before[key]);
      else maxima.models[model] = before;
    }
    this.calls.set(id, maxima);
    this.current = { models, costUsd: null };
  }

  get usage(): RunUsage | null {
    return this.current;
  }
}
