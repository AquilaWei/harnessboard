// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import type { LocalAi } from '@harnessboard/core';
import type { CodexPrice, CodexPriceTable } from '@harnessboard/shared';

/** The page `hb pricing refresh` reads; the same one codex-pricing.ts cites. */
export const PRICING_URL = 'https://developers.openai.com/api/docs/pricing';

/** Model ids the refresh may add: GPT or Codex families. Known ids are always accepted. */
const MODEL_ID = /^(gpt-\d[a-z0-9.]*|codex-[a-z0-9.]+)(-[a-z0-9.]+)*$/;
const MAX_MODEL_ID_LENGTH = 40;
/** USD per million tokens; far above any real price, so only garbage exceeds it. */
const MAX_PRICE = 1000;
/** Keeps the prompt short: Vulkan prompt processing is only 100–200 tok/s. */
const MAX_TEXT_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

const FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output'] as const;

/** Thrown when the model's output cannot be trusted; nothing is written. */
export class PricingRejectedError extends Error {}

/** Reduces a pricing page to table-shaped text lines that mention a model or a price. */
export function reduceHtml(html: string): string {
  // Source line breaks mean nothing in HTML; only block-closing tags start a new line.
  const text = html
    .replace(/\s+/g, ' ')
    .replace(/<(script|style|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(tr|p|div|li|h[1-6]|table|section)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&#39;/g, "'");
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => /gpt-|codex|\$\s?\d/i.test(line));
  return lines.join('\n').slice(0, MAX_TEXT_CHARS);
}

/** The instruction sent to the model; the answer must be JSON only. */
export function buildPrompt(text: string): string {
  return [
    'Extract the standard short-context API prices in USD per 1M tokens for GPT and Codex models',
    'from the pricing text below. Answer with JSON only, no prose, in exactly this shape:',
    '{"models":{"<model-id>":{"input":0,"cachedInput":0,"cacheWrite":0,"output":0}}}',
    'Use the exact model id. Leave out "cacheWrite" when the page lists no cache-write price.',
    'Leave out any model whose prices you cannot read; never guess a number.',
    '',
    text,
  ].join('\n');
}

/**
 * Validates the model's answer against the strict shape and returns the extracted prices
 * (cache writes default to the input rate, as for models without a separate rate).
 * Throws `PricingRejectedError` for non-JSON, extra keys, bad numbers or unknown model ids.
 */
export function parseExtraction(
  answer: string,
  known: Readonly<Record<string, CodexPrice>>,
): Record<string, CodexPrice> {
  const json = answer
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new PricingRejectedError('the model did not answer with valid JSON');
  }
  const models = isRecord(value) && Object.keys(value).join() === 'models' ? value.models : null;
  if (!isRecord(models) || Object.keys(models).length === 0) {
    throw new PricingRejectedError('the answer must be {"models": {…}} with at least one model');
  }
  const prices: Record<string, CodexPrice> = {};
  for (const [id, entry] of Object.entries(models)) {
    const isKnown = Object.hasOwn(known, id);
    if (!isKnown && !(id.length <= MAX_MODEL_ID_LENGTH && MODEL_ID.test(id))) {
      throw new PricingRejectedError(`unknown or invalid model id ${JSON.stringify(id)}`);
    }
    prices[id] = parseEntry(id, entry);
  }
  return prices;
}

