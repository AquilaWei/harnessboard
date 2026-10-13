// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { RunTokenCounter, TokenWatch, usageTokens } from '../src/token-watch.js';

const policy = { enabled: true, windowSeconds: 60, maxTokens: 100_000 };

describe('token spike window', () => {
  it('allows consumption below the limit', () => {
    expect(new TokenWatch().check(1, 99_999, policy, 'claude-code', 0)).toBeNull();
  });

  it('allows consumption exactly at the limit', () => {
    expect(new TokenWatch().check(1, 100_000, policy, 'claude-code', 0)).toBeNull();
  });

  it('records evidence when consumption exceeds the limit', () => {
    const watch = new TokenWatch();
    watch.check(1, 60_000, policy, 'claude-code', 1_000);
    expect(watch.check(1, 40_001, policy, 'codex', 60_999)).toEqual({
      triggeredAt: 60_999,
      windowSeconds: 60,
      observedTokens: 100_001,
      maxTokens: 100_000,
      source: 'codex',
    });
  });

  it('expires consumption at the window boundary', () => {
    const watch = new TokenWatch();
    watch.check(1, 60_000, policy, 'claude-code', 1_000);
    expect(watch.check(1, 60_000, policy, 'claude-code', 61_000)).toBeNull();
  });

  it('keeps different tasks independent', () => {
    const watch = new TokenWatch();
    watch.check(1, 60_000, policy, 'claude-code', 0);
    expect(watch.check(2, 60_000, policy, 'claude-code', 0)).toBeNull();
  });

  it('discards recent consumption on explicit resume', () => {
    const watch = new TokenWatch();
    watch.check(1, 90_000, policy, 'claude-code', 0);
    watch.clear(1);
    expect(watch.check(1, 90_000, policy, 'claude-code', 1)).toBeNull();
  });

  it('does not pause while disabled', () => {
    expect(
      new TokenWatch().check(1, 200_000, { ...policy, enabled: false }, 'gemini', 0),
    ).toBeNull();
  });

  it('uses a changed threshold on the next reading', () => {
    const watch = new TokenWatch();
    watch.check(1, 60_000, policy, 'codex', 0);
    expect(watch.check(1, 1, { ...policy, maxTokens: 50_000 }, 'codex', 1)?.observedTokens).toBe(
      60_001,
    );
  });
});

describe('reported token increments', () => {
  it('counts all four token categories', () => {
    expect(
      usageTokens({
        costUsd: null,
        models: {
          model: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            costUsd: null,
          },
        },
      }),
    ).toBe(10);
  });

  it('does not count a repeated message twice', () => {
    const run = new RunTokenCounter(0);
    expect(run.call('message', 60_000)).toBe(60_000);
    expect(run.call('message', 60_000)).toBe(0);
  });

  it('counts only additional tokens in later message blocks', () => {
    const run = new RunTokenCounter(0);
    run.call('message', 60_000);
    expect(run.call('message', 60_010)).toBe(10);
  });

  it('reconciles final totals with already streamed consumption', () => {
    const run = new RunTokenCounter(50_000);
    run.call('message', 60_000);
    expect(run.snapshot(110_010)).toBe(10);
    expect(run.snapshot(110_010)).toBe(0);
  });

  it('subtracts prior conversation consumption on resume', () => {
    expect(new RunTokenCounter(500_000).snapshot(500_010)).toBe(10);
  });

  it('counts a reset cumulative counter as fresh consumption', () => {
    const run = new RunTokenCounter(500_000);
    expect(run.snapshot(10)).toBe(10);
    expect(run.snapshot(20)).toBe(10);
  });

  it('reconciles streamed calls when a resumed conversation resets its total', () => {
    const run = new RunTokenCounter(500_000);
    run.call('message', 60_000);
    expect(run.snapshot(60_010)).toBe(10);
  });
});
