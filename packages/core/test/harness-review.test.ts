// SPDX-License-Identifier: Apache-2.0
// Reviewer sessions against real git worktrees and the fake agent CLI.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  featureList,
  init,
  makeRepo,
  result,
  tempDir,
  writeFile,
  writeScenario,
} from './helpers.js';

interface FakeRun {
  args: string[];
  received: string[];
}

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('review');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      checker: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: 'review-model' },
    },
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

/** An agent session that optionally writes files, then replies with `text`. */
const session = (text: string, ...writes: unknown[]) => [[init(), ...writes, result(text)]];

async function createReviewed(mode: 'single' | 'loop' = 'single') {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    reviewer: 'checker',
    mode,
    ...(mode === 'loop' ? { verifyCommand: 'node -e "process.exit(0)"' } : {}),
    queue: true,
  });
  await harness.waitForIdle();
  return task;
}

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

const status = (id: number) => harness.store.getTask(id)!.status;
const roles = (id: number) => harness.store.listSessions(id).map((s) => s.role);

describe('a finished step with a reviewer', () => {
  it('is queued for review instead of going to a human', async () => {
    scenario(session('done', writeFile('hello.txt', 'hi')));
    const task = await createReviewed();
    expect(status(task.id)).toBe('queued');
  });

  it('runs the reviewer read-only with its own profile', async () => {
    scenario(session('done', writeFile('hello.txt', 'hi')), session('VERDICT: APPROVE'));
    await createReviewed();
    await runQueued();
    const args = fakeRuns()[1]!.args;
    expect([args.includes('acceptEdits'), args.includes('review-model')]).toEqual([false, true]);
  });

  it('goes to a human once the reviewer approves', async () => {
    scenario(session('done', writeFile('hello.txt', 'hi')), session('VERDICT: APPROVE\nGood.'));
    const task = await createReviewed();
    await runQueued();
    expect([status(task.id), roles(task.id)]).toEqual(['review', ['implementer', 'reviewer']]);
  });
});

describe('a reviewer that requests changes', () => {
  it('sends its findings to the next implementer session', async () => {
    scenario(
      session('done', writeFile('hello.txt', 'hi')),
      session('VERDICT: CHANGES\n- greet by name in hello.txt'),
      session('fixed', writeFile('hello.txt', 'hi Ada')),
    );
    await createReviewed();
    await runQueued();
    await runQueued();
    expect(fakeRuns()[2]!.received[0]).toContain('- greet by name in hello.txt');
  });

  it('hands the task to a human after the last allowed round', async () => {
    scenario(
      session('done', writeFile('hello.txt', 'hi')),
      session('VERDICT: CHANGES\n- greet by name'),
      session('fixed', writeFile('hello.txt', 'hi Ada')),
      session('VERDICT: CHANGES\n- still wrong'),
    );
    const task = await createReviewed();
    await runQueued();
    await runQueued();
    await runQueued();
    expect(status(task.id)).toBe('review');
  });
});

describe('a reviewer reply without a verdict line', () => {
  it('goes to a human', async () => {
    scenario(session('done', writeFile('hello.txt', 'hi')), session('Seems fine to me.'));
    const task = await createReviewed();
    await runQueued();
    expect(status(task.id)).toBe('review');
  });
});

describe('a reviewer that changes the worktree', () => {
  it('stops the task for a human', async () => {
    scenario(
      session('done', writeFile('hello.txt', 'hi')),
      session('VERDICT: APPROVE', writeFile('sneaky.txt', 'x')),
    );
    const task = await createReviewed();
    await runQueued();
    expect(status(task.id)).toBe('failed');
  });
});

describe('a loop task with a reviewer', () => {
  it('reviews a verified feature before starting the next one', async () => {
    scenario(
      session('planned', featureList(false, false)),
      session('F1 done', featureList(true, false)),
      session('VERDICT: APPROVE'),
    );
    const task = await createReviewed('loop');
    await runQueued();
    await runQueued();
    expect([status(task.id), roles(task.id)]).toEqual([
      'queued',
      ['implementer', 'implementer', 'reviewer'],
    ]);
  });
});