function parseEntry(id: string, entry: unknown): CodexPrice {
  const allowed = new Set<string>(FIELDS);
  if (!isRecord(entry) || Object.keys(entry).some((key) => !allowed.has(key))) {
    throw new PricingRejectedError(`${id}: expected only ${FIELDS.join(', ')}`);
  }
  const num = (key: (typeof FIELDS)[number], value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
      throw new PricingRejectedError(`${id}: ${key} must be a number from 0 to ${MAX_PRICE}`);
    }
    return value;
  };
  const input = num('input', entry.input);
  const cachedInput = num('cachedInput', entry.cachedInput);
  const output = num('output', entry.output);
  const cacheWrite = entry.cacheWrite === undefined ? input : num('cacheWrite', entry.cacheWrite);
  if (cachedInput > input) {
    throw new PricingRejectedError(`${id}: cachedInput ${cachedInput} is above input ${input}`);
  }
  return { input, cachedInput, cacheWrite, output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PriceChange {
  model: string;
  kind: 'added' | 'changed';
  before: CodexPrice | null;
  after: CodexPrice;
}

/** Models that are new or whose price differs; models missing from `next` are not changes. */
export function diffPrices(
  current: Readonly<Record<string, CodexPrice>>,
  next: Readonly<Record<string, CodexPrice>>,
): PriceChange[] {
  const changes: PriceChange[] = [];
  for (const [model, after] of Object.entries(next)) {
    const before = Object.hasOwn(current, model) ? current[model]! : null;
    if (before === null) changes.push({ model, kind: 'added', before, after });
    else if (FIELDS.some((field) => before[field] !== after[field])) {
      changes.push({ model, kind: 'changed', before, after });
    }
  }
  return changes;
}

/** Human-readable diff; additions are marked `NEW MODEL` so they cannot be missed. */
export function formatDiff(changes: PriceChange[]): string {
  return changes
    .map(({ model, kind, before, after }) => {
      const rates = (p: CodexPrice) => FIELDS.map((f) => `${f}=${p[f]}`).join(' ');
      if (kind === 'added') return `+ NEW MODEL ${model}: ${rates(after)}`;
      const moved = FIELDS.filter((f) => before![f] !== after[f]).map(
        (f) => `${f} ${before![f]} -> ${after[f]}`,
      );
      return `~ ${model}: ${moved.join(', ')}`;
    })
    .join('\n');
}

export type RefreshOutcome =
  | { status: 'unavailable' | 'failed' | 'rejected'; message: string }
  | { status: 'unchanged' | 'declined' }
  | { status: 'written'; changes: number };

export interface RefreshOptions {
  ai: LocalAi;
  /** The table on disk; it is read as the current prices and rewritten on confirmation. */
  table: CodexPriceTable;
  tableFile: string;
  /** Loads the pricing page; only called once local AI is known to be available. */
  loadHtml: () => Promise<string>;
  /** Asked once, with the diff already printed; `--yes` passes `async () => true`. */
  confirm: () => Promise<boolean>;
  print: (text: string) => void;
  /** YYYY-MM-DD stored as the table's `checked` date. */
  today: string;
}

/**
 * Extracts prices from the pricing page with local AI and, after the user confirms the
 * printed diff, rewrites the table file. Nothing is written for any outcome but `written`.
 * Models absent from the extraction keep their current prices.
 */
export async function refreshPrices(options: RefreshOptions): Promise<RefreshOutcome> {
  const { ai, table, print } = options;
  const unavailable = ai.unavailableReason();
  if (unavailable) return { status: 'unavailable', message: unavailable };
  const text = reduceHtml(await options.loadHtml());
  if (text === '') return { status: 'rejected', message: 'the page has no price text' };
  const result = await ai.run('pricing', {
    prompt: buildPrompt(text),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (result.status !== 'ok') {
    return { status: result.status, message: result.reason };
  }
  let extracted: Record<string, CodexPrice>;
  try {
    extracted = parseExtraction(result.answer, table.prices);
  } catch (err) {
    if (err instanceof PricingRejectedError) return { status: 'rejected', message: err.message };
    throw err;
  }
  const changes = diffPrices(table.prices, extracted);
  if (changes.length === 0) return { status: 'unchanged' };
  print(formatDiff(changes));
  if (!(await options.confirm())) return { status: 'declined' };
  const next: CodexPriceTable = {
    checked: options.today,
    prices: { ...table.prices, ...extracted },
  };
  writeFileSync(options.tableFile, JSON.stringify(next, null, 2) + '\n');
  return { status: 'written', changes: changes.length };
}
