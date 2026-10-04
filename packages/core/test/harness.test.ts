// SPDX-License-Identifier: Apache-2.0
// Integration tests: real git worktrees, the fake agent CLI, and a temporary database.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  ASK_FOR_NOTES,
  FAKE_CLAUDE,
  askBash,
  assistantText,
  errorResult,
  exitWith,
  hang,
  init,
  makeRepo,
  rateLimit,
  result,
  tempDir,
  writeScenario,
} from './helpers.js';

interface FakeRun {
  args: string[];
  cwd: string;
  received: string[];
}

let dir: string;
let repo: string;
let harness: Harness;
const FUTURE_SEC = 4_000_000_000;

beforeEach(() => {
  dir = tempDir('harness');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null } },
    fallbackContextWindow: 100_000,
  };
  harness = Harness.open(config);
});

afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});

function scenario(...sessions: unknown[][][]): void {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, sessions);
}

function fakeRuns(): FakeRun[] {
  const file = process.env.FAKE_CLAUDE_LOG!;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FakeRun);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

async function waitForStatus(id: number, status: string): Promise<void> {
  while (harness.store.getTask(id)!.status !== status) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a task whose session completes', () => {
  beforeEach(() => {
    scenario([[init(), assistantText('all done', 20_000), result('all done')]]);
  });

  it('moves to review', async () => {
    const task = await harness.createTask({
      prompt: 'Fix the bug',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });

  it('runs the agent inside its own worktree on a task branch', async () => {
    const task = await harness.createTask({
      prompt: 'Fix the bug',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    const stored = harness.store.getTask(task.id)!;
    expect([stored.branch, fakeRuns()[0]!.cwd]).toEqual(['hb/1-fix-the-bug', stored.worktreePath]);
  });

  it('sends the task prompt as the first message', async () => {
    await harness.createTask({ prompt: 'Fix the bug', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received).toEqual([`Fix the bug${ASK_FOR_NOTES}`]);
  });

  it('records the context window the agent reported', async () => {
    await harness.createTask({ prompt: 'Fix the bug', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    expect(harness.store.lastKnownContextWindow('claude')).toBe(100_000);
  });
});

describe('a session that crosses the soft threshold', () => {
  beforeEach(() => {
    scenario(
      [
        [init('s1'), assistantText('working', 45_000)],
        [assistantText('Done: parser. Next: tests.', 46_000), result('Done: parser. Next: tests.')],
      ],
      [[init('s2'), assistantText('finished', 10_000), result('finished')]],
    );
  });

  const create = () =>
    harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      compactPct: 0,
      softPct: 30,
      hardPct: 60,
      queue: true,
    });

  it('asks the agent to wrap up mid-session', async () => {
    await create();
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received[1]).toContain('Context usage has reached 45%');
  });

  it('ends the session as a handoff and re-queues the task', async () => {
    const task = await create();
    await harness.waitForIdle();
    expect([
      harness.store.listSessions(task.id)[0]!.endReason,
      harness.store.getTask(task.id)!.status,
    ]).toEqual(['handoff', 'queued']);
  });

  it('starts the next session fresh with the handoff note', async () => {
    await create();
    await harness.waitForIdle();
    await runQueued();
    const second = fakeRuns()[1]!;
    expect([second.args.includes('--resume'), second.received[0]]).toEqual([
      false,
      expect.stringContaining('Done: parser. Next: tests.'),
    ]);
  });
});

describe('a wrap-up reply that reports the task done', () => {
  it('moves the task to review instead of handing off', async () => {
    scenario([
      [init(), assistantText('working', 45_000)],
      [assistantText('STATUS: DONE', 46_000), result('STATUS: DONE\nAll steps finished.')],
    ]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      compactPct: 0,
      softPct: 30,
      hardPct: 60,
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });
});

describe('a session that crosses the hard threshold', () => {
  it('is killed and ends with context_hard_limit', async () => {
    scenario([[init(), assistantText('huge', 70_000), hang]]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      softPct: 30,
      hardPct: 60,
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)[0]!.endReason).toBe('context_hard_limit');
  });
});

describe('a session that hits the usage limit', () => {
  beforeEach(() => {
    scenario(
      [
        [
          init('s1'),
          assistantText('working', 5_000),
          rateLimit('rejected', 1, FUTURE_SEC),
          errorResult(429),
        ],
      ],
      [[init('s1'), assistantText('resumed', 6_000), result('resumed')]],
    );
  });

  it('waits for the reported reset time', async () => {
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    const stored = harness.store.getTask(task.id)!;
    expect([stored.status, stored.resumeAt]).toEqual(['waiting_quota', FUTURE_SEC * 1000]);
  });

  it('resumes the same session once the reset time has passed', async () => {
    await harness.createTask({ prompt: 'Build it', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    harness.tick(FUTURE_SEC * 1000 + 1);
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).toContain('--resume');
  });
});

describe('quota utilisation above the pause threshold', () => {
  it('keeps new tasks queued', async () => {
    scenario([[init(), rateLimit('allowed', 0.97, FUTURE_SEC), result('done')]]);
    await harness.createTask({ prompt: 'First', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    const second = await harness.createTask({
      prompt: 'Second',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.store.getTask(second.id)!.status).toBe('queued');
  });
});

describe('restarting the harness', () => {
  it('restores the last reported quota', async () => {
    scenario([[init(), rateLimit('allowed', 0.4, FUTURE_SEC), result('done')]]);
    await harness.createTask({ prompt: 'First', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    const restarted = new Harness(harness.config, harness.store);
    expect(restarted.status().quotas['claude-code']?.fiveHourUtilization).toBe(0.4);
  });
});

describe('stopping a running task', () => {
  it('kills the agent and marks the task stopped', async () => {
    scenario([[init(), hang]]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'running');
    harness.stopTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('stopped');
  });
});

describe('a tool the task does not allow', () => {
  beforeEach(() => {
    scenario([[init(), askBash('r1', 'node hello.js', 'node *'), result('done')]]);
  });

  it('starts the agent so that it asks instead of refusing', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.args).toContain('--permission-prompt-tool');
  });

  it('pauses the task until the user answers', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    expect(harness.permissionRequests(task.id)).toMatchObject([
      {
        requestId: 'r1',
        toolName: 'Bash',
        summary: 'node hello.js',
        suggestedRules: ['Bash(node *)'],
      },
    ]);
  });

  it('lets the agent go on once allowed', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    await harness.waitForIdle();
    expect([fakeRuns()[0]!.received[1], harness.store.getTask(task.id)!.status]).toEqual([
      { answer: { behavior: 'allow', updatedInput: { command: 'node hello.js' } } },
      'review',
    ]);
  });

  it('goes back to running once answered', async () => {
    scenario([[init(), askBash('r1', 'node hello.js', 'node *'), hang]]);
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    expect(harness.store.getTask(task.id)!.status).toBe('running');
  });

  it('keeps the task rules unchanged when allowed once', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.permission.allowedTools).not.toContain('Bash(node *)');
  });

  it('adds the rules given with the answer to the task', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, {
      requestId: 'r1',
      behavior: 'allow',
      rules: ['Bash(node *)'],
    });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.permission.allowedTools).toContain('Bash(node *)');
  });

  it('passes the reason to the agent when denied', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, {
      requestId: 'r1',
      behavior: 'deny',
      message: 'use the test script',
    });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received[1]).toEqual({
      answer: { behavior: 'deny', message: 'use the test script' },
    });
  });

  it('records the request and the answer in the history', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'deny' });
    await harness.waitForIdle();
    expect([
      harness.store.eventsOfKind(task.id, 'permission_request').length,
      harness.store.lastEvent(task.id, 'permission_decision')!.data,
    ]).toEqual([
      1,
      {
        requestId: 'r1',
        toolName: 'Bash',
        summary: 'node hello.js',
        behavior: 'deny',
        rules: [],
        message: null,
        auto: false,
      },
    ]);
  });

  it('rejects an invalid rule without answering the agent', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    expect(() =>
      harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow', rules: ['node ok'] }),
    ).toThrow(/not a tool rule/);
    expect(harness.permissionRequests(task.id)).toHaveLength(1);
  });

  it('rejects an answer to a request that is not waiting', async () => {
    const task = await harness.createTask({ autoApprove: false, prompt: 'Run it', repo });
    expect(() => harness.answerPermission(task.id, { requestId: 'r9', behavior: 'allow' })).toThrow(
      /no pending permission request r9/,
    );
  });

  it('is stopped, not left waiting, when the user stops it', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.stopTask(task.id);
    await harness.waitForIdle();
    expect([harness.store.getTask(task.id)!.status, harness.permissionRequests(task.id)]).toEqual([
      'stopped',
      [],
    ]);
  });

  it('is queued again after a restart', async () => {
    const task = await harness.createTask({ autoApprove: false, prompt: 'Run it', repo });
    harness.store.updateTask(task.id, { status: 'awaiting_permission' });
    const restarted = new Harness(harness.config, harness.store);
    restarted.start();
    await restarted.shutdown();
    expect(harness.store.getTask(task.id)!.status).not.toBe('awaiting_permission');
  });
});

