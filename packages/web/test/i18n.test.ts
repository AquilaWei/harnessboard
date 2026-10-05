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
  it('have the same keys in English and zh-TW', () => {
    expect(keyPaths(zhTW)).toEqual(keyPaths(en));
  });
});
