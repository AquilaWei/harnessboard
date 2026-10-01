// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { windowAt } from '../src/quota';

describe('windowAt', () => {
  it('keeps the reading and reset time before the window resets', () => {
    expect(windowAt(0.4, 2_000, 1_000)).toEqual({ utilization: 0.4, resetsAt: 2_000 });
  });

  it('shows an empty window without a time once the reset has passed', () => {
    expect(windowAt(0.4, 1_000, 1_000)).toEqual({ utilization: 0, resetsAt: null });
  });

  it('keeps the reading when no reset time was reported', () => {
    expect(windowAt(0.4, undefined, 1_000)).toEqual({ utilization: 0.4, resetsAt: null });
  });
});
