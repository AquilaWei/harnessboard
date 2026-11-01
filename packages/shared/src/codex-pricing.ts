// SPDX-License-Identifier: Apache-2.0
import type { TokenCounts } from './usage.js';

import prices from './codex-prices.json' with { type: 'json' };

/** One model's USD per million tokens. */
export interface CodexPrice {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

/** The price data file; `hb pricing refresh` rewrites it. */
export interface CodexPriceTable {
  /** Date (YYYY-MM-DD) the prices were last checked against the official pages. */
  checked: string;
  prices: Record<string, CodexPrice>;
}

// USD per million tokens: input, cached input, cache writes, output.
// Standard short-context prices, kept in codex-prices.json and checked against:
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/<model-id>
// Models before GPT-5.6 have no separate cache-write rate; writes use the input rate.
export const CODEX_PRICE_TABLE: Readonly<CodexPriceTable> = prices;

/**
 * Estimates USD from disjoint token counts at standard short-context API prices.
 * Returns null for unknown models or invalid counts; never guesses a model's price.
 * Output includes reasoning tokens. Long-context, speed and tool surcharges are excluded.
 */
export function estimateCodexCost(model: string, tokens: TokenCounts): number | null {
  if (!Object.hasOwn(CODEX_PRICE_TABLE.prices, model)) return null;
  const price = CODEX_PRICE_TABLE.prices[model]!;
  const counts = [tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output];
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) return null;
  const rates = [price.input, price.cachedInput, price.cacheWrite, price.output];
  return counts.reduce((sum, count, index) => sum + count * rates[index]!, 0) / 1_000_000;
}
