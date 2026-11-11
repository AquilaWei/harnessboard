// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PRICING_PROVIDERS, estimateCodexCost } from '@harnessboard/shared';
import type {
  CodexPrice,
  PricingPreview,
  PricingProvider,
  TokenCounts,
  RunUsage,
} from '@harnessboard/shared';
import type { LocalAiService } from './localai.js';
import { userConfigFile } from './config.js';
import {
  buildPrompt,
  diffPrices,
  formatDiff,
  parseExtraction,
  reduceHtml,
} from './pricing-extraction.js';

interface PriceFile {
  providers: Partial<Record<PricingProvider, Record<string, CodexPrice>>>;
  attempts: Partial<Record<PricingProvider, number>>;
}

/** File loading lives in core; shared estimators remain pure. Failed refreshes never affect estimation. */
export class PricingService {
  private data: PriceFile;
  private readonly controller = new AbortController();
  private readonly jobs = new Set<Promise<void>>();
  constructor(
    private readonly ai: LocalAiService,
    readonly file = path.join(path.dirname(userConfigFile()), 'prices.json'),
    private readonly loadPage = async (url: string) => {
      const response = await fetch(url, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error(`pricing page answered HTTP ${response.status}`);
      return response.text();
    },
    private readonly now = Date.now,
  ) {
    this.data = this.read();
  }

  /** Overrides are validated before being merged over bundled rates. */
  table(provider: PricingProvider): Record<string, CodexPrice> {
    return { ...PRICING_PROVIDERS[provider].bundled, ...this.data.providers[provider] };
  }

  /** Returns immediately; a missing price schedules at most one persisted daily attempt. */
  estimate(
    provider: PricingProvider,
    model: string,
    tokens: TokenCounts,
    event: (message: string) => void = () => {},
  ): number | null {
    const table = this.table(provider);
    if (!Object.hasOwn(table, model)) this.schedule(provider, event);
    return estimateCodexCost(model, tokens, table);
  }

  /** Reported Claude costs win; Codex costs are estimates and use the latest merged rates. */
  modelCost(
    model: string,
    tokens: TokenCounts,
    reported: number | null,
    event?: (message: string) => void,
  ): number | null {
    const provider = (Object.keys(PRICING_PROVIDERS) as PricingProvider[]).find((key) =>
      PRICING_PROVIDERS[key].modelId.test(model),
    );
    if (!provider) return reported;
    if (provider === 'claude' && reported !== null) return reported;
    return this.estimate(provider, model, tokens, event);
  }

  /** Reprices Codex transport estimates before persistence; reported Claude totals are preserved. */
  usage(usage: RunUsage, provider: string, event: (message: string) => void): RunUsage {
    if (provider === 'claude-code' && usage.costUsd !== null) return usage;
    const models = Object.fromEntries(
      Object.entries(usage.models).map(([model, tokens]) => [
        model,
        {
          ...tokens,
          costUsd: this.modelCost(model, tokens, tokens.costUsd, event),
        },
      ]),
    );
    if (provider !== 'codex') return usage; // Keep Claude's absent costs distinguishable from reported costs.
    const costs = Object.values(models).flatMap((model) =>
      model.costUsd === null ? [] : [model.costUsd],
    );
    return { models, costUsd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null };
  }

  private schedule(provider: PricingProvider, event: (message: string) => void): void {
    if (this.controller.signal.aborted || this.ai.unavailableReason()) return;
    const now = this.now();
    const last = this.data.attempts[provider];
    if (last !== undefined && now - last < 86_400_000) return;
    this.data.attempts[provider] = now; // Reserve before awaiting, including failed attempts.
    try {
      this.save();
    } catch {
      return;
    } // No durable reservation means no automatic attempt.
    const job = this.preview(provider)
      .then((preview) => {
        this.apply(preview);
        event(`Refreshed ${provider} prices from the official pricing page`);
      })
      .catch((error: unknown) => {
        if (this.controller.signal.aborted) return;
        event(
          `Could not refresh ${provider} prices: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }

  /** Waits for background jobs on shutdown and in deterministic tests. */
  async waitForIdle(): Promise<void> {
    await Promise.all(this.jobs);
  }

  /** Aborts optional background work before its event sink (the store) closes. */
  async close(): Promise<void> {
    this.controller.abort();
    await this.waitForIdle();
  }

  /** Server-only preview: callers cannot supply prompts, pages or extracted rates. */
  async preview(provider: PricingProvider): Promise<PricingPreview> {
    const unavailable = this.ai.unavailableReason();
    if (unavailable) throw new Error(unavailable);
    const pages = await Promise.all(
      PRICING_PROVIDERS[provider].urls.map((url) => this.loadPage(url)),
    );
    const text = reduceHtml(pages.join('\n'));
    if (!text) throw new Error('the page has no price text');
    const result = await this.ai.request('pricing', buildPrompt(text, provider), {
      timeoutMs: 300_000,
      signal: this.controller.signal,
    });
    if (result.status !== 'ok') throw new Error(result.reason);
    const prices = parseExtraction(result.answer, this.table(provider), provider);
    return { provider, prices, diff: formatDiff(diffPrices(this.table(provider), prices)) };
  }

  /** Only validated preview data is written; preserves the other providers and throttle metadata. */
  apply(preview: PricingPreview): void {
    const prices = parseExtraction(
      JSON.stringify({ models: preview.prices }),
      {},
      preview.provider,
    );
    this.data = this.read();
    this.data.providers[preview.provider] = { ...this.data.providers[preview.provider], ...prices };
    this.save();
  }

  private read(): PriceFile {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as PriceFile;
      const providers: PriceFile['providers'] = {};
      for (const provider of Object.keys(PRICING_PROVIDERS) as PricingProvider[]) {
        const entries = value.providers?.[provider];
        if (entries && Object.keys(entries).length)
          providers[provider] = parseExtraction(JSON.stringify({ models: entries }), {}, provider);
      }
      return { providers, attempts: value.attempts ?? {} };
    } catch {
      return { providers: {}, attempts: {} };
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
