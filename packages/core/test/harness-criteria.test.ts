// SPDX-License-Identifier: Apache-2.0
// Single tasks that agree on acceptance criteria with the user first, with the fake agent CLI.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  ASK_FOR_NOTES,
  assistantText,
  init,
  makeRepo,
  result,
  tempDir,
  writeFile,
  writeScenario,
} from './helpers.js';
import { FAKE_CLAUDE } from './helpers.js';

interface FakeRun {
  args: string[];
  received: string[];
}

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('criteria');
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

/** An agent session that reports some context use and replies. */
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

const PROPOSAL = 'I read main.js.\n## Acceptance criteria\n- prints hi\n## Questions\n- Colour?';

async function createDiscussed() {
  const task = await harness.createTask({ prompt: 'Add a greeting', repo, queue: true });
  await harness.waitForIdle();
  return task;
}

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

const status = (id: number) => harness.store.getTask(id)!.status;

describe('creating a single task', () => {
  it('discusses criteria first when none are given', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect([task.confirmPlan, task.acceptance]).toEqual([true, null]);
  });

  it('starts right away with criteria given', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, acceptance: ' - prints hi ' });
    expect([task.confirmPlan, task.acceptance]).toEqual([false, '- prints hi']);
  });

  it('starts right away without criteria when discussion is turned off', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    expect(task.confirmPlan).toBe(false);
  });
});

describe('the discussion session', () => {
  beforeEach(() => scenario(session(PROPOSAL)));

  it('runs read-only', async () => {
    await createDiscussed();
    expect(fakeRuns()[0]!.args).not.toContain('acceptEdits');
  });

  it('is never offered more tools', async () => {
    await createDiscussed();
    expect(fakeRuns()[0]!.args).not.toContain('--permission-prompt-tool');
  });

  it('is asked to propose criteria for the task', async () => {
    await createDiscussed();
    expect(fakeRuns()[0]!.received[0]).toContain('Task:\nAdd a greeting');
  });

  it('waits for the user afterwards', async () => {
    const task = await createDiscussed();
    expect(status(task.id)).toBe('awaiting_approval');
  });

  it('records the proposed criteria with the whole reply', async () => {
    const task = await createDiscussed();
    expect(harness.criteriaProposal(harness.store.getTask(task.id)!)).toEqual({
      criteria: '- prints hi',
      reply: PROPOSAL,
      questions: [{ question: 'Colour?', options: [] }],
    });
  });

  it('is told about criteria the user drafted', async () => {
    await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      acceptance: '- prints hi',
      confirmPlan: true,
      queue: true,
    });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received[0]).toContain(
      "The user's draft acceptance criteria:\n- prints hi",
    );
  });
});

describe('feedback on proposed criteria', () => {
  beforeEach(() => scenario(session(PROPOSAL), session(PROPOSAL)));

  it('continues the same conversation with the reply', async () => {
    const task = await createDiscussed();
    harness.planFeedback(task.id, 'Blue, please');
    await harness.waitForIdle();
    const run = fakeRuns()[1]!;
    expect([run.args.includes('--resume'), run.received[0]]).toEqual([
      true,
      expect.stringContaining('Blue, please'),
    ]);
  });

  it('keeps the revision read-only', async () => {
    const task = await createDiscussed();
    harness.planFeedback(task.id, 'Blue, please');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).not.toContain('acceptEdits');
  });
});

describe('approving criteria', () => {
  beforeEach(() => scenario(session(PROPOSAL), specFile, session('done')));

  it('saves the proposed criteria on the task', async () => {
    const task = await createDiscussed();
    expect(harness.approveCriteria(task.id).acceptance).toBe('- prints hi');
  });

  it('saves criteria the user edited instead', async () => {
    const task = await createDiscussed();
    expect(harness.approveCriteria(task.id, '- prints hello').acceptance).toBe('- prints hello');
  });

  it('resumes the discussion to write the spec, now allowed to edit', async () => {
    const task = await createDiscussed();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    const args = fakeRuns()[1]!.args;
    expect([args.includes('--resume'), args.includes('acceptEdits')]).toEqual([true, true]);
  });

  it('tells the agent the approved criteria', async () => {
    const task = await createDiscussed();
    harness.approveCriteria(task.id, '- prints hello');
    await harness.waitForIdle();
    await runQueued();
    expect(fakeRuns()[2]!.received[0]).toContain(
      'approved these acceptance criteria:\n\n- prints hello',
    );
  });

  it('goes to review when the work is done', async () => {
    const task = await createDiscussed();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    await runQueued();
    expect(status(task.id)).toBe('review');
  });

  it('is refused for a task that is not waiting for approval', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(() => harness.approveCriteria(task.id)).toThrow(/not waiting/);
  });
});

describe('a discussion reply without a criteria section', () => {
  beforeEach(() => scenario(session('What should it print?')));

  it('cannot be approved without criteria from the user', async () => {
    const task = await createDiscussed();
    expect(() => harness.approveCriteria(task.id)).toThrow(/write the acceptance criteria/);
  });
});

describe('a task created with criteria', () => {
  beforeEach(() => scenario(session('done')));

  it('gives the agent the criteria with the prompt', async () => {
    await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      acceptance: '- prints hi',
      queue: true,
    });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received[0]).toBe(
      'Add a greeting\n\nAcceptance criteria, agreed with the user (the work is done when all of them hold):\n- prints hi' +
        ASK_FOR_NOTES,
    );
  });
});

describe('a session cut off after approval', () => {
  beforeEach(() =>
    scenario(
      session(PROPOSAL),
      specFile,
      [[init(), assistantText('x', 10_000), { __hang: true }]],
      session('done'),
    ),
  );

  it('resumes the implementation, not the discussion', async () => {
    const task = await createDiscussed();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    harness.tick(); // the implementer starts and hangs
    await new Promise((r) => setTimeout(r, 300));
    harness.stopTask(task.id);
    await harness.waitForIdle();
    harness.queueTask(task.id);
    await runQueued();
    expect(fakeRuns()[3]!.received[0]).toContain('usage limit has reset');
  });
});
