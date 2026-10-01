// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseRules } from '../src/rules';

describe('parseRules', () => {
  it('reads one rule per line, skipping blank lines and duplicates', () => {
    expect(parseRules('Bash(npm *)\n\n  WebSearch \nBash(npm *)')).toEqual({
      rules: ['Bash(npm *)', 'WebSearch'],
      invalid: [],
    });
  });

  it('lists lines that are not tool rules', () => {
    expect(parseRules('Bash(npm *)\nanything goes locally')).toEqual({
      rules: ['Bash(npm *)'],
      invalid: ['anything goes locally'],
    });
  });
});
