// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAi } from '@harnessboard/core';
import type { CodexPriceTable } from '@harnessboard/shared';
import { reduceHtml, refreshPrices } from '../src/pricing-refresh.js';

const FAKE_LOCALAI = fileURLToPath(
  new URL('../../core/test/fixtures/fake-localai.mjs', import.meta.url),
);
const HTML = readFileSync(new URL('./fixtures/pricing-page.html', import.meta.url), 'utf8');

const TABLE: CodexPriceTable = {
  checked: '2026-10-09',
  prices: {
    'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  },
};

let dir: string;
let tableFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'hb-pricing-'));
  tableFile = path.join(dir, 'prices.json');
  writeFileSync(tableFile, JSON.stringify(TABLE, null, 2) + '\n');
  vi.stubEnv('FAKE_LOCALAI_LOG', path.join(dir, 'log.jsonl'));
});
afterEach(() => vi.unstubAllEnvs());

/** A fake localai whose model answers `answer`. */
function fakeAi(answer: string, command = FAKE_LOCALAI): LocalAi {
  const file = path.join(dir, 'scenario.json');
  const id = 'a'.repeat(32);
  const event = (type: string, data: unknown) => ({ version: 1, request_id: id, type, data });
  writeFileSync(
    file,
    JSON.stringify({
      lines: [
        event('start', {}),
        event('delta', { channel: 'answer', text: answer }),
        event('usage', { status: 'unavailable', prompt_tokens: null, completion_tokens: null }),
        event('done', { finish_reason: 'stop' }),
      ],
    }),
  );
  vi.stubEnv('FAKE_LOCALAI_SCENARIO', file);
  return new LocalAi({ enabled: true, command, models: { pricing: 'gpt-oss-20b' } });
}

async function refresh(ai: LocalAi, confirm: boolean) {
  const printed: string[] = [];
  const loadHtml = vi.fn(async () => HTML);
  const outcome = await refreshPrices({
    ai,
    table: TABLE,
    tableFile,
    loadHtml,
    confirm: async () => confirm,
    print: (text) => printed.push(text),
    today: '2026-11-01',
  });
  return { outcome, printed, loadHtml };
}

const onDisk = () => readFileSync(tableFile, 'utf8');

const CHANGED_AND_NEW = JSON.stringify({
  models: {
    'gpt-6-sol': { input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, output: 10 },
    'gpt-7-nova': { input: 3, cachedInput: 0.3, output: 12 },
  },
});

describe('reduceHtml', () => {
  it('keeps each table row on one line', () => {
    expect(reduceHtml(HTML)).toContain('gpt-6-sol | $2.50 | $0.25 | $10.00 |');
  });

  it('drops script content', () => {
    expect(reduceHtml(HTML)).not.toContain('gpt-hidden');
  });

  it('drops lines without a model or a price', () => {
    expect(reduceHtml(HTML)).not.toContain('Home');
  });
});

