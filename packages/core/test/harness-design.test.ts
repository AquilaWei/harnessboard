// SPDX-License-Identifier: Apache-2.0
// The designer: a read-only session that writes a design note before the implementer starts.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTaskInput } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  assistantText,
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

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('design');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      designer: {
        provider: 'claude-code' as const,
        command: FAKE_CLAUDE,
        model: 'designer-default',
      },
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

const session = (reply: string) => [[init(), assistantText(reply, 10_000), result(reply)]];
const CRITERIA = 'I read main.js.\n## Acceptance criteria\n- prints hi';
const DESIGN = '## Approach\n- Print in main.js';

const sessions = (id: number) => harness.store.listSessions(id);
const roles = (id: number) => sessions(id).map((s) => s.role);
/** The designer's session leaves the task queued; the next tick starts the implementer. */
async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

const status = (id: number) => harness.store.getTask(id)!.status;

/** A single task whose criteria are given, so it goes straight to the designer. */
async function designed(extra: Partial<CreateTaskInput> = {}) {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    acceptance: '- prints hi',
    queue: true,
    reviewer: null,
    design: 'designer',
    ...extra,
  });
  await harness.waitForIdle();
  await runQueued();
  return task;
}

describe('a task with a designer', () => {
  it('runs the designer before the implementer', async () => {
    scenario(session(DESIGN), session('done'));
    const task = await designed();
    expect(roles(task.id)).toEqual(['design', 'implementer']);
  });

  it('runs the designer read-only', async () => {
    scenario(session(DESIGN), session('done'));
    await designed();
    expect(fakeRuns()[0]!.args).not.toContain('acceptEdits');
  });

  it('gives the designer the task and its criteria', async () => {
    scenario(session(DESIGN), session('done'));
    await designed();
    expect(fakeRuns()[0]!.received[0]).toContain('Add a greeting');
  });

  it('uses the designer model', async () => {
    scenario(session(DESIGN), session('done'));
    await designed({ designModel: 'design-model' });
    expect(fakeRuns()[0]!.args).toContain('design-model');
  });

  it('gives the implementer the design note in a new session', async () => {
    scenario(session(DESIGN), session('done'));
    await designed();
    const run = fakeRuns()[1]!;
    expect([run.args.includes('--resume'), run.received[0]]).toEqual([
      false,
      expect.stringContaining(
        'Design note, written for this task before the work started:\n' + DESIGN,
      ),
    ]);
  });

  it('ends at review once the implementer is done', async () => {
    scenario(session(DESIGN), session('done'));
    const task = await designed();
    expect(status(task.id)).toBe('review');
  });

  it('runs the design once, not again after the implementer', async () => {
    scenario(session(DESIGN), session('done'));
    const task = await designed();
    expect(sessions(task.id).filter((s) => s.role === 'design')).toHaveLength(1);
  });

  it('fails the task when the designer writes nothing', async () => {
    scenario(session('   '));
    const task = await designed();
    expect(status(task.id)).toBe('failed');
  });
});

describe('a task that agrees on criteria first', () => {
  it('designs only after the criteria are approved', async () => {
    scenario(session(CRITERIA), session(DESIGN), session('done'));
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      queue: true,
      reviewer: null,
      design: 'designer',
    });
    await harness.waitForIdle();
    const before = roles(task.id);
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    await runQueued();
    expect([before, roles(task.id)]).toEqual([['spec'], ['spec', 'design', 'implementer']]);
  });
});

describe('changing the designer of a task', () => {
  it('is saved with its model', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    const updated = harness.setAgents(task.id, { design: 'designer', designModel: 'design-model' });
    expect([updated.agents.design, updated.agents.designModel]).toEqual([
      'designer',
      'design-model',
    ]);
  });

  it('can be turned off again', async () => {
    const task = await harness.createTask({
      prompt: 'x',
      repo,
      reviewer: null,
      design: 'designer',
    });
    expect(harness.setAgents(task.id, { design: null }).agents.design).toBeNull();
  });

  it('is refused for a profile that is not configured', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    expect(() => harness.setAgents(task.id, { design: 'nobody' })).toThrow(/not configured/);
  });
});
