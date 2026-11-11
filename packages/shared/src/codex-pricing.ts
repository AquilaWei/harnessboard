// SPDX-License-Identifier: Apache-2.0
import type { TokenCounts } from './usage.js';

import prices from './codex-prices.json' with { type: 'json' };
import claudePrices from './claude-prices.json' with { type: 'json' };

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
// Standard short-context prices, kept in codex-prices.json, checked 2026-10-09 against:
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/<model-id>
// gpt-6.1-terra checked 2026-11-01.
// Cache writes use the 30-minute rate (the 12-hour rate is higher), as in the other gpt-6.x entries.
// Models before GPT-5.6 have no separate cache-write rate; writes use the input rate.
export const CODEX_PRICE_TABLE: Readonly<CodexPriceTable> = prices;

/**
 * Estimates USD from disjoint token counts at standard short-context API prices.
 * Returns null for unknown models or invalid counts; never guesses a model's price.
 * Output includes reasoning tokens. Long-context, speed and tool surcharges are excluded.
 */
export function estimateCodexCost(
  model: string,
  tokens: TokenCounts,
  table: Readonly<Record<string, CodexPrice>> = CODEX_PRICE_TABLE.prices,
): number | null {
  if (!Object.hasOwn(table, model)) return null;
  const price = table[model]!;
  const counts = [tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output];
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) return null;
  const rates = [price.input, price.cachedInput, price.cacheWrite, price.output];
  return counts.reduce((sum, count, index) => sum + count * rates[index]!, 0) / 1_000_000;
}

/** Provider definitions are the only registry needed to support a new pricing source. */
export const PRICING_PROVIDERS = {
  codex: {
    urls: ['https://developers.openai.com/api/docs/pricing'],
    modelId: /^(gpt-\d[a-z0-9.]*|codex-[a-z0-9.]+)(-[a-z0-9.]+)*$/,
    promptHint: 'Use exact GPT and Codex model IDs.',
    bundled: CODEX_PRICE_TABLE.prices,
  },
  claude: {
    urls: ['https://platform.claude.com/docs/en/about-claude/pricing'],
    modelId: /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/,
    promptHint: 'Use exact Claude API model IDs (claude-...). Use 5-minute cache-write rates.',
    bundled: claudePrices.prices as Record<string, CodexPrice>,
  },
} as const;

export type PricingProvider = keyof typeof PRICING_PROVIDERS;
export interface PricingPreview {
  provider: PricingProvider;
  prices: Record<string, CodexPrice>;
  diff: string;
}
