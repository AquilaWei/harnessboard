// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';

// i18n.ts sets the page language when it loads; tests run without a page.
vi.hoisted(() => vi.stubGlobal('document', { documentElement: {} }));

const { en, zhTW } = await import('../src/i18n');

/** Every string's dotted key, e.g. `phone.title`, sorted. */
const keyPaths = (strings: object, prefix = ''): string[] =>
  Object.entries(strings)
    .flatMap(([key, value]) =>
      typeof value === 'object' && value !== null
        ? keyPaths(value as object, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    )
    .sort();

describe('translations', () => {
  it('uses the configured planner in approval descriptions in both languages', () => {
    expect(en.describe.planReady).toContain('{{agent}}');
    expect(en.describe.planReadyQuestions).toContain('{{agent}}');
    expect(zhTW.describe.planReady).toContain('{{agent}}');
    expect(zhTW.describe.planReadyQuestions).toContain('{{agent}}');
  });

  it('have the same keys in English and zh-TW', () => {
    expect(keyPaths(zhTW)).toEqual(keyPaths(en));
  });

  it('give the More menu an English label', () => {
    expect(en.actions.more).toBe('More');
  });

  it('give the More menu a zh-TW label', () => {
    expect(zhTW.actions.more).toBe('更多');
  });

  it('give the board layout hidden-count hint an English wording', () => {
    expect(en.boardLayout.moreHidden).toBe('+{{count}} more');
  });

  it('give the board layout hidden-count hint a zh-TW wording', () => {
    expect(zhTW.boardLayout.moreHidden).toBe('另有 {{count}} 個');
  });
});
