// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Read from disk: Vitest replaces imported CSS, `?raw` included, with an empty string.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

// A media query adds no specificity, so a base rule written after it wins over it.
describe('styles.css', () => {
  it('puts the phone rules after the folder browser base rules so the full-screen browser applies', () => {
    const phone = css.lastIndexOf('@media (max-width: 640px)');
    expect(phone).toBeGreaterThan(css.indexOf('\n.folder-browser {'));
    expect(phone).toBeGreaterThan(css.indexOf('\n.folder-list {'));
  });
});
