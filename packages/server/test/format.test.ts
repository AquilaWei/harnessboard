// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo, SpecChangeProposal } from '@harnessboard/shared';
import {
  createEventFormatter,
  formatFeature,
  formatModel,
  formatSpecChange,
  formatTaskAgents,
} from '../src/format.js';

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

  it('shows the explanation in the reply below the request, before the criteria', () => {
    const reply = 'Added a line for hello.\nThe old check still holds.';
    expect(formatSpecChange(3, { ...change, reply })).toBe(
      [
        'Proposed change to the spec you asked for: Say hello too',
        '  reply:',
        '    Added a line for hello.',
        '    The old check still holds.',
        '  current criteria:',
        '    - prints hi',
        '  proposed criteria:',
        '    - prints hi',
        '    - prints hello',
        'Approve with `hb approve 3` (`--criteria "..."` to approve your own), reply with `hb feedback 3 "..."`, or keep the spec with `hb reject 3`.',
      ].join('\n'),
    );
  });

  it("shows the spec author's questions when the reply had no criteria", () => {
    const reply = 'Should hello replace hi, or print after it?';
    expect(formatSpecChange(3, { ...change, criteria: null, reply })).toBe(
      [
        'Proposed change to the spec you asked for: Say hello too',
        '  reply:',
        '    Should hello replace hi, or print after it?',
        '  current criteria:',
        '    - prints hi',
        '  proposed criteria: none in the reply; write them with `hb approve 3 --criteria "..."`',
        'Approve with `hb approve 3` (`--criteria "..."` to approve your own), reply with `hb feedback 3 "..."`, or keep the spec with `hb reject 3`.',
      ].join('\n'),
    );
  });
});

describe('formatTaskAgents', () => {
  it('shows each role effort after its model', () => {
    expect(
      formatTaskAgents({
        implementer: 'claude',
        implementerModel: 'opus',
        implementerEffort: 'high',
        reviewer: 'codex',
        reviewerModel: 'gpt-5.5',
        reviewerEffort: 'low',
        maxReviewRounds: 3,
      }),
    ).toEqual([
      'spec         (the implementer)',
      'designer     -  ',
      'implementer  claude  opus  high',
      'tester       -  ',
      'reviewer     codex  gpt-5.5  low',
    ]);
  });

  it('shows the default-effort label for a role without an effort', () => {
    expect(formatTaskAgents({ implementer: 'claude', reviewer: null, maxReviewRounds: 3 })[2]).toBe(
      'implementer  claude  (default)  (default effort)',
    );
  });

  it('shows the spec author effort when the spec has its own author', () => {
    expect(
      formatTaskAgents({
        implementer: 'claude',
        reviewer: null,
        spec: 'codex',
        specEffort: 'xhigh',
        maxReviewRounds: 3,
      })[0],
    ).toBe('spec         codex  (default)  xhigh');
  });
});

describe('formatModel', () => {
  const opus: ModelInfo = {
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    description: 'Most capable',
    note: null,
    more: false,
    efforts: [
      { id: 'low', name: 'Low', description: null, note: null },
      { id: 'medium', name: 'Medium', description: null, note: 'Recommended' },
      { id: 'high', name: 'High', description: null, note: null },
      { id: 'xhigh', name: 'Extra', description: null, note: null },
      { id: 'max', name: 'Max', description: null, note: null },
    ],
    defaultEffort: null,
  };

  it('lists the effort ids under a model that offers efforts', () => {
    expect(formatModel(opus)).toEqual([
      'claude-opus-5-5              Opus 5.5       Most capable',
      '  efforts: low, medium, high, xhigh, max',
    ]);
  });

  it('prints only the model line for a model without efforts', () => {
    expect(formatModel({ ...opus, efforts: [] })).toEqual([
      'claude-opus-5-5              Opus 5.5       Most capable',
    ]);
  });

  it('names the default effort when the CLI gives one', () => {
    expect(
      formatModel({
        ...opus,
        efforts: [
          { id: 'low', name: 'low', description: null, note: null },
          { id: 'medium', name: 'medium', description: null, note: null },
        ],
        defaultEffort: 'medium',
      })[1],
    ).toBe('  efforts: low, medium (default medium)');
  });
});
