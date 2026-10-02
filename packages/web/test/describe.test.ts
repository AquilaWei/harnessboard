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

  it('says a queued task whose agent is still open waits for quota', () => {
    const task = {
      ...base,
      status: 'queued',
      activity: { phase: 'implementing', agentId: 'claude' },
    } as TaskView;
    expect(describeTask(task)).toEqual({ key: 'answerHeld', tone: 'working', vars: {} });
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

describe('describeTask for plans', () => {
  it('counts the features and questions of a plan waiting for approval', () => {
    const task = {
      ...base,
      status: 'awaiting_approval',
      plan: { total: 8, questions: 2, suggestedVerify: 'npm test' },
    } as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'planReadyQuestions',
      tone: 'attention',
      vars: { total: 8, questions: 2 },
    });
  });

  it('says the planner is revising an earlier proposal', () => {
    const task = {
      ...base,
      status: 'running',
      activity: { phase: 'planning', agentId: 'claude' },
      plan: { total: 8, questions: 0, suggestedVerify: null },
    } as TaskView;
    expect(describeTask(task).key).toBe('revisingPlan');
  });

  it('says queued feedback waits for the planner', () => {
    const task = { ...base, status: 'queued', planFeedbackPending: true } as TaskView;
    expect(describeTask(task).key).toBe('revisingPlanQueued');
  });
});

describe('describeTask for acceptance criteria', () => {
  const proposal = { criteria: '- prints hi', reply: '## Acceptance criteria\n- prints hi' };

  it('says the agent is reading the repository to propose criteria', () => {
    const task = {
      ...base,
      mode: 'single',
      status: 'running',
      activity: { phase: 'planning', agentId: 'claude' },
      criteria: null,
    } as unknown as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'discussing',
      tone: 'working',
      vars: { agent: 'claude' },
    });
  });

  it('asks the user to approve proposed criteria', () => {
    const task = {
      ...base,
      mode: 'single',
      status: 'awaiting_approval',
      criteria: proposal,
    } as unknown as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'criteriaReady',
      tone: 'attention',
      vars: { agent: 'claude' },
    });
  });

  it('asks the user to answer when the agent proposed no criteria', () => {
    const task = {
      ...base,
      mode: 'single',
      status: 'awaiting_approval',
      criteria: { criteria: null, reply: 'What should it print?' },
    } as unknown as TaskView;
    expect(describeTask(task).key).toBe('criteriaMissing');
  });

  it('says the agent is revising its criteria', () => {
    const task = {
      ...base,
      mode: 'single',
      status: 'running',
      activity: { phase: 'planning', agentId: 'claude' },
      criteria: proposal,
    } as unknown as TaskView;
    expect(describeTask(task).key).toBe('revisingCriteria');
  });

  it('says queued feedback waits for the agent', () => {
    const task = {
      ...base,
      mode: 'single',
      status: 'queued',
      planFeedbackPending: true,
    } as unknown as TaskView;
    expect(describeTask(task).key).toBe('revisingCriteriaQueued');
  });
});

describe('describeTask for merged tasks', () => {
  it('says where a done task was merged', () => {
    const merge = { base: 'main', branch: 'hb/1-x', commit: 'abc' };
    const task = { ...base, status: 'done', merge } as unknown as TaskView;
    expect(describeTask(task)).toEqual({ key: 'merged', tone: 'done', vars: { base: 'main' } });
  });

  it('just says done without a merge', () => {
    const task = { ...base, status: 'done', merge: null } as unknown as TaskView;
    expect(describeTask(task).key).toBe('done');
  });
});

describe('describeTask for chats', () => {
  it('says the agent is replying to the user', () => {
    const task = {
      ...base,
      status: 'running',
      activity: { phase: 'chatting', agentId: 'claude' },
    } as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'chatting',
      tone: 'working',
      vars: { agent: 'claude' },
    });
  });
});

describe('describeTask for permission requests', () => {
  it('names the agent, tool and command it waits on', () => {
    const task = {
      ...base,
      status: 'awaiting_permission',
      activity: { phase: 'implementing', agentId: 'claude' },
      permissionRequests: [
        {
          requestId: 'r1',
          sessionId: 's1',
          toolName: 'Bash',
          summary: 'node hello.js',
          suggestedRules: ['Bash(node *)'],
          ts: 1,
        },
      ],
    } as TaskView;
    expect(describeTask(task)).toEqual({
      key: 'permissionAsked',
      tone: 'attention',
      vars: { agent: 'claude', tool: 'Bash', summary: 'node hello.js' },
    });
  });
});
