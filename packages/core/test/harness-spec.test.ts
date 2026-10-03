// SPDX-License-Identifier: Apache-2.0
// The spec author: the agent that writes the acceptance criteria before anything is built.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roleAgent, roleModel } from '@harnessboard/shared';
import type { CreateTaskInput, TaskAgents } from '@harnessboard/shared';
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
  dir = tempDir('spec');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      writer: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: 'writer-default' },
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
const PROPOSAL = 'I read main.js.\n## Acceptance criteria\n- prints hi';

const sessions = (id: number) => harness.store.listSessions(id);

async function discuss(extra: Partial<CreateTaskInput> = {}) {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    queue: true,
    reviewer: null,
    ...extra,
  });
  await harness.waitForIdle();
  return task;
}

describe('the discussion session', () => {
  beforeEach(() => scenario(session(PROPOSAL)));

  it('is run by the spec agent', async () => {
    const task = await discuss({ spec: 'writer' });
    expect(sessions(task.id).map((s) => [s.role, s.agentId])).toEqual([['spec', 'writer']]);
  });

  it('is run by the implementer when no spec agent is set', async () => {
    const task = await discuss();
    expect(sessions(task.id).map((s) => [s.role, s.agentId])).toEqual([['spec', 'claude']]);
  });

  it('uses the spec model', async () => {
    await discuss({ spec: 'writer', specModel: 'spec-model' });
    expect(fakeRuns()[0]!.args).toContain('spec-model');
  });

  it('uses the implementer model when no spec agent is set', async () => {
    await discuss({ implementerModel: 'impl-model' });
    expect(fakeRuns()[0]!.args).toContain('impl-model');
  });

  it('falls back to the spec profile model', async () => {
    await discuss({ spec: 'writer' });
    expect(fakeRuns()[0]!.args).toContain('writer-default');
  });
});

describe('after the criteria are approved', () => {
  beforeEach(() => scenario(session(PROPOSAL), session('done')));

  it('hands the work to the implementer in a new session when another agent wrote the spec', async () => {
    const task = await discuss({ spec: 'writer' });
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    expect([
      sessions(task.id).map((s) => [s.role, s.agentId]),
      fakeRuns()[1]!.args.includes('--resume'),
    ]).toEqual([
      [
        ['spec', 'writer'],
        ['implementer', 'claude'],
      ],
      false,
    ]);
  });

  it('gives that implementer the approved criteria', async () => {
    const task = await discuss({ spec: 'writer' });
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.received[0]).toContain('- prints hi');
  });

  it('continues the discussion when the same agent wrote the spec', async () => {
    const task = await discuss({ spec: 'claude' });
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).toContain('--resume');
  });
});

describe('changing the spec agent of a task', () => {
  it('is saved with its model', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    const updated = harness.setAgents(task.id, { spec: 'writer', specModel: 'spec-model' });
    expect([updated.agents.spec, updated.agents.specModel]).toEqual(['writer', 'spec-model']);
  });

  it('is refused for a profile that is not configured', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    expect(() => harness.setAgents(task.id, { spec: 'nobody' })).toThrow(/not configured/);
  });
});

describe('roleAgent and roleModel', () => {
  const agents: TaskAgents = { implementer: 'claude', reviewer: null, maxReviewRounds: 2 };

  it('makes the implementer the spec author by default', () => {
    expect(roleAgent(agents, 'spec')).toBe('claude');
  });

  it('names the spec agent when one is set', () => {
    expect(roleAgent({ ...agents, spec: 'writer' }, 'spec')).toBe('writer');
  });

  it('shares the implementer model with a spec author that is not set', () => {
    expect(roleModel({ ...agents, implementerModel: 'opus' }, 'spec')).toBe('opus');
  });

  it('does not pass the implementer model to another agent', () => {
    expect(roleModel({ ...agents, spec: 'writer', implementerModel: 'opus' }, 'spec')).toBeNull();
  });
});
