// SPDX-License-Identifier: Apache-2.0
import type { RunUsage, SafetyPause, TokenSpikePolicy } from '@harnessboard/shared';

/** Counts reported consumption, independently of the model's current context size. */
export function usageTokens(usage: RunUsage | null): number {
  return Object.values(usage?.models ?? {}).reduce(
    (sum, model) => sum + model.input + model.output + model.cacheRead + model.cacheWrite,
    0,
  );
}

/** Reconciles per-message readings with the conversation's final cumulative report. */
export class RunTokenCounter {
  private readonly calls = new Map<string, number>();
  private observed = 0;
  private previous: number;
  private sinceSnapshot = 0;

  constructor(private baseline: number) {
    this.previous = baseline;
  }

  call(id: string, tokens: number): number {
    const before = this.calls.get(id) ?? 0;
    const delta = Math.max(0, tokens - before);
    this.calls.set(id, Math.max(before, tokens));
    this.observed += delta;
    this.sinceSnapshot += delta;
    return delta;
  }

  snapshot(tokens: number): number {
    // Providers sometimes reset their cumulative counters after compaction.
    if (tokens < this.previous) {
      this.baseline = 0;
      this.observed = this.sinceSnapshot;
    }
    this.previous = tokens;
    const delta = Math.max(0, tokens - this.baseline - this.observed);
    this.observed += delta;
    this.sinceSnapshot = 0;
    return delta;
  }
}

/** A bounded sliding window per task; explicit resume discards only its recent samples. */
export class TokenWatch {
  private readonly samples = new Map<number, { at: number; tokens: number }[]>();

  clear(taskId: number): void {
    this.samples.delete(taskId);
  }

  check(
    taskId: number,
    tokens: number,
    policy: TokenSpikePolicy,
    source: string,
    now = Date.now(),
  ): SafetyPause | null {
    if (!policy.enabled) {
      this.clear(taskId);
      return null;
    }
    if (!Number.isFinite(tokens) || tokens <= 0) return null;
    const recent = (this.samples.get(taskId) ?? []).filter(
      (sample) => sample.at > now - policy.windowSeconds * 1_000,
    );
    recent.push({ at: now, tokens });
    this.samples.set(taskId, recent);
    const observedTokens = recent.reduce((sum, sample) => sum + sample.tokens, 0);
    return observedTokens > policy.maxTokens
      ? {
          triggeredAt: now,
          windowSeconds: policy.windowSeconds,
          observedTokens,
          maxTokens: policy.maxTokens,
          source,
        }
      : null;
  }
}
