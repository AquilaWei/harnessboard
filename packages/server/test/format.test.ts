// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createEventFormatter, formatFeature } from '../src/format.js';

describe('createEventFormatter', () => {
  it('shows a context line when the whole percentage changes', () => {
    const format = createEventFormatter(100_000);
    format('context', { tokens: 12_000 });
    expect(format('context', { tokens: 13_500 })).toBe('  · context 13%');
  });

  it('hides context updates within the same percentage', () => {
    const format = createEventFormatter(100_000);
    format('context', { tokens: 12_000 });
    expect(format('context', { tokens: 12_900 })).toBeNull();
  });

  it('prefixes tool calls with the tool name', () => {
    const format = createEventFormatter(100_000);
    expect(format('tool_use', { name: 'Bash', summary: 'npm test' })).toBe('  ▸ Bash: npm test');
  });
});

describe('formatFeature', () => {
  it('marks a passing feature with a check', () => {
    expect(formatFeature({ id: 'F1', description: 'add', passes: true })).toBe('  ✓ F1  add');
  });

  it('marks an open feature with a dot', () => {
    expect(formatFeature({ id: 'F2', description: 'sub', passes: false })).toBe('  · F2  sub');
  });
});