describe('answering a tool use while the quota is used up', () => {
  beforeEach(() => {
    scenario([
      [
        init(),
        rateLimit('allowed', 0.97, FUTURE_SEC),
        askBash('r1', 'node hello.js', 'node *'),
        result('done'),
      ],
    ]);
  });

  it('puts the task back in the queue instead of running on', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    expect(harness.store.getTask(task.id)!.status).toBe('queued');
  });

  it('records the answer straight away', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    expect(harness.store.lastEvent(task.id, 'permission_decision')!.data).toMatchObject({
      requestId: 'r1',
      behavior: 'allow',
    });
  });

  it('does not let the agent go on before the window resets', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    harness.tick(FUTURE_SEC * 1000 - 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.store.getTask(task.id)!.status).toBe('queued');
  });

  it('sends the answer once the window resets', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    harness.tick(FUTURE_SEC * 1000 + 1);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });

  it('stops a task whose answer is held', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, { requestId: 'r1', behavior: 'allow' });
    harness.stopTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('stopped');
  });
});

describe('a tool the task rules already cover', () => {
  it('is allowed without asking when the user added its rule earlier in the session', async () => {
    scenario([
      [
        init(),
        askBash('r1', 'node a.js', 'node *'),
        askBash('r2', 'node b.js', 'node *'),
        result('done'),
      ],
    ]);
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'Run it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, {
      requestId: 'r1',
      behavior: 'allow',
      rules: ['Bash(node *)'],
    });
    await harness.waitForIdle();
    expect(harness.store.eventsOfKind(task.id, 'permission_request')).toHaveLength(1);
  });
});

