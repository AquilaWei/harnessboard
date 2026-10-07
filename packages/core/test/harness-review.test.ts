// SPDX-License-Identifier: Apache-2.0
// Reviewer sessions against real git worktrees and the fake agent CLI.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  featureList,
  assistantText,
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

/** Like {@link session}, but the CLI reports the context it used, so the session can be resumed. */
const sessionWithContext = (text: string, ...writes: unknown[]) => [
  [init(), assistantText(text, 1000), ...writes, result(text)],
];

async function createReviewed(mode: 'single' | 'loop' = 'single') {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    reviewer: 'checker',
    mode,
    confirmPlan: false,
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

  it('runs the reviewer with the model chosen for the task', async () => {
    scenario(session('done', writeFile('hello.txt', 'hi')), session('VERDICT: APPROVE'));
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      reviewer: 'checker',
      reviewerModel: 'opus',
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    await runQueued();
    const args = fakeRuns()[1]!.args;
    expect([task.agents.reviewerModel, args[args.indexOf('--model') + 1]]).toEqual([
      'opus',
      'opus',
    ]);
  });

  it('never lets the reviewer ask for more tools', async () => {
    scenario(session('done', writeFile('hello.txt', 'hi')), session('VERDICT: APPROVE'));
    await createReviewed();
    await runQueued();
    expect(fakeRuns()[1]!.args).not.toContain('--permission-prompt-tool');
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

  it('resumes the implementer conversation instead of starting a new one', async () => {
    scenario(
      sessionWithContext('done', writeFile('hello.txt', 'hi')),
      session('VERDICT: CHANGES\n- greet by name in hello.txt'),
      session('fixed', writeFile('hello.txt', 'hi Ada')),
    );
    await createReviewed();
    await runQueued();
    await runQueued();
    expect(fakeRuns()[2]!.args).toContain('--resume');
  });

  it('gives a resumed implementer the findings without the whole task again', async () => {
    scenario(
      sessionWithContext('done', writeFile('hello.txt', 'hi')),
      session('VERDICT: CHANGES\n- greet by name in hello.txt'),
      session('fixed', writeFile('hello.txt', 'hi Ada')),
    );
    await createReviewed();
    await runQueued();
    await runQueued();
    expect(fakeRuns()[2]!.received[0]).not.toContain('Original task:');
  });

  const twoRounds = () =>
    scenario(
      sessionWithContext('done', writeFile('hello.txt', 'hi')),
      sessionWithContext('VERDICT: CHANGES\n- greet by name in hello.txt'),
      sessionWithContext('fixed', writeFile('hello.txt', 'hi Ada')),
      sessionWithContext('VERDICT: APPROVE'),
    );

  it('resumes the reviewer conversation for the next round', async () => {
    twoRounds();
    await createReviewed();
    await runQueued();
    await runQueued();
    await runQueued();
    expect(fakeRuns()[3]!.args).toContain('--resume');
  });

  it('tells a resumed reviewer only what changed, not the whole task again', async () => {
    twoRounds();
    await createReviewed();
    await runQueued();
    await runQueued();
    await runQueued();
    expect(fakeRuns()[3]!.received[0]).not.toContain('Task given to the implementer');
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

describe('a task a human sends back after the last allowed round', () => {
  const twoRoundsOfChanges = [
    session('done', writeFile('hello.txt', 'hi')),
    session('VERDICT: CHANGES\n- greet by name'),
    session('fixed', writeFile('hello.txt', 'hi Ada')),
    session('VERDICT: CHANGES\n- greet by full name'),
  ];

  it('gives the implementer the last review', async () => {
    scenario(...twoRoundsOfChanges, session('fixed again', writeFile('hello.txt', 'hi Ada L')));
    const task = await createReviewed();
    await runQueued();
    await runQueued();
    await runQueued();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(fakeRuns()[4]!.received[0]).toContain('- greet by full name');
  });

  it('lets the reviewer ask for changes again instead of stopping', async () => {
    scenario(
      ...twoRoundsOfChanges,
      session('fixed again', writeFile('hello.txt', 'hi Ada L')),
      session('VERDICT: CHANGES\n- add a comma'),
    );
    const task = await createReviewed();
    await runQueued();
    await runQueued();
    await runQueued();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    await runQueued();
    expect(status(task.id)).toBe('queued');
  });
});

describe('a reviewer with review guidelines', () => {
  it('is given the rules from the guideline file', async () => {
    const rules = path.join(dir, 'rules.md');
    writeFileSync(rules, '- tests contain no logic\n');
    harness.updateSettings({ reviewGuidelines: [rules] });
    scenario(session('done', writeFile('hello.txt', 'hi')), session('VERDICT: APPROVE'));
    await createReviewed();
    await runQueued();
    expect(fakeRuns()[1]!.received[0]).toContain('- tests contain no logic');
  });

  it('stops the task when the file is gone by the time of the review', async () => {
    const rules = path.join(dir, 'rules.md');
    writeFileSync(rules, '- tests contain no logic\n');
    harness.updateSettings({ reviewGuidelines: [rules] });
    scenario(session('done', writeFile('hello.txt', 'hi')), session('VERDICT: APPROVE'));
    const task = await createReviewed();
    rmSync(rules);
    await runQueued();
    expect([status(task.id), roles(task.id)]).toEqual(['failed', ['implementer']]);
  });
});

describe('setting review guidelines', () => {
  it('is refused for a file that can not be read', () => {
    const missing = path.join(dir, 'missing.md');
    expect(() => harness.updateSettings({ reviewGuidelines: [missing] })).toThrow(
      `review guideline ${missing} can not be read`,
    );
  });

  it('leaves the settings unchanged when refused', () => {
    const missing = path.join(dir, 'missing.md');
    expect(() => harness.updateSettings({ reviewGuidelines: [missing] })).toThrow();
    expect(harness.settings().reviewGuidelines).toEqual([]);
  });
});

describe('a reviewer of a loop task', () => {
  it('may run the verify command', async () => {
    scenario(
      session('planned', featureList(false, false)),
      session('F1 done', featureList(true, false)),
      session('VERDICT: APPROVE'),
    );
    await createReviewed('loop');
    await runQueued();
    await runQueued();
    expect(fakeRuns()[2]!.args).toContain('Bash(node -e "process.exit(0)")');
  });

  it('is told the features still to come are not part of the step', async () => {
    scenario(
      session('planned', featureList(false, false)),
      session('F1 done', featureList(true, false)),
      session('VERDICT: APPROVE'),
    );
    await createReviewed('loop');
    await runQueued();
    await runQueued();
    expect(fakeRuns()[2]!.received[0]).toContain(
      'Do not request them, and do not\nhold their open questions against this step:\n- F2: feature 2',
    );
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
