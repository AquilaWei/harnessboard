// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { estimateCodexCost } from '../src/codex-pricing.js';

describe('estimateCodexCost', () => {
  it.each([
    ['gpt-6.1-sol', 14.6],
    ['gpt-6-sol', 14.7],
    ['gpt-6-astra', 73.5],
    ['gpt-6-luna', 0.735],
    ['gpt-5.6-sol', 29.4],
    ['gpt-5.6-terra', 16.7],
    ['gpt-5.6-luna', 1.67],
    ['gpt-5.5', 40.5],
    ['gpt-5.3-codex', 17.675],
    ['gpt-5.2-codex', 17.675],
    ['gpt-5.1-codex', 12.625],
    ['gpt-5-codex', 12.625],
    ['codex-mini-latest', 9.375],
  ])('uses verified standard rates for %s', (model, expected) => {
    expect(
      estimateCodexCost(model, {
        input: 1000000,
        output: 1000000,
        cacheRead: 1000000,
        cacheWrite: 1000000,
      }),
    ).toBeCloseTo(expected);
  });

  it('returns zero for a known model with no usage', () => {
    expect(
      estimateCodexCost('gpt-6.1-sol', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(0);
  });

  it.each(['codex', 'unknown-model', 'gpt-reserve', 'toString', '__proto__'])(
    'leaves %s unpriced',
    (model) => {
      expect(
        estimateCodexCost(model, {
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ).toBeNull();
    },
  );

  it.each([-1, NaN, Infinity])('rejects invalid token counts: %s', (input) => {
    expect(
      estimateCodexCost('gpt-6.1-sol', {
        input,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeNull();
  });
});
