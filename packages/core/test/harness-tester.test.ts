// SPDX-License-Identifier: Apache-2.0
// The tester: a session that writes and runs tests after each implementer step, before review.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTaskInput } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { isTestPath, parseTestVerdict } from '../src/review.js';
import {
  FAKE_CLAUDE,
  commitAll,
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
  dir = tempDir('tester');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      qa: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: 'qa-default' },
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

const session = (text: string, ...writes: unknown[]) => [
  [init(), ...writes, commitAll('test: record stage work'), result(text)],
];
const status = (id: number) => harness.store.getTask(id)!.status;
const roles = (id: number) => harness.store.listSessions(id).map((s) => s.role);

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

/** A single task with a tester that has run its implementer step. */
async function tested(extra: Partial<CreateTaskInput> = {}) {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    confirmPlan: false,
    queue: true,
    reviewer: null,
    tester: 'qa',
    ...extra,
  });
  await harness.waitForIdle();
  return task;
}

const implemented = session('done', writeFile('hello.txt', 'hi'));
const passing = session('TESTS: PASS\nall criteria covered', writeFile('hello.test.js', 'ok'));

describe('a finished step with a tester', () => {
  it('is queued for testing instead of going to review', async () => {
    scenario(implemented);
    const task = await tested();
    expect(status(task.id)).toBe('queued');
  });

  it('runs the tester with its own model and the right to edit', async () => {
    scenario(implemented, passing);
    await tested();
    await runQueued();
    const args = fakeRuns()[1]!.args;
    expect([args.includes('acceptEdits'), args.includes('qa-default')]).toEqual([true, true]);
  });

  it('uses the model chosen for the tester', async () => {
    scenario(implemented, passing);
    await tested({ testerModel: 'qa-model' });
    await runQueued();
    expect(fakeRuns()[1]!.args).toContain('qa-model');
  });

  it('tells the tester what the task was', async () => {
    scenario(implemented, passing);
    await tested();
    await runQueued();
    expect(fakeRuns()[1]!.received[0]).toContain('Add a greeting');
  });

  it('goes to a human when the tests pass and there is no reviewer', async () => {
    scenario(implemented, passing);
    const task = await tested();
    await runQueued();
    expect(status(task.id)).toBe('review');
  });

  it('goes on to the reviewer when the tests pass', async () => {
    scenario(implemented, passing, session('VERDICT: APPROVE'));
    const task = await tested({ reviewer: 'checker' });
    await runQueued();
    await runQueued();
    expect(roles(task.id)).toEqual(['implementer', 'tester', 'reviewer']);
  });
});

describe('a reviewer that requests changes after the tests passed', () => {
  it('sends the fix through the tester again before the reviewer sees it', async () => {
    scenario(
      implemented,
      passing,
      session('VERDICT: CHANGES\n- greet() ignores the name'),
      session('fixed', writeFile('hello.txt', 'hi, name')),
      passing,
      session('VERDICT: APPROVE'),
    );
    const task = await tested({ reviewer: 'checker' });
    await runQueued(); // tester
    await runQueued(); // reviewer asks for changes
    await runQueued(); // implementer fixes
    await runQueued(); // tester again
    await runQueued(); // reviewer again
    expect(roles(task.id)).toEqual(['implementer', 'tester', 'reviewer']);
  });
});

describe('a tester that reports failures', () => {
  const failing = session('TESTS: FAIL\n- greet() returns nothing');

  it('sends the implementer back to work with the failures', async () => {
    scenario(implemented, failing, session('fixed'));
    const task = await tested();
    await runQueued();
    await runQueued();
    expect([roles(task.id), fakeRuns()[2]!.received[0]]).toEqual([
      ['implementer', 'tester'],
      expect.stringContaining('greet() returns nothing'),
    ]);
  });

  it('resumes the implementer session after the tester reports failures', async () => {
    scenario(implemented, failing, session('fixed'));
    await tested();
    await runQueued();
    await runQueued();
    expect(fakeRuns()[2]!.args).toContain('--resume');
  });

  it('hands the task to a human after the allowed rounds', async () => {
    scenario(implemented, failing, session('fixed', writeFile('hello2.txt', 'x')), failing);
    const task = await tested();
    for (let i = 0; i < 3; i++) await runQueued();
    expect([roles(task.id), status(task.id)]).toEqual([['implementer', 'tester'], 'review']);
  });

  it('gets fresh rounds when a human sends the task back', async () => {
    scenario(
      implemented,
      failing,
      session('fixed', writeFile('hello2.txt', 'x')),
      failing,
      session('fixed again', writeFile('hello3.txt', 'x')),
      failing,
    );
    const task = await tested();
    await runQueued(); // tester fails
    await runQueued(); // implementer fixes
    await runQueued(); // tester fails again: to a human
    harness.queueTask(task.id); // implementer fixes again
    await harness.waitForIdle();
    await runQueued(); // tester fails, round 1 after the send-back
    expect(status(task.id)).toBe('queued');
  });

  it('hands the task to a human when the reply has no verdict line', async () => {
    scenario(implemented, session('Looks fine to me'));
    const task = await tested();
    await runQueued();
    expect(status(task.id)).toBe('review');
  });
});

describe('a tester that changes more than tests', () => {
  it('stops the task', async () => {
    scenario(implemented, session('TESTS: PASS', writeFile('greeting.js', 'changed')));
    const task = await tested();
    await runQueued();
    expect(status(task.id)).toBe('failed');
  });
});

describe('changing the tester of a task', () => {
  it('is saved with its model', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    const updated = harness.setAgents(task.id, { tester: 'qa', testerModel: 'qa-model' });
    expect([updated.agents.tester, updated.agents.testerModel]).toEqual(['qa', 'qa-model']);
  });

  it('is refused for a profile that is not configured', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    expect(() => harness.setAgents(task.id, { tester: 'nobody' })).toThrow(/not configured/);
  });
});

describe('parseTestVerdict', () => {
  it('reads a pass from the first line', () => {
    expect(parseTestVerdict('TESTS: PASS\nok')).toEqual({ verdict: 'pass', findings: 'ok' });
  });

  it('reads a failure from the first line, ignoring case', () => {
    expect(parseTestVerdict('tests: fail\n- broken')).toEqual({
      verdict: 'fail',
      findings: '- broken',
    });
  });

  it('gives no verdict when the first line is something else', () => {
    expect(parseTestVerdict('All good')).toEqual({ verdict: null, findings: 'All good' });
  });
});

describe('isTestPath', () => {
  it.each(['test/a.js', 'src/__tests__/a.ts', 'a.test.ts', 'pkg/b_test.go', 'x.spec.js'])(
    'accepts %s',
    (file) => expect(isTestPath(file)).toBe(true),
  );

  it.each(['src/greeting.js', 'latest.js', 'README.md', 'contest/a.js'])('rejects %s', (file) =>
    expect(isTestPath(file)).toBe(false),
  );
});
