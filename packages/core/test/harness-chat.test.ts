// SPDX-License-Identifier: Apache-2.0
// Chatting with a task's agent from the board, with the fake agent CLI.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
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
  dir = tempDir('chat');
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

const session = (reply: string) => [[init(), assistantText(reply, 10_000), result(reply)]];

/** A single task whose only session finished, so it waits in review. */
async function finishedTask() {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    confirmPlan: false,
    queue: true,
  });
  await harness.waitForIdle();
  return task;
}

const status = (id: number) => harness.store.getTask(id)!.status;

describe('a chat message', () => {
  beforeEach(() => scenario(session('done'), session('It prints hi.')));

  it('continues the task conversation with the message', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    const run = fakeRuns()[1]!;
    expect([run.args.includes('--resume'), run.received]).toEqual([true, ['What does it print?']]);
  });

  it('lets the agent edit files', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'Rename it');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).toContain('acceptEdits');
  });

  it('marks the task as running while the agent replies', async () => {
    const task = await finishedTask();
    expect(harness.chat(task.id, 'Rename it').status).toBe('running');
  });

  it('returns the task to the status it had', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'Rename it');
    await harness.waitForIdle();
    expect(status(task.id)).toBe('review');
  });

  it('records the end of the reply', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'Rename it');
    await harness.waitForIdle();
    expect(harness.store.lastEvent(task.id, 'chat_end')!.data).toEqual({ reason: 'completed' });
  });

  it('adds no session of its own', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'Rename it');
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)).toHaveLength(1);
  });
});

describe('a chat message that compacts the conversation', () => {
  beforeEach(() =>
    scenario(session('done'), [[init(), compactBoundary(10_000, 1_500), result('')]]),
  );

  it('keeps the compacted context size for the session', async () => {
    const task = await finishedTask();
    harness.chat(task.id, '/compact');
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)[0]!.contextTokens).toBe(1_500);
  });
});

describe('a chat reply that reports no usage', () => {
  beforeEach(() => scenario(session('done'), [[init(), result('ok')]]));

  it('keeps the context size the session had', async () => {
    const task = await finishedTask();
    harness.chat(task.id, '/status');
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)[0]!.contextTokens).toBe(10_000);
  });
});

describe('a chat reply past the compact threshold', () => {
  beforeEach(() =>
    scenario(session('done'), [
      [init(), assistantText('long', 35_000), result('ok')],
      [compactBoundary(35_000, 4_000), result('')],
    ]),
  );

  it('is compacted once the reply has ended', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'Explain everything');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.received).toEqual(['Explain everything', '/compact']);
  });
});

describe('a chat that cannot be sent', () => {
  beforeEach(() => scenario(session('done')));

  it('is refused while the task is queued', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    harness.store.updateTask(task.id, { status: 'queued' });
    expect(() => harness.chat(task.id, 'hi')).toThrow(/chat once it has stopped or finished/);
  });

  it('is refused before the task has a conversation', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    harness.store.updateTask(task.id, { status: 'stopped' });
    expect(() => harness.chat(task.id, 'hi')).toThrow(/no conversation to continue/);
  });

  it('is refused when empty', async () => {
    const task = await finishedTask();
    expect(() => harness.chat(task.id, '  ')).toThrow(/message is empty/);
  });

  it('is refused when the conversation is past its context limit', async () => {
    const task = await finishedTask();
    const [first] = harness.store.listSessions(task.id);
    harness.store.updateSessionContext(first!.id, 90_000, 100_000);
    expect(() => harness.chat(task.id, 'hi')).toThrow(/is full/);
  });
});

describe('a chat stopped by the user', () => {
  beforeEach(() => scenario(session('done'), [[init(), assistantText('x', 10_000), hang]]));

  it('returns the task to the status it had', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'Rename it');
    await new Promise((resolve) => setTimeout(resolve, 300));
    harness.stopTask(task.id);
    await harness.waitForIdle();
    expect(status(task.id)).toBe('review');
  });
});

describe('a chat cut off by a restart', () => {
  beforeEach(() => scenario(session('done')));

  it('returns the task to the status it had instead of queueing it', async () => {
    const task = await finishedTask();
    const [first] = harness.store.listSessions(task.id);
    harness.store.appendEvent(task.id, first!.id, 'chat_message', {
      text: 'hi',
      returnTo: 'review',
    });
    harness.store.updateTask(task.id, { status: 'running' });
    const restarted = new Harness(harness.config, harness.store);
    restarted.start();
    await restarted.shutdown();
    expect(status(task.id)).toBe('review');
  });
});
