// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hb commands', () => {
  it('registers each command name once, since commander refuses a repeat when hb starts', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const names = [...source.matchAll(/^\s*\.command\('([\w-]+)'\)/gm)].map((m) => m[1]);
    const repeated = names.filter((name, i) => names.indexOf(name) !== i);
    expect(repeated).toEqual([]);
  });
});
