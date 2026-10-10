// SPDX-License-Identifier: Apache-2.0
// Planning in Draft, waiting as pending until quota allows, and moving tasks by hand.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  assistantText,
  init,
  makeRepo,
  rateLimit,
  result,
  tempDir,
  writeFile,
  writeScenario,
} from './helpers.js';

const FUTURE_SEC = 4_000_000_000;
const PROPOSAL = 'I read main.js.\n## Acceptance criteria\n- prints hi';

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('pending');
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

/** A discussion session that also reports the five-hour quota nearly used up. */
const discussion = (reply: string, utilization: number) => [
  [
    init(),
    rateLimit('allowed', utilization, FUTURE_SEC),
    assistantText(reply, 10_000),
    result(reply),
  ],
];
const specFile = [
  [
    init(),
    assistantText('spec written', 10_000),
    writeFile('docs/specs/001-add-a-greeting.md', '# Spec'),
    result('spec written'),
  ],
];
const worked = [[init(), assistantText('done', 10_000), result('done')]];

const status = (id: number) => harness.store.getTask(id)!.status;

/** The agent's quota reads as used up until `FUTURE_SEC`. */
function useUpQuota(): void {
  (harness as unknown as { quotas: Map<string, unknown> }).quotas.set('claude-code', {
    status: 'rejected',
    fiveHourUtilization: 1,
    sevenDayUtilization: null,
    fiveHourResetsAt: FUTURE_SEC * 1000,
    sevenDayResetsAt: null,
    resetsAt: FUTURE_SEC * 1000,
  });
}

/** Runs queued sessions until the task has nothing left to start (spec, then work). */
async function runAll(now = Date.now()): Promise<void> {
  for (let i = 0; i < 3; i++) {
    harness.tick(now);
    await harness.waitForIdle();
  }
}

async function plannedAndApproved() {
  const task = await harness.createTask({ prompt: 'Add a greeting', repo });
  harness.planTask(task.id);
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  await harness.waitForIdle();
  return task;
}

describe('planning a draft', () => {
  it('waits for approval while the task is still marked as planned in Draft', async () => {
    scenario(discussion(PROPOSAL, 0.1));
    const task = await harness.createTask({ prompt: 'Add a greeting', repo });
    harness.planTask(task.id);
    await harness.waitForIdle();
    expect([status(task.id), harness.store.getTask(task.id)!.deferred]).toEqual([
      'awaiting_approval',
      true,
    ]);
  });

  it('is refused for a task that is not a draft', async () => {
    useUpQuota();
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    expect(() => harness.planTask(task.id)).toThrow(/only a draft/);
  });
});

describe('approving a planned draft', () => {
  it('leaves it pending while quota is used up', async () => {
    scenario(discussion(PROPOSAL, 0.97), specFile, worked);
    const task = await plannedAndApproved();
    expect(status(task.id)).toBe('pending');
  });

  it('starts it once the quota window has reset', async () => {
    scenario(discussion(PROPOSAL, 0.97), specFile, worked);
    const task = await plannedAndApproved();
    await runAll(FUTURE_SEC * 1000 + 1);
    expect(status(task.id)).toBe('review');
  });

  it('starts it at once when quota is free', async () => {
    scenario(discussion(PROPOSAL, 0.1), specFile, worked);
    const task = await plannedAndApproved();
    await runAll();
    expect(status(task.id)).toBe('review');
  });

  it('is not planned again after it was picked', async () => {
    scenario(discussion(PROPOSAL, 0.1), specFile, worked);
    const task = await plannedAndApproved();
    expect(harness.store.getTask(task.id)!.deferred).toBe(false);
  });
});

describe('picking pending tasks', () => {
  it('starts one at a time within the concurrency limit', async () => {
    scenario(worked);
    const first = await harness.createTask({ prompt: 'One', repo, acceptance: '- a' });
    const second = await harness.createTask({ prompt: 'Two', repo, acceptance: '- b' });
    useUpQuota();
    harness.pendTask(first.id);
    harness.pendTask(second.id);
    harness.tick(FUTURE_SEC * 1000 + 1);
    expect([status(first.id), status(second.id)]).toEqual(['queued', 'pending']);
  });
});

describe('moving tasks by hand', () => {
  it('refuses to put a draft without a spec in pending', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(() => harness.pendTask(task.id)).toThrow(/plan it first/);
  });

  it('takes a stopped task back to draft', async () => {
    useUpQuota();
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    harness.stopTask(task.id);
    expect(harness.toDraft(task.id).status).toBe('backlog');
  });

  it('marks a stopped task done without merging', async () => {
    useUpQuota();
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    harness.stopTask(task.id);
    expect(harness.completeTask(task.id).status).toBe('done');
  });

  it('marks a failed task done', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    harness.store.updateTask(task.id, { status: 'failed' });
    expect(harness.completeTask(task.id).status).toBe('done');
  });

  it('refuses to mark a draft done', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(() => harness.completeTask(task.id)).toThrow(/only a task in review, failed or stopped/);
  });

  it('takes a done task back to draft', async () => {
    scenario(worked);
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    harness.completeTask(task.id);
    expect(harness.toDraft(task.id).status).toBe('backlog');
  });

  it('reopens a done task as pending', async () => {
    scenario(worked);
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    await harness.waitForIdle();
    harness.completeTask(task.id);
    useUpQuota();
    expect(harness.pendTask(task.id).status).toBe('pending');
  });

  it('refuses to move a running task to draft', async () => {
    scenario([[init(), assistantText('working', 1)]]);
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false, queue: true });
    expect(() => harness.toDraft(task.id)).toThrow(/cannot be moved|running/);
    harness.stopTask(task.id);
  });

  it('stops a pending task', async () => {
    scenario(discussion(PROPOSAL, 0.97), specFile, worked);
    const task = await plannedAndApproved();
    expect(harness.stopTask(task.id).status).toBe('stopped');
  });
});
