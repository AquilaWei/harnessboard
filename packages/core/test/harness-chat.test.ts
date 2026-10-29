// SPDX-License-Identifier: Apache-2.0
import { createHistoricalTask } from './helpers.js';
// Chatting with a task's agent from the board, with the fake agent CLI.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { CodexAdapter } from '../src/codex.js';
import {
  FAKE_CLAUDE,
  PromptArgAdapter,
  assistantText,
  compactBoundary,
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
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      other: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
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

/** A single task whose only session finished, so it waits in review. */
async function finishedTask() {
  const task = await createHistoricalTask(harness, {
    prompt: 'Add a greeting',
    repo,
    confirmPlan: false,
    queue: true,
  });
  await harness.waitForIdle();
  return task;
}

const status = (id: number) => harness.store.getTask(id)!.status;

async function runQueued(): Promise<void> {
  await harness.waitForIdle();
  harness.tick();
  await harness.waitForIdle();
}

/** A single task whose spec author also implemented it, in one conversation, now in review. */
async function specAuthoredTask() {
  const task = await createHistoricalTask(harness, { prompt: 'Add a greeting', repo, queue: true });
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  await runQueued();
  await runQueued();
  return task;
}

describe('a chat with a single task whose spec author also implemented it', () => {
  const proposal = 'I read main.js.\n## Acceptance criteria\n- prints hi';
  const specFile = [
    [
      init(),
      assistantText('spec written', 10_000),
      writeFile('docs/specs/001-add-a-greeting.md', '# Spec'),
      result('spec written'),
    ],
  ];
  beforeEach(() =>
    scenario(session(proposal), specFile, session('done'), session('It prints hi.')),
  );

  it('continues the conversation the implementer worked in', async () => {
    const task = await specAuthoredTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    const run = fakeRuns()[3]!;
    expect([run.args.includes('--resume'), run.received]).toEqual([true, ['What does it print?']]);
  });

  it('continues that conversation after the task was completed', async () => {
    const task = await specAuthoredTask();
    harness.completeTask(task.id);
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(status(task.id)).toBe('done');
  });

  it('has no implementer conversation while only the criteria were discussed', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'Add a greeting',
      repo,
      queue: true,
    });
    await harness.waitForIdle();
    expect(harness.implementerSessionId(task.id)).toBeNull();
  });
});

describe('a chat message', () => {
  beforeEach(() => scenario(session('done'), session('It prints hi.')));

  it('allows a compactable conversation above its small policy limit to answer a chat', async () => {
    const task = await finishedTask();
    harness.store.updateTask(task.id, { contextPolicy: { size: 'small' } });
    const [first] = harness.store.listSessions(task.id);
    harness.store.updateSessionContext(first!.id, 46_000, 100_000);
    harness.chat(task.id, 'What is blocking development?');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.received).toEqual(['What is blocking development?']);
  });

  it('continues the task conversation with the message', async () => {
    const task = await finishedTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    const run = fakeRuns()[1]!;
    expect([run.args.includes('--resume'), run.received]).toEqual([true, ['What does it print?']]);
  });

  it('continues a completed conversation after its worktree was removed', async () => {
    const task = await finishedTask();
    harness.completeTask(task.id);
    const completed = harness.store.getTask(task.id)!;
    execFileSync('git', ['worktree', 'remove', completed.worktreePath!], { cwd: repo });
    execFileSync('git', ['branch', '-D', completed.branch!], { cwd: repo });
    harness.store.updateTask(task.id, { worktreePath: null });
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).toContain('--resume');
    expect(status(task.id)).toBe('done');
    expect(harness.store.getTask(task.id)!.worktreePath).not.toBeNull();
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

describe('a chat after the implementer was switched to another agent', () => {
  beforeEach(() => scenario(session('done'), session('It prints hi.'), session('Yes.')));

  async function switchedTask() {
    const task = await finishedTask();
    harness.setAgents(task.id, { implementer: 'other' });
    return task;
  }

  it('is answered by the new agent', async () => {
    const task = await switchedTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id).map((s) => s.agentId)).toEqual(['claude', 'other']);
  });

  it("starts a new conversation instead of resuming the old agent's", async () => {
    const task = await switchedTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).not.toContain('--resume');
  });

  it('tells the new agent the task and the message', async () => {
    const task = await switchedTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.received[0]).toMatch(
      /Original task:\nAdd a greeting[\s\S]*What does it print\?$/,
    );
  });

  it('uses the model set for the new agent', async () => {
    const task = await switchedTask();
    harness.setAgents(task.id, { implementerModel: 'model-b' });
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(fakeRuns()[1]!.args).toContain('model-b');
  });

  it('returns the task to the status it had', async () => {
    const task = await switchedTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(status(task.id)).toBe('review');
  });

  it('is answered by the new agent when it was pending while the task was queued', async () => {
    const task = await switchedTask();
    harness.store.updateTask(task.id, { status: 'queued' });
    harness.chat(task.id, 'What does it print?');
    harness.tick();
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id).map((s) => s.agentId)).toEqual(['claude', 'other']);
  });

  it('is continued by the next chat', async () => {
    const task = await switchedTask();
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    harness.chat(task.id, 'Is that all?');
    await harness.waitForIdle();
    expect(fakeRuns()[2]!.args).toContain('--resume');
  });
});