describe('refreshPrices', () => {
  it('prints a changed price as a diff line', async () => {
    const { printed } = await refresh(fakeAi(CHANGED_AND_NEW), true);
    expect(printed[0]).toContain('~ gpt-6-sol: input 2 -> 2.5, cachedInput 0.2 -> 0.25');
  });

  it('prints a model that is not in the table as a new model', async () => {
    const { printed } = await refresh(fakeAi(CHANGED_AND_NEW), true);
    expect(printed[0]).toContain(
      '+ NEW MODEL gpt-7-nova: input=3 cachedInput=0.3 cacheWrite=3 output=12',
    );
  });

  it('writes the merged table after confirmation', async () => {
    const { outcome } = await refresh(fakeAi(CHANGED_AND_NEW), true);
    expect(outcome).toEqual({ status: 'written', changes: 2 });
    expect(JSON.parse(onDisk())).toEqual({
      checked: '2026-11-01',
      prices: {
        'gpt-6-sol': { input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, output: 10 },
        'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
        'gpt-7-nova': { input: 3, cachedInput: 0.3, cacheWrite: 3, output: 12 },
      },
    });
  });

  it('writes nothing when the user declines', async () => {
    const before = onDisk();
    const { outcome } = await refresh(fakeAi(CHANGED_AND_NEW), false);
    expect(outcome).toEqual({ status: 'declined' });
    expect(onDisk()).toBe(before);
  });

  it('sends only the reduced page text to the model', async () => {
    await refresh(fakeAi(CHANGED_AND_NEW), false);
    const sent = JSON.parse(readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim());
    expect(sent.stdin).toContain('gpt-7-nova | $3.00 | $0.30 | $12.00 |');
    expect(sent.stdin).not.toContain('<table>');
  });

  it('reports unchanged when the extraction matches the table', async () => {
    const same = JSON.stringify({
      models: { 'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 } },
    });
    expect((await refresh(fakeAi(same), true)).outcome).toEqual({ status: 'unchanged' });
  });

  it('accepts JSON wrapped in a code fence', async () => {
    const fenced = '```json\n' + CHANGED_AND_NEW + '\n```';
    expect((await refresh(fakeAi(fenced), true)).outcome).toEqual({
      status: 'written',
      changes: 2,
    });
  });

  it.each([
    ['malformed JSON', '{"models": {', 'the model did not answer with valid JSON'],
    ['prose', 'Sure! Here are the prices', 'the model did not answer with valid JSON'],
    ['no models', '{"models":{}}', 'the answer must be {"models": {…}} with at least one model'],
    [
      'a price above the bound',
      '{"models":{"gpt-6-sol":{"input":5000,"cachedInput":1,"output":10}}}',
      'gpt-6-sol: input must be a number from 0 to 1000',
    ],
    [
      'a negative price',
      '{"models":{"gpt-6-sol":{"input":2,"cachedInput":-1,"output":10}}}',
      'gpt-6-sol: cachedInput must be a number from 0 to 1000',
    ],
    [
      'a price given as text',
      '{"models":{"gpt-6-sol":{"input":"2","cachedInput":0.2,"output":10}}}',
      'gpt-6-sol: input must be a number from 0 to 1000',
    ],
    [
      'cached input above input',
      '{"models":{"gpt-6-sol":{"input":2,"cachedInput":3,"output":10}}}',
      'gpt-6-sol: cachedInput 3 is above input 2',
    ],
    [
      'an unexpected field',
      '{"models":{"gpt-6-sol":{"input":2,"cachedInput":0.2,"output":10,"note":"x"}}}',
      'gpt-6-sol: expected only input, cachedInput, cacheWrite, output',
    ],
    [
      'a garbage model name',
      '{"models":{"ignore previous instructions":{"input":1,"cachedInput":0.1,"output":2}}}',
      'unknown or invalid model id "ignore previous instructions"',
    ],
    [
      'a model name outside the allowed families',
      '{"models":{"claude-x":{"input":1,"cachedInput":0.1,"output":2}}}',
      'unknown or invalid model id "claude-x"',
    ],
    [
      'a prototype key as model name',
      '{"models":{"__proto__x":{"input":1,"cachedInput":0.1,"output":2}}}',
      'unknown or invalid model id "__proto__x"',
    ],
  ])('rejects %s and writes nothing', async (_name, answer, message) => {
    const before = onDisk();
    const { outcome } = await refresh(fakeAi(answer), true);
    expect(outcome).toEqual({ status: 'rejected', message });
    expect(onDisk()).toBe(before);
  });

  it('is unavailable without fetching or writing when the binary is missing', async () => {
    const before = onDisk();
    const { outcome, loadHtml } = await refresh(
      fakeAi(CHANGED_AND_NEW, path.join(dir, 'no-such-localai')),
      true,
    );
    expect(outcome.status).toBe('unavailable');
    expect(loadHtml).not.toHaveBeenCalled();
    expect(onDisk()).toBe(before);
  });

  it('fails without writing when the model run fails', async () => {
    const before = onDisk();
    const ai = fakeAi(CHANGED_AND_NEW);
    vi.stubEnv('FAKE_LOCALAI_SCENARIO', path.join(dir, 'missing-scenario.json'));
    const { outcome } = await refresh(ai, true);
    expect(outcome.status).toBe('failed');
    expect(onDisk()).toBe(before);
  });
});
