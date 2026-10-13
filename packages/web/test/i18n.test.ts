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
});
