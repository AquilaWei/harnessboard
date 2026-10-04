// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  criteriaPrompt,
  parseCriteria,
  parseQuestions,
  specFilePrompt,
  taskGoal,
} from '../src/prompts.js';
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

describe('parseQuestions', () => {
  it('reads each question with the options indented under it', () => {
    const reply = '## Questions\n- Which storage?\n  - SQLite\n  - JSON file\n- Colour?';
    expect(parseQuestions(reply)).toEqual([
      { question: 'Which storage?', options: ['SQLite', 'JSON file'] },
      { question: 'Colour?', options: [] },
    ]);
  });

  it('stops at the next heading', () => {
    const reply = '## Questions\n- Colour?\n## Notes\n- not a question';
    expect(parseQuestions(reply)).toEqual([{ question: 'Colour?', options: [] }]);
  });

  it('stops at text after the list', () => {
    const reply = '## Questions\n- Colour?\n\nReady when you are.';
    expect(parseQuestions(reply)).toEqual([{ question: 'Colour?', options: [] }]);
  });

  it('accepts numbered questions', () => {
    const reply = '## Questions\n1. Colour?\n   - blue';
    expect(parseQuestions(reply)).toEqual([{ question: 'Colour?', options: ['blue'] }]);
  });

  it('returns none without a questions section', () => {
    expect(parseQuestions('## Acceptance criteria\n- prints hi')).toEqual([]);
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

describe('taskGoal with a spec file', () => {
  it('points the agent at the committed spec', () => {
    expect(taskGoal('Add a greeting', null, 'docs/specs/001-x.md')).toContain(
      'committed in `docs/specs/001-x.md`. Read it first',
    );
  });

  it('asks the agent to keep the docs in step with the change', () => {
    expect(taskGoal('Add a greeting', null, 'docs/specs/001-x.md')).toContain(
      'Keep the README, the changelog entry',
    );
  });

  it('does not mention the docs for a task without a spec file', () => {
    expect(taskGoal('Add a greeting', '- prints hi')).not.toContain('README');
  });
});

describe('criteriaPrompt', () => {
  it('asks for requirements and a design as well as criteria', () => {
    const prompt = criteriaPrompt('Add a greeting', null);
    expect([prompt.includes('## Requirements'), prompt.includes('## Design')]).toEqual([
      true,
      true,
    ]);
  });
});

describe('specFilePrompt', () => {
  const prompt = specFilePrompt('docs/specs/001-x.md', 'Add a greeting', '- prints hi', null);

  it('names the file to write', () => {
    expect(prompt).toContain('Create `docs/specs/001-x.md`');
  });

  it('asks for a design section in the file', () => {
    expect(prompt).toContain('Design (files to change, interfaces, risks)');
  });

  it('includes the latest proposal for an author that does not remember it', () => {
    expect(
      specFilePrompt('docs/specs/001-x.md', 'Add a greeting', '- prints hi', 'My proposal'),
    ).toContain('Your latest proposal in the discussion:\nMy proposal');
  });
});

describe('reviewPrompt', () => {
  const request = { round: 1, since: 'abc', head: 'def', status: '' };

  it('asks the reviewer to check every criterion when the task has them', () => {
    expect(reviewPrompt('goal', request, null, true)).toContain('Check every acceptance criterion');
  });

  it('asks the reviewer to check that the docs are up to date', () => {
    expect(reviewPrompt('goal', request, null)).toContain('the README, changelog and docs');
  });

  it('does not mention criteria when the task has none', () => {
    expect(reviewPrompt('goal', request, null)).not.toContain('acceptance criterion');
  });

  it('does not mention later steps for a single task', () => {
    expect(reviewPrompt('goal', request, null)).not.toContain('later steps');
  });
});

describe('reviewPrompt for a loop step', () => {
  const request = { round: 1, since: 'abc', head: 'def', status: '' };
  const features = [
    { id: 'F1', description: 'stops are tappable', passes: true },
    { id: 'F2', description: 'light rail', passes: false },
  ];
  const prompt = reviewPrompt('goal', request, null, false, features);

  it('lists the features marked done for review', () => {
    expect(prompt).toContain(
      'Features marked done, which must work and be tested:\n- F1: stops are tappable',
    );
  });

  it('tells the reviewer not to request the features still to come', () => {
    expect(prompt).toContain(
      'Features still to come are built in later steps. Do not request them, and do not\n' +
        'hold their open questions against this step:\n- F2: light rail',
    );
  });

  it('asks for what the done features need, not everything the task asked for', () => {
    expect(prompt).toContain('anything the done features need that is');
  });

  it('says so when no feature is done yet', () => {
    const none = [{ id: 'F1', description: 'stops are tappable', passes: false }];
    expect(reviewPrompt('goal', request, null, false, none)).toContain(
      'Features marked done, which must work and be tested:\n- (none)',
    );
  });
});
