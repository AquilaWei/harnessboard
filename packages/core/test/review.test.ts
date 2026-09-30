// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../src/review.js';

describe('parseVerdict', () => {
  it('reads an approval and keeps the rest as findings', () => {
    expect(parseVerdict('VERDICT: APPROVE\nLooks right.')).toEqual({
      verdict: 'approve',
      findings: 'Looks right.',
    });
  });

  it('reads a change request', () => {
    expect(parseVerdict('VERDICT: CHANGES\n- add a test').verdict).toBe('changes');
  });

  it('accepts a lower-case verdict line after blank lines', () => {
    expect(parseVerdict('\n  verdict: approve').verdict).toBe('approve');
  });

  it('returns no verdict when the first line has none, keeping the whole reply', () => {
    expect(parseVerdict('I think it is fine.\nVERDICT: APPROVE')).toEqual({
      verdict: null,
      findings: 'I think it is fine.\nVERDICT: APPROVE',
    });
  });
});
