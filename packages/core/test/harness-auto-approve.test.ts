// SPDX-License-Identifier: Apache-2.0
// Global tool rules and auto-approve, with the fake agent CLI asking for permission.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { FAKE_CLAUDE, askBash, init, makeRepo, result, tempDir, writeScenario } from './helpers.js';

interface FakeRun {
  args: string[];
  received: unknown[];
}

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('auto');
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

async function waitForStatus(id: number, status: string): Promise<void> {
  while (harness.store.getTask(id)!.status !== status) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const create = (autoApprove = false) =>
  harness.createTask({ prompt: 'Run it', repo, confirmPlan: false, autoApprove, queue: true });

const ALLOWED = { answer: { behavior: 'allow', updatedInput: { command: 'node hello.js' } } };

describe('an auto-approving task', () => {
  it('allows a tool that is not risky without asking', async () => {
    scenario([[init(), askBash('r1', 'node hello.js', 'node *'), result('done')]]);
    const task = await create(true);
    await harness.waitForIdle();
    expect([fakeRuns()[0]!.received[1], harness.store.getTask(task.id)!.status]).toEqual([
      ALLOWED,
      'review',
    ]);
  });

  it('records the decision as automatic', async () => {
    scenario([[init(), askBash('r1', 'node hello.js', 'node *'), result('done')]]);
    const task = await create(true);
    await harness.waitForIdle();
    expect(harness.store.lastEvent(task.id, 'permission_decision')!.data).toMatchObject({
      behavior: 'allow',
      auto: true,
    });
  });

  it('still asks about a dangerous tool, saying why', async () => {
    scenario([[init(), askBash('r1', 'rm -rf ~', 'rm *'), result('done')]]);
    const task = await create(true);
    await waitForStatus(task.id, 'awaiting_permission');
    expect(harness.permissionRequests(task.id)[0]!.risk).toBe(
      'deletes the system or your home directory',
    );
  });

  it('offers no rule to remember for a dangerous tool', async () => {
    scenario([[init(), askBash('r1', 'rm -rf ~', 'rm *'), result('done')]]);
    const task = await create(true);
    await waitForStatus(task.id, 'awaiting_permission');
    expect(harness.permissionRequests(task.id)[0]!.suggestedRules).toEqual([]);
  });

  it('allows a command the old risky list stopped, such as git push', async () => {
    scenario([[init(), askBash('r1', 'git push origin main', 'git push *'), result('done')]]);
    const task = await create(true);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });
});

describe('a task created without saying', () => {
  it('auto-approves', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    expect(task.permission.autoApprove).toBe(true);
  });
});

describe('a task that does not auto-approve', () => {
  it('asks without naming a risk', async () => {
    scenario([[init(), askBash('r1', 'node hello.js', 'node *'), result('done')]]);
    const task = await create();
    await waitForStatus(task.id, 'awaiting_permission');
    expect(harness.permissionRequests(task.id)[0]!.risk).toBeNull();
  });
});

describe('turning auto-approve on', () => {
  it('is stored on the task', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    expect(harness.setAutoApprove(task.id, true).permission.autoApprove).toBe(true);
  });
});

describe('global tool rules', () => {
  it('are passed to every session', async () => {
    harness.updateSettings({ allowedTools: ['Bash(make *)'] });
    scenario([[init(), result('done')]]);
    await create();
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.args).toContain('Bash(make *)');
  });

  it('allow a request they cover without asking', async () => {
    harness.updateSettings({ allowedTools: ['Bash(node *)'] });
    scenario([[init(), askBash('r1', 'node hello.js', 'node *'), result('done')]]);
    await create();
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.received[1]).toEqual(ALLOWED);
  });

  it('are rejected when one is not a tool rule', () => {
    expect(() => harness.updateSettings({ allowedTools: ['allow npm please'] })).toThrow(
      /not a tool rule/,
    );
  });
});

describe('allowing a request for every task', () => {
  beforeEach(() => scenario([[init(), askBash('r1', 'node hello.js', 'node *'), result('done')]]));

  it('adds the rule to the global rules', async () => {
    const task = await create();
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, {
      requestId: 'r1',
      behavior: 'allow',
      rules: ['Bash(node *)'],
      scope: 'global',
    });
    await harness.waitForIdle();
    expect(harness.settings().allowedTools).toEqual(['Bash(node *)']);
  });

  it("leaves the task's own rules as they were", async () => {
    const task = await create();
    const before = harness.store.getTask(task.id)!.permission.allowedTools;
    await waitForStatus(task.id, 'awaiting_permission');
    harness.answerPermission(task.id, {
      requestId: 'r1',
      behavior: 'allow',
      rules: ['Bash(node *)'],
      scope: 'global',
    });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.permission.allowedTools).toEqual(before);
  });
});
