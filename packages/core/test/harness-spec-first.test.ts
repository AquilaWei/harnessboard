// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
  writeScenario,
} from './helpers.js';

let harness: Harness;
let repo: string;
const proposal = '## Acceptance criteria\n- prints hi';
beforeEach(() => {
  const dir = tempDir('spec-first');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    [
      [
        init(),
        rateLimit('allowed', 0.99, 4_000_000_000),
        assistantText(proposal, 100),
        result(proposal),
      ],
    ],
  ]);
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: { provider: 'claude-code', command: FAKE_CLAUDE, model: null } },
  });
});
afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});
it('automatically discusses a new task in Draft even with bypass flags and supplied criteria', async () => {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    acceptance: '- initial idea',
    confirmPlan: false,
    queue: false,
  });
  await harness.waitForIdle();
  expect(harness.store.getTask(task.id)).toMatchObject({
    status: 'awaiting_approval',
    deferred: true,
    confirmPlan: true,
  });
});
it('only moves an initial discussion to Pending after explicit approval', async () => {
  const task = await harness.createTask({ prompt: 'Add a greeting', repo });
  await harness.waitForIdle();
  expect(harness.approveCriteria(task.id)).toMatchObject({ status: 'pending', deferred: false });
});
it('refuses to put a stopped unapproved discussion in Pending', async () => {
  const task = await harness.createTask({ prompt: 'Add a greeting', repo });
  await harness.waitForIdle();
  harness.store.updateTask(task.id, { status: 'stopped' });
  expect(() => harness.pendTask(task.id)).toThrow(/spec approval/);
});
it('refuses to directly queue an unapproved draft', async () => {
  const task = await harness.createTask({ prompt: 'Add a greeting', repo });
  await harness.waitForIdle();
  harness.store.updateTask(task.id, { status: 'stopped' });
  harness.toDraft(task.id);
  expect(() => harness.queueTask(task.id)).toThrow(/spec approval/);
});
it('keeps a retried unapproved discussion in Draft', async () => {
  const task = await harness.createTask({ prompt: 'Add a greeting', repo });
  await harness.waitForIdle();
  harness.store.updateTask(task.id, { status: 'stopped' });
  harness.queueTask(task.id);
  expect(harness.store.getTask(task.id)?.deferred).toBe(true);
});
