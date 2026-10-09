// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { git } from '../src/worktree.js';
import {
  FAKE_CLAUDE,
  assistantText,
  commitAll,
  featureList,
  init,
  makeRepo,
  result,
  tempDir,
  writeFile,
  writeScenario,
} from './helpers.js';

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('persistent');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
      qa: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
      checker: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
    },
    fallbackContextWindow: 100_000,
  });
});

afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});

const turn = (id: string, text: string, ...actions: unknown[]) => [
  [init(id), ...actions, assistantText(text, 10_000), result(text)],
];

function runs(): { args: string[]; received: string[] }[] {
  return readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function next(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

async function loop() {
  const task = await harness.createTask({
    prompt: 'Build two features',
    repo,
    mode: 'loop',
    confirmPlan: false,
    verifyCommand: 'node -e "process.exit(0)"',
    reviewer: 'checker',
    queue: true,
  });
  await harness.waitForIdle();
  return task;
}

describe('persistent loop conversations', () => {
  function twoFeatures() {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: APPROVE'),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
  }

  it('resumes the implementer after planning and across features', async () => {
    twoFeatures();
    await loop();
    await next();
    await next();
    await next();
    expect(runs()[1]!.args).toContain('--resume');
    expect(runs()[3]!.args).toContain('--resume');
    expect(runs()[3]!.args).toContain('worker');
  });

  it('resumes the reviewer after approving the previous feature', async () => {
    twoFeatures();
    const task = await loop();
    await next();
    await next();
    await next();
    await next();
    expect(runs()[4]!.args).toContain('--resume');
    expect(runs()[4]!.args).toContain('reviewer');
    expect(harness.store.listSessions(task.id).map((s) => s.role)).toEqual([
      'implementer',
      'reviewer',
    ]);
  });

  it('gives the reviewer new feature scope without replaying the original task', async () => {
    twoFeatures();
    await loop();
    await next();
    await next();
    await next();
    await next();
    expect(runs()[4]!.received[0]).toContain('- F2: feature 2');
    expect(runs()[4]!.received[0]).not.toContain('Task given to the implementer');
  });

  it('gives a resumed implementer new notes without requiring the full history file', async () => {
    twoFeatures();
    await loop();
    await next();
    await next();
    await next();
    expect(runs()[3]!.received[0]).toContain('VERDICT: APPROVE');
    expect(runs()[3]!.received[0]).not.toContain('Before you start, read `.harnessboard/notes.md`');
  });

  it('compacts a completed stage even below the context warning', async () => {
    twoFeatures();
    await loop();
    expect(runs()[0]!.received.at(-1)).toBe('/compact');
  });

  it('resumes the same implementer when a loop review requests changes', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false), commitAll('docs: plan')),
      turn('worker', 'done', featureList(true), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: CHANGES\n- handle zero'),
      turn('worker', 'fixed', writeFile('zero.txt', 'handled'), commitAll('fix: zero')),
    ]);
    await loop();
    await next();
    await next();
    await next();
    expect(runs()[3]!.args).toContain('--resume');
    expect(runs()[3]!.args).toContain('worker');
    expect(runs()[3]!.received[0]).toContain('handle zero');
  });
});

describe('persistent tester conversation', () => {
  it('resumes the tester after an implementer fixes its findings', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'done', writeFile('hello.txt', 'hi'), commitAll('feat: hello')),
      turn('tester', 'TESTS: FAIL\n- handle zero'),
      turn('worker', 'fixed', writeFile('zero.txt', 'handled'), commitAll('fix: zero')),
      turn('tester', 'TESTS: PASS'),
    ]);
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      confirmPlan: false,
      tester: 'qa',
      queue: true,
    });
    await harness.waitForIdle();
    await next();
    await next();
    await next();
    expect(runs()[3]!.args).toContain('--resume');
    expect(runs()[3]!.args).toContain('tester');
    expect(harness.store.listSessions(task.id).map((s) => s.role)).toEqual([
      'implementer',
      'tester',
    ]);
  });
});

describe('handoff responsibilities', () => {
  it('blocks implementation handoff while changes are uncommitted', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'done', writeFile('hello.ts', 'export const hi = 1;')),
    ]);
    const task = await harness.createTask({
      prompt: 'Add hello',
      repo,
      confirmPlan: false,
      tester: 'qa',
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('failed');
    expect(harness.store.lastEvent(task.id, 'test_request')).toBeUndefined();
    expect(harness.store.lastEvent(task.id, 'commit_check')?.data).toMatchObject({ ok: false });
  });

  it('does not automatically send archived notes to the reviewer', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn(
        'worker',
        'done\n## Notes\nINTERNAL_WORK_HISTORY',
        writeFile('hello.ts', 'hi'),
        commitAll('feat: hello'),
      ),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
    const task = await harness.createTask({
      prompt: 'Add hello',
      repo,
      confirmPlan: false,
      reviewer: 'checker',
      queue: true,
    });
    await harness.waitForIdle();
    await next();
    expect(runs()[1]!.received[0]).not.toContain('Before you start, read');
    expect(runs()[1]!.received[0]).not.toContain('INTERNAL_WORK_HISTORY');
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });

  it('uses the tester instead of running a duplicate harness verification for a loop feature', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false), commitAll('docs: plan')),
      turn('worker', 'done', featureList(true), commitAll('feat: hello')),
      turn('tester', 'TESTS: PASS'),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
    const task = await harness.createTask({
      prompt: 'Add hello',
      repo,
      mode: 'loop',
      confirmPlan: false,
      verifyCommand: 'node -e "process.exit(1)"',
      tester: 'qa',
      reviewer: 'checker',
      queue: true,
    });
    await harness.waitForIdle();
    await next();
    expect(harness.store.lastEvent(task.id, 'test_request')).not.toBeNull();
    expect(harness.store.lastEvent(task.id, 'features')?.data).toMatchObject({
      verify: null,
      verifiedPassing: 0,
    });
    await next();
    expect(harness.store.lastEvent(task.id, 'features')?.data).toMatchObject({
      verify: null,
      verifiedPassing: 1,
      testerPassed: true,
    });
    await next();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });
});

describe('commit recovery', () => {
  it('keeps checking the original stage range until an invalid commit is corrected', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'done', writeFile('hello.ts', 'hi'), commitAll('bad message')),
      turn('worker', 'still done'),
      turn('worker', 'corrected'),
    ]);
    const task = await harness.createTask({
      prompt: 'Add hello',
      repo,
      confirmPlan: false,
      reviewer: null,
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('failed');
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('failed');
    expect(runs()[1]!.args).toContain('worker');
    const worktree = harness.store.getTask(task.id)!.worktreePath!;
    await git(worktree, ['commit', '--amend', '-m', 'feat: add hello']);
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
    expect(runs()[2]!.args).toContain('--resume');
  });

  it('blocks tester handoff when its test edits are not committed', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'done', writeFile('hello.ts', 'hi'), commitAll('feat: hello')),
      turn('tester', 'TESTS: PASS', writeFile('hello.test.ts', 'test')),
    ]);
    const task = await harness.createTask({
      prompt: 'Add hello',
      repo,
      confirmPlan: false,
      tester: 'qa',
      reviewer: 'checker',
      queue: true,
    });
    await harness.waitForIdle();
    await next();
    expect(harness.store.getTask(task.id)!.status).toBe('failed');
    expect(harness.store.lastEvent(task.id, 'review_request')).toBeUndefined();
  });
});
