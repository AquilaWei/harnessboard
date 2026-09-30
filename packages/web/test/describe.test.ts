// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import { describeTask } from '../src/describe';

const base = {
  status: 'backlog',
  agents: { implementer: 'claude', reviewer: 'checker', maxReviewRounds: 2 },
  activity: null,
  loop: null,
  lastReview: null,
  reviewPending: false,
  lastNotice: null,
  resumeAt: null,
  verifyCommand: null,
} as unknown as TaskView;

const approve = { round: 1, agentId: 'checker', verdict: 'approve', findings: '', head: 'h' };
const changes = { ...approve, round: 2, verdict: 'changes' };
const loop = { total: 3, claimed: 1, verified: 1, lastVerify: null };

describe('describeTask', () => {
  it('names the agent building the next loop feature', () => {
    const task = {
      ...base,
      status: 'running',
      activity: { phase: 'implementing', agentId: 'claude' },
      loop,
    } as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'buildingFeature',
      tone: 'working',
      vars: { agent: 'claude', n: 2, total: 3 },
    });
  });

  it('says the implementer is addressing requested changes', () => {
    const task = {
      ...base,
      status: 'running',
      activity: { phase: 'implementing', agentId: 'claude' },
      lastReview: changes,
    } as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'fixingReview',
      tone: 'working',
      vars: { agent: 'claude', reviewer: 'checker' },
    });
  });

  it('says the harness is running the verify command', () => {
    const task = {
      ...base,
      status: 'running',
      activity: { phase: 'verifying', agentId: null },
      verifyCommand: 'npm test',
    } as TaskView;
    expect(describeTask(task).vars).toEqual({ command: 'npm test' });
  });

  it('says a queued task waits for its reviewer', () => {
    const task = { ...base, status: 'queued', reviewPending: true } as TaskView;
    expect(describeTask(task).key).toBe('queuedForReview');
  });

  it('says a queued task will fix review feedback', () => {
    const task = { ...base, status: 'queued', lastReview: changes } as TaskView;
    expect(describeTask(task).key).toBe('queuedForFixes');
  });

  it('asks you to decide when the reviewer still wants changes', () => {
    const task = { ...base, status: 'review', lastReview: changes } as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'stillChanges',
      tone: 'attention',
      vars: { agent: 'checker', rounds: 2 },
    });
  });

  it('reports an approved loop task with its feature count', () => {
    const task = { ...base, status: 'review', lastReview: approve, loop } as TaskView;
    expect(describeTask(task).key).toBe('loopApproved');
  });

  it('gives the failure reason from the latest notice', () => {
    const task = { ...base, status: 'failed', lastNotice: 'verify failed (exit 1)' } as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'failed',
      tone: 'problem',
      vars: { reason: 'verify failed (exit 1)' },
    });
  });
});