describe('task models', () => {
  it('runs the implementer with the model chosen for the task', async () => {
    scenario([[init(), result('done')]]);
    await harness.createTask({
      prompt: 'x',
      repo,
      confirmPlan: false,
      implementerModel: 'haiku',
      queue: true,
    });
    await harness.waitForIdle();
    const args = fakeRuns()[0]!.args;
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
  });

  it('uses the profile model when the task does not choose one', async () => {
    scenario([[init(), result('done')]]);
    await harness.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.args).not.toContain('--model');
  });

  it('rejects a model id that could be read as an option', async () => {
    await expect(
      harness.createTask({
        prompt: 'x',
        repo,
        confirmPlan: false,
        implementerModel: '--dangerously-skip-permissions',
      }),
    ).rejects.toThrow(/is not a model id/);
  });

  it('changes the model of a task that is not running', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    const updated = harness.setAgents(task.id, { implementerModel: 'sonnet' });
    expect(updated.agents.implementerModel).toBe('sonnet');
  });

  it('keeps the other agent settings when changing one', async () => {
    const task = await harness.createTask({
      prompt: 'x',
      repo,
      confirmPlan: false,
      implementerModel: 'opus',
    });
    const updated = harness.setAgents(task.id, { reviewer: null });
    expect([updated.agents.implementerModel, updated.agents.reviewer]).toEqual(['opus', null]);
  });

  it('rejects an agent profile that is not configured', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(() => harness.setAgents(task.id, { reviewer: 'gemini' })).toThrow(
      /agent profile "gemini" is not configured/,
    );
  });
});

