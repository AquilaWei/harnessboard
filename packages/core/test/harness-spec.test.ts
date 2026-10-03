// SPDX-License-Identifier: Apache-2.0
// The spec author: the agent that writes the acceptance criteria before anything is built.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roleAgent, roleModel } from '@harnessboard/shared';
import type { CreateTaskInput, TaskAgents } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { isCommitted } from '../src/worktree.js';
import {
  FAKE_CLAUDE,
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
/** The spec author's session after approval: it writes the spec file for the first task. */
const specFile = [
  [
    init(),
    assistantText('spec written', 10_000),
    writeFile('docs/specs/001-add-a-greeting.md', '# Spec'),
    result('spec written'),
  ],
];

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

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
  beforeEach(() => scenario(session(PROPOSAL), specFile, session('done')));

  async function approved(extra: Partial<CreateTaskInput> = {}) {
    const task = await discuss(extra);
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    await runQueued();
    return task;
  }

  it('has the implementer start in a session of its own after the spec is written', async () => {
    const task = await approved({ spec: 'writer' });
    expect(sessions(task.id).map((s) => [s.role, s.agentId])).toEqual([
      ['spec', 'writer'],
      ['implementer', 'claude'],
    ]);
  });

  it('continues the discussion to write the spec, with the right to edit', async () => {
    await approved({ spec: 'writer' });
    const args = fakeRuns()[1]!.args;
    expect([args.includes('--resume'), args.includes('acceptEdits')]).toEqual([true, true]);
  });

  it('asks for the spec file at its path with the approved criteria', async () => {
    await approved({ spec: 'writer' });
    const prompt = fakeRuns()[1]!.received[0] as string;
    expect([
      prompt.includes('docs/specs/001-add-a-greeting.md'),
      prompt.includes('- prints hi'),
    ]).toEqual([true, true]);
  });

  it('records the committed spec on the task', async () => {
    const task = await approved({ spec: 'writer' });
    expect(harness.store.eventsOfKind(task.id, 'spec_written').map((e) => e.data)).toEqual([
      expect.objectContaining({ path: 'docs/specs/001-add-a-greeting.md' }),
    ]);
  });

  it('commits the spec file itself when the author left it uncommitted', async () => {
    const task = await approved({ spec: 'writer' });
    expect(
      await isCommitted(
        harness.store.getTask(task.id)!.worktreePath!,
        'docs/specs/001-add-a-greeting.md',
      ),
    ).toBe(true);
  });

  it('hands the work to the implementer in a new session when another agent wrote the spec', async () => {
    await approved({ spec: 'writer' });
    expect(fakeRuns()[2]!.args.includes('--resume')).toBe(false);
  });

  it('points the implementer at the spec file and gives it the criteria', async () => {
    await approved({ spec: 'writer' });
    const prompt = fakeRuns()[2]!.received[0] as string;
    expect([
      prompt.includes('committed in `docs/specs/001-add-a-greeting.md`'),
      prompt.includes('- prints hi'),
    ]).toEqual([true, true]);
  });

  it('continues the same conversation when the same agent wrote the spec', async () => {
    await approved({ spec: 'claude' });
    expect(fakeRuns()[2]!.args).toContain('--resume');
  });

  it('ends at review once the implementer is done', async () => {
    const task = await approved();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });
});

describe('a spec author that does not write the spec properly', () => {
  async function approve() {
    const task = await discuss();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    return task;
  }

  it('stops the task when it changes other files', async () => {
    scenario(session(PROPOSAL), [
      [
        init(),
        writeFile('docs/specs/001-add-a-greeting.md', 'x'),
        writeFile('main.js', 'oops'),
        result('done'),
      ],
    ]);
    const task = await approve();
    expect(harness.store.getTask(task.id)!.status).toBe('failed');
  });

  it('stops the task when it writes no file', async () => {
    scenario(session(PROPOSAL), session('nothing written'));
    const task = await approve();
    expect(harness.store.getTask(task.id)!.status).toBe('failed');
  });

  it('does not start the implementer', async () => {
    scenario(session(PROPOSAL), session('nothing written'));
    const task = await approve();
    expect(sessions(task.id).map((s) => s.role)).toEqual(['spec']);
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
