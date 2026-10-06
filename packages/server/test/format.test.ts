// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { SpecChangeProposal } from '@harnessboard/shared';
import { createEventFormatter, formatFeature, formatSpecChange } from '../src/format.js';

// The CLI picks its language from the environment when i18n is first imported.
vi.hoisted(() => {
  process.env.HARNESSBOARD_LANG = 'en';
});

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

describe('formatSpecChange', () => {
  const change: SpecChangeProposal = {
    from: 'user',
    reason: 'Say hello too',
    previous: '- prints hi',
    criteria: '- prints hi\n- prints hello',
    reply: '',
    onReject: 'queued',
    sessionId: null,
    requestId: 4,
  };

  it('shows the current criteria above the proposed ones, with the commands that decide', () => {
    expect(formatSpecChange(3, change)).toBe(
      [
        'Proposed change to the spec you asked for: Say hello too',
        '  current criteria:',
        '    - prints hi',
        '  proposed criteria:',
        '    - prints hi',
        '    - prints hello',
        'Approve with `hb approve 3` (`--criteria "..."` to approve your own), reply with `hb feedback 3 "..."`, or keep the spec with `hb reject 3`.',
      ].join('\n'),
    );
  });

  it('names the implementer as the one asking when it proposed the change', () => {
    const line = formatSpecChange(3, { ...change, from: 'implementer', reason: 'API differs' });
    expect(line.split('\n')[0]).toBe('The implementer proposes a change to the spec: API differs');
  });

  it('tells how to write the criteria when the reply had none', () => {
    expect(formatSpecChange(3, { ...change, criteria: null }).split('\n')[3]).toBe(
      '  proposed criteria: none in the reply; write them with `hb approve 3 --criteria "..."`',
    );
  });
});