describe('a stopped Codex task without context telemetry', () => {
  beforeEach(async () => {
    await harness.shutdown();
    harness.store.close();
    const adapter = new CodexAdapter(FAKE_CLAUDE);
    // This regression fixture exercises stored exec events; app-server resume has its own test.
    Object.defineProperty(adapter, 'createConnection', { value: undefined });
    const promptAdapter = new PromptArgAdapter(FAKE_CLAUDE);
    // Reuse the fixture's prompt transport while parsing real Codex JSON events.
    adapter.buildArgs = (spec) => promptAdapter.buildArgs(spec);
    harness = Harness.open(
      {
        ...harness.config,
        agents: {
          ...harness.config.agents,
          codex: { provider: 'codex', command: FAKE_CLAUDE, model: null },
        },
      },
      { adapterFactory: () => adapter },
    );
    scenario(
      [[{ type: 'thread.started', thread_id: 'codex-thread' }, { type: 'turn.completed' }]],
      [
        [
          { type: 'thread.started', thread_id: 'codex-thread' },
          {
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Here is the progress.' },
          },
          { type: 'turn.completed' },
        ],
      ],
    );
  });

  async function stoppedTask() {
    const task = await createHistoricalTask(harness, {
      prompt: 'Add a greeting',
      repo,
      confirmPlan: false,
      implementer: 'codex',
      queue: true,
    });
    await harness.waitForIdle();
    harness.store.updateTask(task.id, { status: 'stopped' });
    return task;
  }

  it('resumes the existing thread when the user sends a message', async () => {
    const task = await stoppedTask();
    expect(harness.store.listSessions(task.id)[0]!.contextTokens).toBe(0);
    harness.chat(task.id, 'What is the progress?');
    await harness.waitForIdle();
    expect(fakeRuns()[1]).toEqual(
      expect.objectContaining({
        args: ['--resume', 'codex-thread', '--prompt', 'What is the progress?'],
        received: ['What is the progress?'],
      }),
    );
    expect(harness.store.lastEvent(task.id, 'chat_end')!.data).toEqual({ reason: 'completed' });
    expect(status(task.id)).toBe('stopped');
  });

  it('refuses to chat when Codex did not provide a thread id', async () => {
    scenario([[{ type: 'turn.completed' }]]);
    const task = await stoppedTask();
    expect(() => harness.chat(task.id, 'hi')).toThrow(/no conversation to continue/);
  });

  it('delivers a pending message after the task stops', async () => {
    const task = await stoppedTask();
    harness.store.updateTask(task.id, { status: 'queued' });
    harness.chat(task.id, 'What is the progress?');
    harness.stopTask(task.id);
    await runQueued();
    expect(fakeRuns()[1]!.args).toEqual([
      '--resume',
      'codex-thread',
      '--prompt',
      'What is the progress?',
    ]);
    expect(harness.pendingChat(task.id)).toEqual([]);
  });

  it('still refuses a conversation whose reported context is full', async () => {
    const task = await stoppedTask();
    const [first] = harness.store.listSessions(task.id);
    harness.store.updateSessionContext(first!.id, 90_000, 100_000);
    expect(() => harness.chat(task.id, 'hi')).toThrow(/is full/);
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
    const before = harness.store.listSessions(task.id)[0]!.contextTokens;
    harness.chat(task.id, '/status');
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)[0]!.contextTokens).toBe(before);
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

  it('is refused before the task has a conversation', async () => {
    const task = await createHistoricalTask(harness, { prompt: 'x', repo, confirmPlan: false });
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
    await restarted.start();
    await restarted.shutdown();
    expect(status(task.id)).toBe('review');
  });
});