describe('task models while a session is open', () => {
  beforeEach(() => {
    scenario([[init(), askBash('r1', 'node hello.js', 'node *'), hang]]);
  });

  it('changes the model for the next session', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    const updated = harness.setAgents(task.id, { implementerModel: 'sonnet' });
    expect(updated.agents.implementerModel).toBe('sonnet');
  });

  it('accepts the unchanged agent sent with a new model', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    const updated = harness.setAgents(task.id, { implementer: 'claude', reviewerModel: 'haiku' });
    expect(updated.agents.reviewerModel).toBe('haiku');
  });

  it('rejects a different agent', async () => {
    const task = await harness.createTask({
      autoApprove: false,
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'awaiting_permission');
    expect(() => harness.setAgents(task.id, { reviewer: 'claude' })).toThrow(
      /stop it before changing its agents/,
    );
  });
});

describe('setAllowedTools', () => {
  it('replaces the rules of a task that is not running', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    const updated = harness.setAllowedTools(task.id, ['Bash(npm *)', ' WebSearch ', 'Bash(npm *)']);
    expect(updated.permission.allowedTools).toEqual(['Bash(npm *)', 'WebSearch']);
  });

  it('passes the new rules to the next session', async () => {
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    harness.setAllowedTools(task.id, ['Bash(./gradlew *)']);
    harness.queueTask(task.id);
    await harness.waitForIdle();
    const args = fakeRuns()[0]!.args;
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash(./gradlew *)');
  });

  it('rejects a rule that is not a tool rule', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(() => harness.setAllowedTools(task.id, ['please allow npm'])).toThrow(/not a tool rule/);
  });

  it('refuses while the task is running', async () => {
    scenario([[init(), hang]]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'running');
    expect(() => harness.setAllowedTools(task.id, ['WebSearch'])).toThrow(/stop it before/);
  });
});

describe('commitDiff', () => {
  it('refuses a ref that is not a commit of the task', async () => {
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'Fix the bug',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    await expect(harness.commitDiff(task.id, '--output=/tmp/x')).rejects.toThrow(
      /is not on task 1's branch/,
    );
  });
});

