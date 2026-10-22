// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Harness } from '../src/harness.js';
import { defaultConfig } from '../src/config.js';
import { pmQuestion, pmWork } from '../src/pm.js';
import {
  FAKE_CLAUDE,
  askBash,
  init,
  result,
  makeRepo,
  tempDir,
  writeScenario,
  assistantText,
} from './helpers.js';

let harness: Harness;
let repo: string;
let dir: string;
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  __pm: { name, arguments: args },
});
const turn = (id: string, ...actions: unknown[]) => [
  [init(id), ...actions, assistantText('Step complete', 100), result('Step complete')],
];
const spec = () =>
  turn(
    'pm-thread',
    tool('propose_spec', {
      criteria: '- greeting works',
      message: 'Build and verify the greeting.',
    }),
  );
const dispatch = () =>
  tool('dispatch', {
    agentId: 'claude',
    goal: 'Implement greeting',
    acceptance: 'Greeting works',
    scope: 'greeting.txt',
    access: 'edit',
  });
const accept = () =>
  tool('accept', {
    head: '$head',
    architecture: 'Inspected the committed diff and surrounding code.',
    functionality: 'Greeting matches the approved criterion.',
    verification: 'Inspected worker test evidence.',
    summary: 'Greeting complete.',
  });

beforeEach(() => {
  dir = tempDir('pm');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'runs.jsonl');
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

it('creates a PM task and waits for explicit specification approval', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [spec()]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  expect(harness.store.getTask(task.id)).toMatchObject({
    workflow: 'pm',
    status: 'awaiting_approval',
  });
  expect(pmQuestion(harness.store, task.id)?.kind).toBe('spec');
  expect(pmWork(harness.store, task.id)).toEqual([]);
});

it('dispatches after approval and waits for user confirmation after PM acceptance', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    spec(),
    turn('pm-thread', dispatch(), tool('wait')),
    turn(
      'worker-thread',
      { __write: { path: 'greeting.txt', content: 'hello\n' } },
      { __commit: 'feat: add greeting' },
    ),
    turn('pm-thread', accept()),
  ]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  await harness.waitForIdle();
  expect(harness.store.getTask(task.id)?.status).toBe('review');
  expect(pmWork(harness.store, task.id)[0]).toMatchObject({
    status: 'completed',
    execution: 'managed',
  });
  expect(harness.store.lastEvent(task.id, 'pm_acceptance')?.data).toMatchObject({
    summary: 'Greeting complete.',
  });
  expect(harness.store.listSessions(task.id).map((s) => s.role)).toEqual(['pm', 'worker']);
  harness.completeTask(task.id);
  expect(harness.store.getTask(task.id)?.status).toBe('done');
  expect(harness.taskOperations(task.id).merge).toMatchObject({ visible: true, enabled: true });
  await expect(harness.mergeTask(task.id)).resolves.toMatchObject({ status: 'merged' });
  expect(harness.taskOperations(task.id).merge.visible).toBe(false);
});

it('rejects an attempted dispatch before approval without starting a worker', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [turn('pm-thread', dispatch())]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  expect(pmWork(harness.store, task.id)).toEqual([]);
  expect(harness.store.getTask(task.id)?.status).toBe('failed');
});

it('resumes the PM for feedback without resending unchanged task rules', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [spec(), spec()]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  harness.planFeedback(task.id, 'Use a short greeting.');
  await harness.waitForIdle();
  const runs = readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(runs[1].args).toContain('--resume');
  expect(runs[1].received[0]).toContain('Use a short greeting.');
  expect(runs[1].received[0]).not.toContain('sole user-facing coordinator');
});

it('routes ordinary follow-up questions to the PM without approving a specification', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    turn('pm-thread', tool('ask_user', { message: 'Which greeting?' })),
    spec(),
  ]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  expect(() => harness.approveCriteria(task.id, 'hello')).toThrow('No PM specification');
  harness.chat(task.id, 'Say hello.');
  await harness.waitForIdle();
  expect(pmQuestion(harness.store, task.id)?.kind).toBe('spec');
  expect(harness.store.listSessions(task.id)).toHaveLength(1);
});

it('rejects a PM profile that cannot provide a task-scoped tool bridge', async () => {
  harness.config.agents.gemini = { provider: 'gemini', command: 'gemini', model: null };
  await expect(
    harness.createTask({
      prompt: 'x',
      repo,
      pm: {
        agentId: 'gemini',
        model: null,
        effort: null,
        workers: [{ agentId: 'claude', models: [null] }],
      },
    }),
  ).rejects.toThrow('local Claude Code or Codex');
  expect(harness.store.listTasks()).toEqual([]);
});

it('resumes the same worker for PM-requested fixes', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    spec(),
    turn('pm-thread', dispatch(), tool('wait')),
    turn(
      'worker-thread',
      { __write: { path: 'greeting.txt', content: 'hello\n' } },
      { __commit: 'feat: add greeting' },
    ),
    turn(
      'pm-thread',
      tool('continue_work', { id: '$work', message: 'Use a capital H.' }),
      tool('wait'),
    ),
    turn(
      'worker-thread',
      { __write: { path: 'greeting.txt', content: 'Hello\n' } },
      { __commit: 'fix: capitalize greeting' },
    ),
    turn('pm-thread', accept()),
  ]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  await harness.waitForIdle();
  expect(harness.store.getTask(task.id)?.status).toBe('review');
  expect(harness.store.listSessions(task.id).map((s) => s.role)).toEqual(['pm', 'worker']);
  const runs = readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(runs).toHaveLength(6);
  const correction = runs.find((run) => run.received[0].startsWith('Use a capital H.'));
  expect(correction.args).toContain('worker-thread');
  expect(pmWork(harness.store, task.id)).toHaveLength(1);
});