describe('a chat message written while the task is busy', () => {
  beforeEach(() => scenario(session('done'), session('It prints hi.')));

  it('waits as pending', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'What does it print?');
    expect(harness.pendingChat(task.id)).toEqual(['What does it print?']);
  });

  it('does not interrupt the running session', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'What does it print?');
    await harness.waitForIdle();
    expect(fakeRuns()).toHaveLength(1);
  });

  it('is sent once the step ends', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'What does it print?');
    await runQueued();
    expect(fakeRuns()[1]!.received).toEqual(['What does it print?']);
  });

  it('returns the task to the status the step ended with', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'What does it print?');
    await runQueued();
    expect(status(task.id)).toBe('review');
  });

  it('is no longer pending once sent', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'What does it print?');
    await runQueued();
    expect(harness.pendingChat(task.id)).toEqual([]);
  });
});

describe('several pending chat messages', () => {
  beforeEach(() => scenario(session('done'), session('ok')));

  it('are sent as one message', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'First');
    harness.chat(task.id, 'Second');
    await runQueued();
    expect(fakeRuns()[1]!.received).toEqual(['First\n\nSecond']);
  });
});

describe('a pending chat message of a queued task', () => {
  beforeEach(() => scenario(session('done'), session('It prints hi.'), session('done again')));

  async function queuedWithMessage() {
    const task = await finishedTask();
    harness.store.updateTask(task.id, { status: 'queued' });
    harness.chat(task.id, 'What does it print?');
    harness.tick();
    await harness.waitForIdle();
    return task;
  }

  it('is sent before the next workflow session', async () => {
    await queuedWithMessage();
    expect(fakeRuns()[1]!.received).toEqual(['What does it print?']);
  });

  it('leaves the task queued for its workflow', async () => {
    const task = await queuedWithMessage();
    expect(status(task.id)).toBe('queued');
  });

  it('lets the workflow continue afterwards', async () => {
    await queuedWithMessage();
    await runQueued();
    expect(fakeRuns()).toHaveLength(3);
  });
});

describe('a pending chat message of a stopped task', () => {
  beforeEach(() => scenario([[init(), assistantText('x', 10_000), hang]], session('Stopped.')));

  it('is sent once the stopped session has ended', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await vi.waitFor(() => expect(fakeRuns()).toHaveLength(1), { timeout: 10_000 });
    harness.chat(task.id, 'Why did you stop?');
    harness.stopTask(task.id);
    await runQueued();
    expect(fakeRuns()[1]!.received).toEqual(['Why did you stop?']);
  });
});

describe('cancelling pending chat messages', () => {
  beforeEach(() => scenario(session('done'), session('unexpected')));

  it('keeps them from being sent', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'Never mind');
    harness.cancelChat(task.id);
    await runQueued();
    expect(fakeRuns()).toHaveLength(1);
  });

  it('records that they were cancelled', async () => {
    const task = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      confirmPlan: false,
      queue: true,
    });
    harness.chat(task.id, 'Never mind');
    harness.cancelChat(task.id);
    expect(harness.store.lastEvent(task.id, 'chat_queue_cleared')!.data).toEqual({
      reason: 'cancelled',
    });
  });

  it('is refused when nothing is pending', async () => {
    const task = await finishedTask();
    expect(() => harness.cancelChat(task.id)).toThrow(/no pending message/);
  });
});

describe('a pending chat message that cannot be sent', () => {
  beforeEach(() => scenario(session('done')));

  it('is dropped once the task has stopped', async () => {
    const task = await finishedTask();
    const [first] = harness.store.listSessions(task.id);
    harness.store.updateSessionContext(first!.id, 90_000, 100_000);
    harness.store.updateTask(task.id, { status: 'queued' });
    harness.chat(task.id, 'hi');
    harness.store.updateTask(task.id, { status: 'stopped' });
    harness.tick();
    expect(harness.store.lastEvent(task.id, 'chat_queue_cleared')!.data).toEqual({
      reason: 'undeliverable',
      detail: `the conversation of task ${task.id} is full; continue it with hb open ${task.id}`,
    });
  });
});

describe('a pending chat message after a restart', () => {
  beforeEach(() => scenario(session('done'), session('It prints hi.')));

  it('is sent by the restarted harness', async () => {
    const task = await finishedTask();
    harness.store.appendEvent(task.id, null, 'chat_queued', { text: 'Still there?' });
    const restarted = new Harness(harness.config, harness.store);
    await restarted.start();
    await restarted.waitForIdle();
    await restarted.shutdown();
    expect(fakeRuns()[1]!.received).toEqual(['Still there?']);
  });
});
