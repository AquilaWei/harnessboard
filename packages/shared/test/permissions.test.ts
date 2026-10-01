// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { assertToolRules, isToolRule, presetRules } from '../src/permissions.js';

describe('isToolRule', () => {
  it('accepts a bare tool name', () => {
    expect(isToolRule('WebSearch')).toBe(true);
  });

  it('accepts a tool with a specifier', () => {
    expect(isToolRule('Bash(git add *)')).toBe(true);
  });

  it('accepts an MCP tool name', () => {
    expect(isToolRule('mcp__my-server__search')).toBe(true);
  });

  it('rejects a sentence', () => {
    expect(isToolRule('基本上都可以，在不重要的情況下都予以執行。')).toBe(false);
  });

  it('rejects a command without a tool name', () => {
    expect(isToolRule('npm test')).toBe(false);
  });

  it('rejects an empty specifier', () => {
    expect(isToolRule('Bash()')).toBe(false);
  });
});

describe('presetRules', () => {
  it('lists the rules of each preset in order', () => {
    expect(presetRules(['gradle', 'web'])).toEqual([
      'Bash(./gradlew *)',
      'Bash(gradle *)',
      'WebFetch',
      'WebSearch',
    ]);
  });

  it('rejects an unknown preset and names the valid ones', () => {
    expect(() => presetRules(['rust'])).toThrow(/unknown permission preset "rust".*git, node/);
  });
});

describe('assertToolRules', () => {
  it('quotes the rules that are not tool rules', () => {
    expect(() => assertToolRules(['Bash(npm test)', 'run anything'])).toThrow(
      /not a tool rule: "run anything"/,
    );
  });
});