describe('deleting a task', () => {
  it('removes the task with its sessions and events', async () => {
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'Fix the bug',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    await harness.deleteTask(task.id);
    expect([
      harness.store.getTask(task.id),
      harness.store.listSessions(task.id),
      harness.store.listEvents(task.id),
    ]).toEqual([undefined, [], []]);
  });

  it('removes its worktree directory', async () => {
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'Fix the bug',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    const worktree = harness.store.getTask(task.id)!.worktreePath!;
    await harness.deleteTask(task.id);
    expect(existsSync(worktree)).toBe(false);
  });

  it('keeps its branch so committed work can still be merged', async () => {
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'Fix the bug',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    await harness.deleteTask(task.id);
    expect(git(repo, 'branch', '--list', 'hb/1-fix-the-bug')).toContain('hb/1-fix-the-bug');
  });

  it('works when the worktree directory was already deleted by hand', async () => {
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'Fix the bug',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    rmSync(harness.store.getTask(task.id)!.worktreePath!, { recursive: true });
    await harness.deleteTask(task.id);
    expect(harness.store.getTask(task.id)).toBeUndefined();
  });

  it('refuses while the task is running', async () => {
    scenario([[init(), hang]]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await waitForStatus(task.id, 'running');
    await expect(harness.deleteTask(task.id)).rejects.toThrow(/stop it before deleting/);
  });

  it('tells subscribers the task is gone', async () => {
    const task = await harness.createTask({ prompt: 'Fix the bug', repo });
    const seen: unknown[] = [];
    harness.subscribe((event) => seen.push(event));
    await harness.deleteTask(task.id);
    expect(seen).toEqual([{ type: 'deleted', taskId: task.id }]);
  });
});

describe('createTask', () => {
  it('rejects a directory outside any git repository with a way to fix it', async () => {
    await expect(harness.createTask({ prompt: 'x', repo: tempDir('plain') })).rejects.toThrow(
      /not inside a git repository\. Run "git init"/,
    );
  });

  it('accepts a repository path starting with ~', async () => {
    const home = path.relative(os.homedir(), repo);
    const task = await harness.createTask({ prompt: 'x', repo: `~/${home}` });
    expect(task.repoPath).toBe(repo);
  });

  it('rejects allowed tools that are not tool rules', async () => {
    await expect(
      harness.createTask({
        prompt: 'x',
        repo,
        confirmPlan: false,
        allowedTools: ['anything is fine locally'],
      }),
    ).rejects.toThrow(/not a tool rule: "anything is fine locally"/);
  });

  it('gives the git preset when no rules are given', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(task.permission.allowedTools).toContain('Bash(git commit *)');
  });

  it('rejects an invalid context policy', async () => {
    await expect(
      harness.createTask({ prompt: 'x', repo, confirmPlan: false, softPct: 60, hardPct: 50 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('updateSettings', () => {
  it('applies a new concurrency limit', () => {
    harness.updateSettings({ maxConcurrent: 3 });
    expect(harness.status().maxConcurrent).toBe(3);
  });

  it('rejects keys that are not editable', () => {
    expect(() => harness.updateSettings({ port: 1 } as never)).toThrow(/unknown settings: port/);
  });

  it('leaves settings unchanged when a value is invalid', () => {
    expect(() => harness.updateSettings({ maxConcurrent: 3, quotaPauseUtilization: 2 })).toThrow();
    expect(harness.settings().maxConcurrent).toBe(1);
  });

  it('uses the default context policy for new tasks', async () => {
    harness.updateSettings({ defaultContextPolicy: { size: 'large' } });
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(task.contextPolicy).toEqual({ size: 'large' });
  });
});

describe('retrying a session that never reached the model', () => {
  it('starts a fresh session instead of resuming one that does not exist', async () => {
    scenario([[exitWith(1, 'No conversation found')]], [[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).not.toContain('--resume');
  });
});

describe('an agent that exits before producing a result', () => {
  it('reports its stderr in the session notice', async () => {
    scenario([[exitWith(1, 'No conversation found')]]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    const notice = harness.store.lastEvent(task.id, 'notice')!.data as { message: string };
    expect(notice.message).toContain('No conversation found');
  });
});

describe('an agent CLI that cannot be found', () => {
  it('fails the task with a hint about HARNESSBOARD_CLAUDE_PATH', async () => {
    const config = {
      ...harness.config,
      agents: {
        claude: {
          provider: 'claude-code' as const,
          command: path.join(dir, 'no-such-claude'),
          model: null,
        },
      },
    };
    const missing = new Harness(config, harness.store);
    const task = await missing.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    await missing.waitForIdle();
    const notices = missing.store.listEvents(task.id).map((e) => JSON.stringify(e.data));
    expect(notices.some((n) => n.includes('HARNESSBOARD_CLAUDE_PATH'))).toBe(true);
  });
});
