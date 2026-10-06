// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isModelId, roleAgent, roleModel } from '../src/agents.js';
import type { TaskAgents } from '../src/agents.js';

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

describe('the designer role', () => {
  const agents: TaskAgents = { implementer: 'claude', reviewer: null, maxReviewRounds: 2 };

  it('is off when no designer is set', () => {
    expect(roleAgent(agents, 'designer')).toBeNull();
  });

  it('is off when the designer is null', () => {
    expect(roleAgent({ ...agents, designer: null }, 'designer')).toBeNull();
  });

  it('names the designer agent when one is set', () => {
    expect(roleAgent({ ...agents, designer: 'artist' }, 'designer')).toBe('artist');
  });

  it('uses the designer model', () => {
    expect(roleModel({ ...agents, designer: 'artist', designerModel: 'opus' }, 'designer')).toBe(
      'opus',
    );
  });

  it('does not take the implementer model', () => {
    expect(roleModel({ ...agents, designer: 'artist', implementerModel: 'opus' }, 'designer')).toBe(
      null,
    );
  });
});
