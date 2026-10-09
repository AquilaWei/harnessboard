// SPDX-License-Identifier: Apache-2.0
// Sessions compacted with /compact at the compact threshold, with the fake agent CLI.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  ASK_FOR_NOTES,
  FAKE_CLAUDE,
  assistantText,
  compactBoundary,
  hang,
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
  dir = tempDir('compact');
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

function fakeRuns(): FakeRun[] {
  const file = process.env.FAKE_CLAUDE_LOG!;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FakeRun);
}

/** A turn that ends at 35% context, then the compaction the harness asks for. */
const compactedSession = [
  [init(), assistantText('working', 35_000), result('finished')],
  [compactBoundary(35_000, 4_000), result('')],
];

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

describe('a turn that ends past the compact threshold', () => {
  beforeEach(() => scenario(compactedSession));

  it('is followed by /compact in the same process', async () => {
    await create();
    expect(fakeRuns()[0]!.received).toEqual([`Build it${ASK_FOR_NOTES}`, '/compact']);
  });

  it('ends as completed', async () => {
    const task = await create();
    const [session] = harness.store.listSessions(task.id);
    expect([session!.endReason, harness.store.getTask(task.id)!.status]).toEqual([
      'completed',
      'review',
    ]);
  });

  it("keeps the agent's reply as the session's result", async () => {
    const task = await create();
    const [session] = harness.store.listSessions(task.id);
    expect(harness.store.lastSessionEvent(session!.id, 'result')!.data).toMatchObject({
      text: 'finished',
    });
  });

  it('keeps the compacted context size', async () => {
    const task = await create();
    expect(harness.store.listSessions(task.id)[0]!.contextTokens).toBe(4_000);
  });
});

describe('a turn that crosses the compact threshold mid-work', () => {
  beforeEach(() =>
    scenario([
      [init(), assistantText('step 1', 35_000), assistantText('step 2', 36_000), result('done')],
      [compactBoundary(36_000, 4_000), result('')],
    ]),
  );

  it('is not interrupted: /compact only follows the end of the turn', async () => {
    await create();
    expect(fakeRuns()[0]!.received).toEqual([`Build it${ASK_FOR_NOTES}`, '/compact']);
  });
});

describe('a turn that crosses the soft and hard thresholds while compaction is on', () => {
  beforeEach(() =>
    scenario([
      [init(), assistantText('step 1', 45_000), assistantText('step 2', 70_000), result('done')],
      [compactBoundary(70_000, 4_000), result('')],
    ]),
  );

  const createWithLimits = () =>
    harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      softPct: 30,
      hardPct: 60,
      queue: true,
    });

  it('is not asked to wrap up or ended: only /compact follows the end of the turn', async () => {
    await createWithLimits();
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received).toEqual([`Build it${ASK_FOR_NOTES}`, '/compact']);
  });

  it('ends as completed, not as a handoff or a hard limit', async () => {
    const task = await createWithLimits();
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)[0]!.endReason).toBe('completed');
  });
});

describe('a turn that reaches the safety limit while compaction is on', () => {
  it('is ended with context_hard_limit', async () => {
    scenario([[init(), assistantText('huge', 95_000), hang]]);
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      softPct: 30,
      hardPct: 60,
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)[0]!.endReason).toBe('context_hard_limit');
  });
});

describe('a turn that ends under the compact threshold', () => {
  beforeEach(() => scenario([[init(), assistantText('working', 20_000), result('done')]]));

  it('does not compact at the workflow stage boundary below the warning', async () => {
    await create();
    expect(fakeRuns()[0]!.received).toEqual([`Build it${ASK_FOR_NOTES}`]);
  });
});

describe('a turn that ends in an error past the compact threshold', () => {
  beforeEach(() =>
    scenario([[init(), assistantText('working', 35_000), { ...result('boom'), is_error: true }]]),
  );

  it('is not compacted', async () => {
    await create();
    expect(fakeRuns()[0]!.received).toEqual([`Build it${ASK_FOR_NOTES}`]);
  });
});

describe('a compaction that does not happen', () => {
  beforeEach(() =>
    scenario([[init(), assistantText('working', 35_000), result('finished')], [result('')]]),
  );

  it('still ends the session as completed', async () => {
    const task = await create();
    expect(harness.store.listSessions(task.id)[0]!.endReason).toBe('completed');
  });
});

describe('a task with compaction turned off', () => {
  beforeEach(() => scenario([[init(), assistantText('working', 35_000), result('done')]]));

  it('is never compacted', async () => {
    await harness.createTask({
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      compactPct: 0,
      queue: true,
    });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received).toEqual([`Build it${ASK_FOR_NOTES}`]);
  });
});
