// SPDX-License-Identifier: Apache-2.0
// Tokens and cost recorded per agent run, with the fake agent CLI.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  assistantText,
  compactBoundary,
  init,
  makeRepo,
  result,
  tempDir,
  usageResult,
  writeScenario,
} from './helpers.js';

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('usage');
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

async function create() {
  const task = await harness.createTask({
    prompt: 'Build it',
    repo,
    confirmPlan: false,
    queue: true,
  });
  await harness.waitForIdle();
  return task;
}

const usageOf = (taskId: number) =>
  harness.store.eventsOfKind(taskId, 'usage').map((e) => e.data as Record<string, unknown>);

describe('a finished agent run', () => {
  beforeEach(() =>
    scenario([[init(), assistantText('done', 1_000), usageResult('done', 10, 40, 0.02)]]),
  );

  it("records its role and the conversation's usage", async () => {
    const task = await create();
    expect(usageOf(task.id)).toMatchObject([
      {
        role: 'implementer',
        agentId: 'claude',
        usage: {
          costUsd: 0.02,
          models: { 'test-model': { input: 10, output: 40, costUsd: 0.02 } },
        },
      },
    ]);
  });

  it('records how long it ran', async () => {
    const task = await create();
    expect(usageOf(task.id)[0]!.durationMs).toEqual(expect.any(Number));
  });
});

describe('a run that reports no usage', () => {
  beforeEach(() => scenario([[init(), assistantText('done', 1_000), result('done')]]));

  it('is recorded without usage', async () => {
    const task = await create();
    expect(usageOf(task.id)).toMatchObject([{ usage: null }]);
  });
});

describe('a run compacted after its turn', () => {
  beforeEach(() =>
    scenario([
      [init(), assistantText('working', 35_000), usageResult('finished', 10, 40, 0.02)],
      [compactBoundary(35_000, 4_000), usageResult('', 15, 90, 0.05)],
    ]),
  );

  it('records the totals after the compaction', async () => {
    const task = await create();
    expect(usageOf(task.id)).toMatchObject([{ usage: { costUsd: 0.05 } }]);
  });
});

describe('a chat reply', () => {
  beforeEach(() =>
    scenario(
      [[init(), assistantText('done', 1_000), usageResult('done', 10, 40, 0.02)]],
      [[assistantText('because', 1_200), usageResult('because', 20, 80, 0.04)]],
    ),
  );

  it('is recorded as a run of its own', async () => {
    const task = await create();
    harness.chat(task.id, 'Why?');
    await harness.waitForIdle();
    expect(usageOf(task.id).map((u) => (u.usage as { costUsd: number }).costUsd)).toEqual([
      0.02, 0.04,
    ]);
  });
});