it('wakes the PM to grant a worker permission once without a deadlock', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    spec(),
    turn('pm-thread', dispatch(), tool('wait')),
    turn('worker-thread', askBash('worker-request', 'make test', 'make test')),
    turn(
      'pm-thread',
      tool('permission', {
        requestId: '$permission',
        behavior: 'allow',
        reason: 'Necessary verification within the approved scope.',
      }),
      tool('wait'),
    ),
    turn('pm-thread', accept()),
  ]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  await harness.waitForIdle();
  expect(harness.store.getTask(task.id)?.status).toBe('review');
  expect(harness.store.lastEvent(task.id, 'permission_decision')?.data).toMatchObject({
    actor: 'pm',
    behavior: 'allow',
    rules: [],
  });
  expect(harness.store.getTask(task.id)?.permission.allowedTools).not.toContain('Bash(make test)');
});

it('reopens specification discussion in the PM conversation without dispatching', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [spec(), spec()]);
  const task = await harness.createTask({ prompt: 'Add greeting', repo });
  await harness.waitForIdle();
  const tick = vi.spyOn(harness, 'tick').mockImplementation(() => {});
  harness.approveCriteria(task.id);
  harness.toDraft(task.id);
  tick.mockRestore();
  harness.planTask(task.id, 'Discuss a different greeting first.');
  await harness.waitForIdle();
  expect(pmQuestion(harness.store, task.id)?.kind).toBe('spec');
  expect(pmWork(harness.store, task.id)).toEqual([]);
  const runs = readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(runs[1].received[0]).toContain('Discuss a different greeting first.');
});

it('rejects closing an idle PM task before specification approval', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    turn('pm-thread', tool('ask_user', { message: 'Please verify the result.' })),
  ]);
  const task = await harness.createTask({ prompt: 'Check greeting', repo });
  await harness.waitForIdle();
  expect(harness.store.getTask(task.id)?.status).toBe('awaiting_approval');
  expect(() => harness.completeTask(task.id)).toThrow('Specification');
});

it('keeps merge available while an approved PM waits for confirmation and after closing', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    turn('pm-thread', tool('ask_user', { message: 'Please verify.' })),
  ]);
  const task = await harness.createTask({ prompt: 'Check greeting', repo });
  await harness.waitForIdle();
  harness.store.appendEvent(task.id, null, 'criteria_approved', { criteria: 'Greeting works' });
  await expect(harness.mergeTask(task.id)).rejects.toThrow('already has every commit');
  harness.completeTask(task.id);
  await expect(harness.mergeTask(task.id)).rejects.toThrow('already has every commit');
});

it('disables PM operations while queued and rejects both APIs', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [spec()]);
  const task = await harness.createTask({ prompt: 'Check greeting', repo });
  await harness.waitForIdle();
  harness.store.appendEvent(task.id, null, 'criteria_approved', { criteria: 'Greeting works' });
  harness.store.updateTask(task.id, { status: 'queued' });
  expect(harness.taskOperations(task.id).merge).toMatchObject({ visible: true, enabled: false });
  expect(harness.taskOperations(task.id).complete).toMatchObject({ visible: true, enabled: false });
  await expect(harness.mergeTask(task.id)).rejects.toThrow('running or queued');
  expect(() => harness.completeTask(task.id)).toThrow('running or queued');
});

it('preserves report validity across conversation and detects a later commit', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
    turn('pm-thread', tool('ask_user', { message: 'Please verify.' })),
    turn('pm-thread', tool('ask_user', { message: 'Anything else?' })),
  ]);
  const task = await harness.createTask({ prompt: 'Check greeting', repo });
  await harness.waitForIdle();
  const cwd = harness.store.getTask(task.id)!.worktreePath!;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  harness.store.appendEvent(task.id, null, 'criteria_approved', { criteria: 'Greeting works' });
  harness.store.appendEvent(task.id, null, 'pm_acceptance', { head, summary: 'Verified' });
  expect(harness.pmAcceptanceCurrent(task.id)).toBe(true);
  harness.chat(task.id, 'Explain the result');
  await harness.waitForIdle();
  expect(harness.pmAcceptanceCurrent(task.id)).toBe(true);
  expect(harness.taskOperations(task.id).merge.enabled).toBe(true);
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'New work',
    ],
    { cwd },
  );
  expect(harness.pmAcceptanceCurrent(task.id)).toBe(false);
  expect(harness.store.lastEvent(task.id, 'pm_acceptance')?.data).toEqual({
    head,
    summary: 'Verified',
  });
});

it('disables merge when the PM worktree is missing', async () => {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [spec()]);
  const task = await harness.createTask({ prompt: 'Check greeting', repo });
  await harness.waitForIdle();
  harness.store.appendEvent(task.id, null, 'criteria_approved', { criteria: 'Greeting works' });
  harness.store.updateTask(task.id, { worktreePath: path.join(dir, 'missing') });
  expect(harness.taskOperations(task.id).merge).toEqual({
    visible: true,
    enabled: false,
    reason: 'task 1 worktree is missing',
  });
  await expect(harness.mergeTask(task.id)).rejects.toThrow('worktree is missing');
});
