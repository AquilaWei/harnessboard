// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isEffortId, isModelId, roleAgent, roleEffort, roleModel } from '../src/agents.js';
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

describe('isEffortId', () => {
  it('accepts a plain level', () => {
    expect(isEffortId('high')).toBe(true);
  });

  it('accepts xhigh', () => {
    expect(isEffortId('xhigh')).toBe(true);
  });

  it('rejects something that reads as an option', () => {
    expect(isEffortId('-x')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isEffortId('')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isEffortId('a b')).toBe(false);
  });
});

describe('roleEffort', () => {
  const agents: TaskAgents = { implementer: 'claude', reviewer: 'codex', maxReviewRounds: 2 };

  it('is null when no effort is set', () => {
    expect(roleEffort(agents, 'reviewer')).toBeNull();
  });

  it('uses the implementer effort', () => {
    expect(roleEffort({ ...agents, implementerEffort: 'high' }, 'implementer')).toBe('high');
  });

  it('uses the reviewer effort', () => {
    expect(roleEffort({ ...agents, reviewerEffort: 'low' }, 'reviewer')).toBe('low');
  });

  it('uses the tester effort', () => {
    expect(roleEffort({ ...agents, tester: 'claude', testerEffort: 'max' }, 'tester')).toBe('max');
  });

  it('uses the designer effort', () => {
    expect(roleEffort({ ...agents, designer: 'claude', designerEffort: 'xhigh' }, 'designer')).toBe(
      'xhigh',
    );
  });

  it('uses the spec effort', () => {
    expect(roleEffort({ ...agents, spec: 'codex', specEffort: 'medium' }, 'spec')).toBe('medium');
  });

  it("gives a spec author left unset the implementer's effort", () => {
    expect(roleEffort({ ...agents, implementerEffort: 'high' }, 'spec')).toBe('high');
  });

  it("does not give a separate spec author the implementer's effort", () => {
    expect(roleEffort({ ...agents, spec: 'codex', implementerEffort: 'high' }, 'spec')).toBeNull();
  });

  it("does not give the reviewer the implementer's effort", () => {
    expect(roleEffort({ ...agents, implementerEffort: 'high' }, 'reviewer')).toBeNull();
  });
});
