// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { composeFeedback } from '../src/answers';

const questions = [
  { question: 'Which storage?', options: ['SQLite', 'JSON file'] },
  { question: 'Colour?', options: [] },
];

describe('composeFeedback', () => {
  it('lists each picked option under its question', () => {
    const answers = [
      { option: 'SQLite', other: '' },
      { option: null, other: '' },
    ];
    expect(composeFeedback(questions, answers, '', 'My answers:')).toBe(
      'My answers:\n- Which storage?\n  → SQLite',
    );
  });

  it("prefers the user's own words over a picked option", () => {
    const answers = [
      { option: 'SQLite', other: 'Postgres' },
      { option: null, other: '' },
    ];
    expect(composeFeedback(questions, answers, '', 'My answers:')).toBe(
      'My answers:\n- Which storage?\n  → Postgres',
    );
  });

  it('adds the note after the answers', () => {
    const answers = [
      { option: null, other: '' },
      { option: null, other: 'blue' },
    ];
    expect(composeFeedback(questions, answers, ' Keep it small. ', 'My answers:')).toBe(
      'My answers:\n- Colour?\n  → blue\n\nKeep it small.',
    );
  });

  it('is only the note when nothing is answered', () => {
    expect(composeFeedback(questions, [], 'Looks good', 'My answers:')).toBe('Looks good');
  });

  it('is empty when there is nothing to send', () => {
    expect(composeFeedback(questions, [], '  ', 'My answers:')).toBe('');
  });
});
