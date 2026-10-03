// SPDX-License-Identifier: Apache-2.0
// The docs writer: a session that updates the documentation after each step, before review.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTaskInput } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { isDocPath } from '../src/review.js';
import {
  FAKE_CLAUDE,
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
  dir = tempDir('docs');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      scribe: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: 'scribe-default' },
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

const session = (text: string, ...writes: unknown[]) => [[init(), ...writes, result(text)]];
const status = (id: number) => harness.store.getTask(id)!.status;
const roles = (id: number) => harness.store.listSessions(id).map((s) => s.role);

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

/** A single task with a docs writer that has run its implementer step. */
async function documented(extra: Partial<CreateTaskInput> = {}) {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    confirmPlan: false,
    queue: true,
    reviewer: null,
    docs: 'scribe',
    ...extra,
  });
  await harness.waitForIdle();
  return task;
}

const implemented = session('done', writeFile('hello.txt', 'hi'));
const updated = session('Added a README line', writeFile('README.md', 'greeting'));

describe('a finished step with a docs writer', () => {
  it('is queued for the docs instead of going to review', async () => {
    scenario(implemented);
    const task = await documented();
    expect(status(task.id)).toBe('queued');
  });

  it('runs the docs writer with its model and the right to edit', async () => {
    scenario(implemented, updated);
    await documented();
    await runQueued();
    const args = fakeRuns()[1]!.args;
    expect([args.includes('acceptEdits'), args.includes('scribe-default')]).toEqual([true, true]);
  });

  it('uses the model chosen for the docs writer', async () => {
    scenario(implemented, updated);
    await documented({ docsModel: 'scribe-model' });
    await runQueued();
    expect(fakeRuns()[1]!.args).toContain('scribe-model');
  });

  it('tells the docs writer what the task was', async () => {
    scenario(implemented, updated);
    await documented();
    await runQueued();
    expect(fakeRuns()[1]!.received[0]).toContain('Add a greeting');
  });

  it('goes to a human after the docs when there is no reviewer', async () => {
    scenario(implemented, updated);
    const task = await documented();
    await runQueued();
    expect(status(task.id)).toBe('review');
  });

  it('goes on to the reviewer after the docs', async () => {
    scenario(implemented, updated, session('VERDICT: APPROVE'));
    const task = await documented({ reviewer: 'checker' });
    await runQueued();
    await runQueued();
    expect(roles(task.id)).toEqual(['implementer', 'docs', 'reviewer']);
  });

  it('runs after the tester', async () => {
    scenario(implemented, session('TESTS: PASS', writeFile('hello.test.js', 'ok')), updated);
    const task = await documented({ tester: 'qa' });
    await runQueued();
    await runQueued();
    expect(roles(task.id)).toEqual(['implementer', 'tester', 'docs']);
  });

  it('records what the docs writer did on the timeline', async () => {
    scenario(implemented, updated);
    const task = await documented();
    await runQueued();
    expect(harness.store.eventsOfKind(task.id, 'docs_done').map((e) => e.data)).toEqual([
      expect.objectContaining({ agentId: 'scribe', summary: 'Added a README line' }),
    ]);
  });
});

describe('a docs writer that changes more than docs', () => {
  it('stops the task', async () => {
    scenario(implemented, session('done', writeFile('greeting.js', 'changed')));
    const task = await documented();
    await runQueued();
    expect(status(task.id)).toBe('failed');
  });
});

describe('changing the docs writer of a task', () => {
  it('is saved with its model', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    const changed = harness.setAgents(task.id, { docs: 'scribe', docsModel: 'scribe-model' });
    expect([changed.agents.docs, changed.agents.docsModel]).toEqual(['scribe', 'scribe-model']);
  });

  it('is refused for a profile that is not configured', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    expect(() => harness.setAgents(task.id, { docs: 'nobody' })).toThrow(/not configured/);
  });
});

describe('isDocPath', () => {
  it.each(['README.md', 'docs/architecture.md', 'doc/a.txt', 'CHANGELOG.md', 'guide.rst'])(
    'accepts %s',
    (file) => expect(isDocPath(file)).toBe(true),
  );

  it.each(['src/greeting.js', 'package.json', 'mddocs/a.js'])('rejects %s', (file) =>
    expect(isDocPath(file)).toBe(false),
  );
});
