// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseCriteria, taskGoal } from '../src/prompts.js';
import { reviewPrompt } from '../src/review.js';

describe('parseCriteria', () => {
  it('takes the lines under the criteria heading up to the next heading', () => {
    const reply =
      'Read the repo.\n## Acceptance criteria\n- prints hi\n- exits 0\n## Questions\n- Colour?';
    expect(parseCriteria(reply)).toBe('- prints hi\n- exits 0');
  });

  it('keeps sub-headings inside the section', () => {
    const reply = '## Acceptance criteria\n### CLI\n- prints hi';
    expect(parseCriteria(reply)).toBe('### CLI\n- prints hi');
  });

  it('leaves out a closing remark after the list', () => {
    const reply = '## Acceptance criteria\n- prints hi\n\nReady to build when you approve.';
    expect(parseCriteria(reply)).toBe('- prints hi');
  });

  it('keeps a criteria section that is only prose', () => {
    expect(parseCriteria('## Acceptance criteria\nIt prints hi.')).toBe('It prints hi.');
  });

  it('accepts the heading in another case', () => {
    expect(parseCriteria('## acceptance Criteria\n- prints hi')).toBe('- prints hi');
  });

  it('returns null without the heading', () => {
    expect(parseCriteria('- prints hi')).toBeNull();
  });

  it('returns null for an empty section', () => {
    expect(parseCriteria('## Acceptance criteria\n\n## Questions\n- Colour?')).toBeNull();
  });
});

describe('taskGoal', () => {
  it('is the prompt alone without criteria', () => {
    expect(taskGoal('Add a greeting', null)).toBe('Add a greeting');
  });

  it('adds the agreed criteria after the prompt', () => {
    expect(taskGoal('Add a greeting', '- prints hi')).toBe(
      'Add a greeting\n\nAcceptance criteria, agreed with the user (the work is done when all of them hold):\n- prints hi',
    );
  });
});

describe('reviewPrompt', () => {
  const request = { round: 1, since: 'abc', head: 'def', status: '' };

  it('asks the reviewer to check every criterion when the task has them', () => {
    expect(reviewPrompt('goal', request, null, true)).toContain('Check every acceptance criterion');
  });

  it('does not mention criteria when the task has none', () => {
    expect(reviewPrompt('goal', request, null)).not.toContain('acceptance criterion');
  });
});
