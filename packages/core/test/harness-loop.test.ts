// SPDX-License-Identifier: Apache-2.0
// Loop mode against real git worktrees, the fake agent CLI and real verify commands.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  assistantText,
  featureList,
  init,
  makeRepo,
  result,
  tempDir,
  writeScenario,
} from './helpers.js';

interface FakeRun {
  args: string[];
  received: string[];
}

const VERIFY_OK = 'node -e "process.exit(0)"';
const VERIFY_FAIL = 'node -e "console.log(\'boom\'); process.exit(1)"';
const VERIFY_HANG = 'node -e "setTimeout(() => {}, 60000)"';

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('loop');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null } },
    fallbackContextWindow: 100_000,
    loopStallSessions: 2,
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

/** One agent session that optionally rewrites the feature list, then ends its turn. */
const session = (...writes: unknown[]) => [
  [init(), ...writes, assistantText('ok', 10_000), result('ok')],
];

async function createLoop(verifyCommand = VERIFY_OK) {
  const task = await harness.createTask({
    prompt: 'Build a calculator',
    repo,
    mode: 'loop',
    verifyCommand,
    confirmPlan: false,
    queue: true,
  });
  await harness.waitForIdle();
  return task;
}

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

async function waitForNotice(id: number, prefix: string): Promise<void> {
  const latest = () =>
    harness.store.lastEvent(id, 'notice')?.data as { message: string } | undefined;
  while (!latest()?.message.startsWith(prefix)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const status = (id: number) => harness.store.getTask(id)!.status;

describe('creating a loop task', () => {
  it('rejects a loop task that skips plan approval without a verify command', async () => {
    await expect(
      harness.createTask({ prompt: 'x', repo, mode: 'loop', confirmPlan: false }),
    ).rejects.toThrow(/needs a verify command/);
  });

  it('allows the agent to run the verify command', async () => {
    const task = await harness.createTask({
      prompt: 'x',
      repo,
      mode: 'loop',
      verifyCommand: 'npm test',
    });
    expect(task.permission.allowedTools).toContain('Bash(npm test)');
  });
});

describe('the initializer session', () => {
  it('is asked to plan features instead of implementing them', async () => {
    scenario(session(featureList(false, false)));
    await createLoop();
    expect(fakeRuns()[0]!.received[0]).toContain('Do not implement any features');
  });

  it('queues the first feature once the feature list exists', async () => {
    scenario(session(featureList(false, false)));
    const task = await createLoop();
    expect(status(task.id)).toBe('queued');
  });

  it('fails the task when it writes no feature list', async () => {
    scenario(session());
    const task = await createLoop();
    expect(status(task.id)).toBe('failed');
  });
});

describe('a feature session', () => {
  it('starts fresh with the loop prompt', async () => {
    scenario(session(featureList(false, false)), session(featureList(true, false)));
    await createLoop();
    await runQueued();
    const second = fakeRuns()[1]!;
    expect([second.args.includes('--resume'), second.received[0]]).toEqual([
      false,
      expect.stringContaining('Pick the first feature with "passes": false'),
    ]);
  });

  it('queues the next feature when verification passes and features remain', async () => {
    scenario(session(featureList(false, false)), session(featureList(true, false)));
    const task = await createLoop();
    await runQueued();
    expect(status(task.id)).toBe('queued');
  });

  it('moves the task to review when every feature passes verification', async () => {
    scenario(session(featureList(false, false)), session(featureList(true, true)));
    const task = await createLoop();
    await runQueued();
    expect(status(task.id)).toBe('review');
  });

  it('does not credit features when verification fails', async () => {
    scenario(session(featureList(false, false)), session(featureList(true, true)));
    const task = await createLoop(VERIFY_FAIL);
    await runQueued();
    expect(status(task.id)).toBe('queued');
  });

  it('shows the failed verification output to the next session', async () => {
    scenario(
      session(featureList(false, false)),
      session(featureList(true, true)),
      session(featureList(true, true)),
    );
    await createLoop(VERIFY_FAIL);
    await runQueued();
    await runQueued();
    expect(fakeRuns()[2]!.received[0]).toContain('boom');
  });

  it('fails the task when a feature is removed from the list', async () => {
    scenario(session(featureList(false, false)), session(featureList(true)));
    const task = await createLoop();
    await runQueued();
    expect(status(task.id)).toBe('failed');
  });

  it('stops for review after sessions without verified progress', async () => {
    scenario(
      session(featureList(false, false)),
      session(featureList(false, false)),
      session(featureList(false, false)),
    );
    const task = await createLoop();
    await runQueued();
    await runQueued();
    expect(status(task.id)).toBe('failed');
  });

  it('is stopped while the harness is verifying', async () => {
    scenario(session(featureList(false, false)), session(featureList(true, false)));
    const task = await createLoop(VERIFY_HANG);
    harness.tick();
    await waitForNotice(task.id, 'verifying');
    harness.stopTask(task.id);
    await harness.waitForIdle();
    expect(status(task.id)).toBe('stopped');
  });
});

describe('handoffs in a long loop', () => {
  it('counts handoffs only since the last completed feature', async () => {
    harness.config.maxHandoffs = 2;
    const handoff = (...writes: unknown[]) => [
      [init(), ...writes, assistantText('working', 45_000)],
      [assistantText('STATUS: CONTINUE', 46_000), result('STATUS: CONTINUE\nhalf done')],
    ];
    scenario(
      session(featureList(false, false)),
      handoff(),
      session(featureList(true, false)),
      handoff(),
    );
    const task = await harness.createTask({
      prompt: 'Build a calculator',
      repo,
      mode: 'loop',
      verifyCommand: VERIFY_OK,
      confirmPlan: false,
      softPct: 30,
      hardPct: 60,
      queue: true,
    });
    await harness.waitForIdle();
    await runQueued();
    await runQueued();
    await runQueued();
    expect(status(task.id)).toBe('queued');
  });
});
