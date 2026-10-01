// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { toQuestions } from '../src/loop.js';

describe('toQuestions', () => {
  it('turns a plain string into a question without options', () => {
    expect(toQuestions(['Colour?'])).toEqual([{ question: 'Colour?', options: [] }]);
  });

  it('keeps the options of a question object', () => {
    expect(toQuestions([{ question: 'Colour?', options: ['blue', 'red'] }])).toEqual([
      { question: 'Colour?', options: ['blue', 'red'] },
    ]);
  });

  it('drops options that are not text', () => {
    expect(toQuestions([{ question: 'Colour?', options: ['blue', 3, ' '] }])).toEqual([
      { question: 'Colour?', options: ['blue'] },
    ]);
  });

  it('drops entries without a question', () => {
    expect(toQuestions(['', { options: ['blue'] }, 7])).toEqual([]);
  });

  it('is empty for anything but a list', () => {
    expect(toQuestions(undefined)).toEqual([]);
  });
});
