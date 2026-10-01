// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { contextPct, resolveThresholds } from '../src/context.js';

describe('resolveThresholds', () => {
  it('defaults to medium: soft 40, hard 50', () => {
    expect(resolveThresholds({})).toEqual({ compactPct: 30, softPct: 40, hardPct: 50 });
  });

  it('uses soft 30 for small tasks', () => {
    expect(resolveThresholds({ size: 'small' })).toEqual({
      compactPct: 30,
      softPct: 30,
      hardPct: 40,
    });
  });

  it('uses soft 50 for large tasks', () => {
    expect(resolveThresholds({ size: 'large' })).toEqual({
      compactPct: 30,
      softPct: 50,
      hardPct: 60,
    });
  });

  it('lets an explicit softPct override the size', () => {
    expect(resolveThresholds({ size: 'large', softPct: 35 })).toEqual({
      compactPct: 30,
      softPct: 35,
      hardPct: 45,
    });
  });

  it('caps the derived hard threshold at 100', () => {
    expect(resolveThresholds({ softPct: 95 })).toEqual({
      compactPct: 30,
      softPct: 95,
      hardPct: 100,
    });
  });

  it('compacts at the given percentage', () => {
    expect(resolveThresholds({ compactPct: 20 }).compactPct).toBe(20);
  });

  it('turns compaction off at 0', () => {
    expect(resolveThresholds({ compactPct: 0 }).compactPct).toBeNull();
  });

  it('leaves compaction off when the default would come at or after a low hard limit', () => {
    expect(resolveThresholds({ softPct: 10, hardPct: 20 }).compactPct).toBeNull();
  });

  it('rejects compacting at or above hard', () => {
    expect(() => resolveThresholds({ compactPct: 50 })).toThrow(/invalid compact threshold/);
  });

  it('rejects soft at or above hard', () => {
    expect(() => resolveThresholds({ softPct: 50, hardPct: 50 })).toThrow(RangeError);
  });
});

describe('contextPct', () => {
  it('rounds to one decimal place', () => {
    expect(contextPct(25_688, 1_000_000)).toBe(2.6);
  });
});
