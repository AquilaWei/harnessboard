// SPDX-License-Identifier: Apache-2.0
// Loop tasks that wait for the user to approve the plan, with the fake agent CLI.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  commitAll,
  assistantText,
  featureList,
  hang,
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

const VERIFY_OK = 'node -e "process.exit(0)"';

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('plan');
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

/** A planner's feature list with a suggested verify command and open questions. */
const proposal = (ids: string[], questions: string[] = []) =>
  writeFile(
    'feature_list.json',
    JSON.stringify({
      features: ids.map((id) => ({ id, description: `feature ${id}`, passes: false })),
      verify: 'npm test',
      questions,
    }),
  );

/** An agent session that writes files, reports some context use, and replies. */
const session = (reply: string, ...writes: unknown[]) => [
  [
    init(),
    ...writes,
    commitAll('test: record stage work'),
    assistantText(reply, 10_000),
    result(reply),
  ],
];

async function createPlanned() {
  const task = await harness.createTask({
    prompt: 'Build a todo CLI',
    repo,
    mode: 'loop',
    queue: true,
  });
  await harness.waitForIdle();
  return task;
}

const status = (id: number) => harness.store.getTask(id)!.status;

describe('creating a loop task that confirms its plan', () => {
  it('accepts a missing verify command', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, mode: 'loop' });
    expect([task.confirmPlan, task.verifyCommand]).toEqual([true, null]);
  });
});

describe('a finished planning session', () => {
  beforeEach(() => {
    scenario(session('Plan: F1, F2. Which storage?', proposal(['F1', 'F2'], ['Which storage?'])));
  });

  it('waits for the user instead of building', async () => {
    const task = await createPlanned();
    expect(status(task.id)).toBe('awaiting_approval');
  });

  it('records the proposal with the suggestion, questions and reply', async () => {
    const task = await createPlanned();
    const plan = harness.store.lastEvent(task.id, 'plan')!.data;
    expect(plan).toEqual({
      features: [
        { id: 'F1', description: 'feature F1', passes: false },
        { id: 'F2', description: 'feature F2', passes: false },
      ],
      suggestedVerify: 'npm test',
      questions: [{ question: 'Which storage?', options: [] }],
      reply: 'Plan: F1, F2. Which storage?',
    });
  });

  it('cannot simply be queued again', async () => {
    const task = await createPlanned();
    expect(() => harness.queueTask(task.id)).toThrow(/awaiting_approval/);
  });
});

describe('feedback on a plan', () => {
  beforeEach(() => {
    scenario(
      session('Plan: F1, F2.', proposal(['F1', 'F2'])),
      session('Added F3.', proposal(['F1', 'F2', 'F3'])),
    );
  });

  it('continues the planner conversation with the feedback', async () => {
    const task = await createPlanned();
    harness.planFeedback(task.id, 'Also add deleting items.');
    await harness.waitForIdle();
    const second = fakeRuns()[1]!;
    expect([second.args.includes('--resume'), second.received[0]]).toEqual([
      true,
      expect.stringContaining('Also add deleting items.'),
    ]);
  });

  it('waits for approval again with the revised plan', async () => {
    const task = await createPlanned();
    harness.planFeedback(task.id, 'Also add deleting items.');
    await harness.waitForIdle();
    const plan = harness.store.lastEvent(task.id, 'plan')!.data as { features: unknown[] };
    expect([status(task.id), plan.features.length]).toEqual(['awaiting_approval', 3]);
  });

  it('is refused while the task is not waiting for approval', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, mode: 'loop' });
    expect(() => harness.planFeedback(task.id, 'hi')).toThrow(/not waiting for plan approval/);
  });
});

describe('approving a plan', () => {
  beforeEach(() => {
    scenario(
      session('Plan: F1, F2.', proposal(['F1', 'F2'])),
      session('F1 done', featureList(true, false)),
    );
  });

  it('needs a verify command and names the suggestion', async () => {
    const task = await createPlanned();
    expect(() => harness.approvePlan(task.id)).toThrow(/the planner suggested: npm test/);
  });

  it('sets the verify command and lets the agent run it', async () => {
    const task = await createPlanned();
    const approved = harness.approvePlan(task.id, VERIFY_OK);
    expect([approved.verifyCommand, approved.permission.allowedTools]).toEqual([
      VERIFY_OK,
      expect.arrayContaining([`Bash(${VERIFY_OK})`]),
    ]);
  });

  it('uses the feature list as it is at approval time as the baseline', async () => {
    const task = await createPlanned();
    const worktree = harness.store.getTask(task.id)!.worktreePath!;
    writeFileSync(
      path.join(worktree, 'feature_list.json'),
      JSON.stringify({ features: [{ id: 'F9', description: 'edited', passes: false }] }),
    );
    harness.approvePlan(task.id, VERIFY_OK);
    const baseline = harness.store.eventsOfKind(task.id, 'features')[0]!.data as {
      features: { id: string }[];
    };
    expect(baseline.features.map((f) => f.id)).toEqual(['F9']);
  });

  it('starts building with the loop prompt', async () => {
    const task = await createPlanned();
    harness.approvePlan(task.id, VERIFY_OK);
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.received[0]).toContain('Pick the first feature with "passes": false');
  });
});

describe('a planner revising its plan', () => {
  it('is shown as planning, not implementing', async () => {
    scenario(session('Plan: F1.', proposal(['F1'])), [[init(), hang]]);
    const task = await createPlanned();
    harness.planFeedback(task.id, 'Split F1.');
    while (harness.activity(task.id) === null) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(harness.activity(task.id)!.phase).toBe('planning');
  });
});
