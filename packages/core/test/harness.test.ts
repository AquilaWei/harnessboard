// SPDX-License-Identifier: Apache-2.0
// Integration tests: real git worktrees, the fake agent CLI, and a temporary database.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
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
    const task = await harness.createTask({ prompt: 'Fix the bug', repo, queue: true });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });

  it('runs the agent inside its own worktree on a task branch', async () => {
    const task = await harness.createTask({ prompt: 'Fix the bug', repo, queue: true });
    await harness.waitForIdle();
    const stored = harness.store.getTask(task.id)!;
    expect([stored.branch, fakeRuns()[0]!.cwd]).toEqual(['hb/1-fix-the-bug', stored.worktreePath]);
  });

  it('sends the task prompt as the first message', async () => {
    await harness.createTask({ prompt: 'Fix the bug', repo, queue: true });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received).toEqual(['Fix the bug']);
  });

  it('records the context window the agent reported', async () => {
    await harness.createTask({ prompt: 'Fix the bug', repo, queue: true });
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
    harness.createTask({ prompt: 'Build it', repo, softPct: 30, hardPct: 60, queue: true });

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
    const task = await harness.createTask({ prompt: 'Build it', repo, queue: true });
    await harness.waitForIdle();
    const stored = harness.store.getTask(task.id)!;
    expect([stored.status, stored.resumeAt]).toEqual(['waiting_quota', FUTURE_SEC * 1000]);
  });

  it('resumes the same session once the reset time has passed', async () => {
    await harness.createTask({ prompt: 'Build it', repo, queue: true });
    await harness.waitForIdle();
    harness.tick(FUTURE_SEC * 1000 + 1);
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).toContain('--resume');
  });
});

describe('quota utilisation above the pause threshold', () => {
  it('keeps new tasks queued', async () => {
    scenario([[init(), rateLimit('allowed', 0.97, FUTURE_SEC), result('done')]]);
    await harness.createTask({ prompt: 'First', repo, queue: true });
    await harness.waitForIdle();
    const second = await harness.createTask({ prompt: 'Second', repo, queue: true });
    await harness.waitForIdle();
    expect(harness.store.getTask(second.id)!.status).toBe('queued');
  });
});

describe('restarting the harness', () => {
  it('restores the last reported quota', async () => {
    scenario([[init(), rateLimit('allowed', 0.4, FUTURE_SEC), result('done')]]);
    await harness.createTask({ prompt: 'First', repo, queue: true });
    await harness.waitForIdle();
    const restarted = new Harness(harness.config, harness.store);
    expect(restarted.status().quotas['claude-code']?.fiveHourUtilization).toBe(0.4);
  });
});

describe('stopping a running task', () => {
  it('kills the agent and marks the task stopped', async () => {
    scenario([[init(), hang]]);
    const task = await harness.createTask({ prompt: 'Build it', repo, queue: true });
    await waitForStatus(task.id, 'running');
    harness.stopTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('stopped');
  });
});

describe('createTask', () => {
  it('rejects a directory outside any git repository', async () => {
    await expect(harness.createTask({ prompt: 'x', repo: tempDir('plain') })).rejects.toThrow(
      /not a git repository/,
    );
  });

  it('rejects an invalid context policy', async () => {
    await expect(
      harness.createTask({ prompt: 'x', repo, softPct: 60, hardPct: 50 }),
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
    const task = await harness.createTask({ prompt: 'Build it', repo, queue: true });
    await harness.waitForIdle();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).not.toContain('--resume');
  });
});

describe('an agent that exits before producing a result', () => {
  it('reports its stderr in the session notice', async () => {
    scenario([[exitWith(1, 'No conversation found')]]);
    const task = await harness.createTask({ prompt: 'Build it', repo, queue: true });
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
    const task = await missing.createTask({ prompt: 'x', repo, queue: true });
    await missing.waitForIdle();
    const notices = missing.store.listEvents(task.id).map((e) => JSON.stringify(e.data));
    expect(notices.some((n) => n.includes('HARNESSBOARD_CLAUDE_PATH'))).toBe(true);
  });
});
