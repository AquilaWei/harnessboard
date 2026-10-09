// SPDX-License-Identifier: Apache-2.0
import type { TokenCounts } from './usage.js';

// USD per million tokens: input, cached input, cache writes, output.
// Standard short-context prices, checked 2026-10-09 against:
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/<model-id>
// Models before GPT-5.6 have no separate cache-write rate; writes use the input rate.
const PRICES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  'gpt-6.1-sol': [2, 0.1, 2.5, 10],
  'gpt-6-sol': [2, 0.2, 2.5, 10],
  'gpt-6-astra': [10, 1, 12.5, 50],
  'gpt-6-luna': [0.1, 0.01, 0.125, 0.5],
  'gpt-5.6-sol': [4, 0.4, 5, 20],
  'gpt-5.6-terra': [2, 0.2, 2.5, 12],
  'gpt-5.6-luna': [0.2, 0.02, 0.25, 1.2],
  'gpt-5.5': [5, 0.5, 5, 30],
  'gpt-5.3-codex': [1.75, 0.175, 1.75, 14],
  'gpt-5.2-codex': [1.75, 0.175, 1.75, 14],
  'gpt-5.1-codex': [1.25, 0.125, 1.25, 10],
  'gpt-5-codex': [1.25, 0.125, 1.25, 10],
  'codex-mini-latest': [1.5, 0.375, 1.5, 6],
};

/**
 * Estimates USD from disjoint token counts at standard short-context API prices.
 * Returns null for unknown models or invalid counts; never guesses a model's price.
 * Output includes reasoning tokens. Long-context, speed and tool surcharges are excluded.
 */
export function estimateCodexCost(model: string, tokens: TokenCounts): number | null {
  if (!Object.hasOwn(PRICES, model)) return null;
  const price = PRICES[model]!;
  const counts = [tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output];
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) return null;
  return counts.reduce((sum, count, index) => sum + count * price[index]!, 0) / 1_000_000;
}
