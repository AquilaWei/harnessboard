// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isModelId } from '../src/agents.js';

describe('isModelId', () => {
  it('accepts an alias', () => {
    expect(isModelId('sonnet')).toBe(true);
  });

  it('accepts a full id with a context suffix', () => {
    expect(isModelId('claude-opus-5-5[1m]')).toBe(true);
  });

  it('rejects something that reads as an option', () => {
    expect(isModelId('--dangerously-skip-permissions')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isModelId('opus please')).toBe(false);
  });
});
