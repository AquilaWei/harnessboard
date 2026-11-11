// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalAiService } from '../src/localai.js';
import { PricingService } from '../src/pricing.js';
import { tempDir } from './helpers.js';

let dir: string;
const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
const rate = { input: 7, cachedInput: 1, cacheWrite: 7, output: 10 };
const binary = fileURLToPath(new URL('./fixtures/fake-localai.mjs', import.meta.url));
let ai: LocalAiService;
let page: ReturnType<typeof vi.fn<(url: string) => Promise<string>>>;
beforeEach(() => {
  dir = tempDir('pricing');
  const scenario = path.join(dir, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      lines: [
        { type: 'start', data: {} },
        {
          type: 'delta',
          data: { channel: 'answer', text: JSON.stringify({ models: { 'gpt-99-test': rate } }) },
        },
        { type: 'usage', data: {} },
        { type: 'done', data: {} },
      ],
    }),
  );
  vi.stubEnv('FAKE_LOCALAI_SCENARIO', scenario);
  ai = new LocalAiService({
    enabled: true,
    command: binary,
    models: { pricing: 'gpt-oss-20b', slug: 'mellum2.1', commit: 'lfm2.5' },
  });
  page = vi.fn(async () => '<p>gpt-99-test $7</p>');
});
afterEach(() => vi.unstubAllEnvs());
const file = () => path.join(dir, 'prices.json');

it('merges user overrides over bundled rates', () => {
  writeFileSync(
    file(),
    JSON.stringify({ providers: { codex: { 'gpt-6.1-sol': rate } }, attempts: {} }),
  );
  const service = new PricingService(ai, file(), page);
  expect(service.estimate('codex', 'gpt-6.1-sol', tokens)).toBe(7);
  expect(service.table('codex')['gpt-6.1-terra']).toBeDefined();
});

it('returns unknown immediately and schedules exactly one refresh for concurrent estimates', async () => {
  const event = vi.fn();
  const service = new PricingService(ai, file(), page);
  expect(service.estimate('codex', 'gpt-99-test', tokens, event)).toBeNull();
  expect(service.estimate('codex', 'gpt-99-other', tokens, event)).toBeNull();
  await service.waitForIdle();
  expect(page).toHaveBeenCalledTimes(1);
  expect(event).toHaveBeenCalledWith('Refreshed codex prices from the official pricing page');
  expect(service.estimate('codex', 'gpt-99-test', tokens)).toBe(7);
});

it('persists the attempt throttle across restart and retries after 24 hours', async () => {
  let now = 1_000;
  const service = new PricingService(ai, file(), page, () => now);
  service.estimate('codex', 'gpt-99-other', tokens);
  await service.waitForIdle();
  const restarted = new PricingService(ai, file(), page, () => now);
  now = 86_400_999;
  restarted.estimate('codex', 'gpt-99-other', tokens);
  await restarted.waitForIdle();
  expect(page).toHaveBeenCalledTimes(1);
  now = 86_401_000;
  restarted.estimate('codex', 'gpt-99-other', tokens);
  await restarted.waitForIdle();
  expect(page).toHaveBeenCalledTimes(2);
});

it('preserves prices on validation rejection and still throttles the failed attempt', async () => {
  vi.spyOn(ai, 'request').mockResolvedValue({
    status: 'ok',
    answer: '{"models":{"gpt-99-test":{"input":1,"cachedInput":2,"output":3}}}',
    reasoning: '',
  });
  const service = new PricingService(ai, file(), page);
  service.estimate('codex', 'gpt-99-test', tokens);
  await service.waitForIdle();
  expect(JSON.parse(readFileSync(file(), 'utf8')).providers).toEqual({});
  service.estimate('codex', 'gpt-99-test', tokens);
  expect(page).toHaveBeenCalledTimes(1);
});

it('does nothing when local AI is disabled', async () => {
  const disabled = new LocalAiService({
    enabled: false,
    command: binary,
    models: { pricing: 'a', slug: 'b', commit: 'c' },
  });
  const service = new PricingService(disabled, file(), page);
  expect(service.estimate('codex', 'gpt-99-test', tokens)).toBeNull();
  await service.waitForIdle();
  expect(page).not.toHaveBeenCalled();
  expect(existsSync(file())).toBe(false);
});

it('keeps reported Claude costs without triggering a refresh', () => {
  const service = new PricingService(ai, file(), page);
  expect(service.modelCost('claude-unknown-model', tokens, 12)).toBe(12);
  expect(page).not.toHaveBeenCalled();
});

it('estimates Claude tokens using its own provider table', () => {
  const service = new PricingService(ai, file(), page);
  expect(service.modelCost('claude-sonnet-4-6', tokens, null)).toBe(3);
});

it('validates Claude model IDs instead of accepting another provider', async () => {
  const service = new PricingService(ai, file(), page);
  await expect(service.preview('claude')).rejects.toThrow('unknown or invalid model id');
  expect(existsSync(file())).toBe(false);
});

it('refreshes a missing Claude model only when no reported cost is available', async () => {
  vi.spyOn(ai, 'request').mockResolvedValue({
    status: 'ok',
    answer: JSON.stringify({ models: { 'claude-future': rate } }),
    reasoning: '',
  });
  const service = new PricingService(ai, file(), page);
  expect(service.modelCost('claude-future', tokens, null)).toBeNull();
  await service.waitForIdle();
  expect(page).toHaveBeenCalledWith('https://platform.claude.com/docs/en/about-claude/pricing');
  expect(service.modelCost('claude-future', tokens, null)).toBe(7);
});

it('replaces transport Codex estimates with user override rates', () => {
  writeFileSync(
    file(),
    JSON.stringify({ providers: { codex: { 'gpt-6.1-sol': rate } }, attempts: {} }),
  );
  const service = new PricingService(ai, file(), page);
  expect(
    service.usage(
      { costUsd: 2, models: { 'gpt-6.1-sol': { ...tokens, costUsd: 2 } } },
      'codex',
      vi.fn(),
    ).costUsd,
  ).toBe(7);
});
