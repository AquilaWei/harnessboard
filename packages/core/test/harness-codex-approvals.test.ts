// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { makeRepo, tempDir } from './helpers.js';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
let harness: Harness;
let repo: string;
let dir: string;

beforeEach(() => {
  dir = tempDir('codex-approvals');
  repo = makeRepo();
  vi.stubEnv('FAKE_CODEX_SCENARIO', path.join(dir, 'scenario.json'));
  vi.stubEnv('FAKE_CODEX_LOG', path.join(dir, 'runs.jsonl'));
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      ...defaultConfig({}).agents,
      codex: { provider: 'codex', command: FAKE_CODEX, model: null },
    },
  });
});

afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
  vi.unstubAllEnvs();
});

function scenario(command: string, commit = false) {
  writeFileSync(
    path.join(dir, 'scenario.json'),
    JSON.stringify({
      requests: [
        { id: 42, method: 'item/commandExecution/requestApproval', params: { command }, commit },
      ],
    }),
  );
}

function runs() {
  return readFileSync(path.join(dir, 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function create(autoApprove = false) {
  return harness.createTask({
    prompt: 'Write a report and commit it',
    repo,
    confirmPlan: false,
    implementer: 'codex',
    skipPermissions: false,
    autoApprove,
    queue: true,
  });
}

describe('Codex app-server approvals in Harnessboard', () => {
  it('compacts the same thread after a stage completes', async () => {
    scenario('node report.js');
    const task = await create(true);
    await harness.waitForIdle();
    expect(runs()[0].messages.at(-1)).toEqual({
      id: 'hb:compact',
      method: 'thread/compact/start',
      params: { threadId: 'codex-thread' },
    });
    expect(harness.store.listSessions(task.id)[0]!.agentSessionId).toBe('codex-thread');
  });
  it('commits in the managed linked worktree with the git preset while auto-approve is off', async () => {
    scenario("/bin/bash -lc 'git commit -m report'", true);
    const task = await create();
    await harness.waitForIdle();
    const saved = harness.store.getTask(task.id)!;
    expect(saved.status).toBe('review');
    expect(saved.worktreePath).toBe(
      path.join(dir, 'data', 'wt', path.basename(saved.worktreePath!)),
    );
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: saved.worktreePath!,
        encoding: 'utf8',
      }).trim(),
    ).toBe('docs: add report');
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim(),
    ).toBe('init');
    expect(harness.store.lastEvent(task.id, 'permission_decision')!.data).toMatchObject({
      behavior: 'allow',
      auto: true,
    });
    expect(runs()[0].messages).toContainEqual({ id: 42, result: { decision: 'accept' } });
  });

  it('pauses for an unlisted command and forwards a manual allow-once answer', async () => {
    scenario('node report.js');
    const task = await create();
    await vi.waitFor(() =>
      expect(harness.store.getTask(task.id)!.status).toBe('awaiting_permission'),
    );
    const [request] = harness.permissionRequests(task.id);
    expect(request!.summary).toBe('node report.js');
    harness.answerPermission(task.id, { requestId: request!.requestId, behavior: 'allow' });
    await harness.waitForIdle();
    expect(runs()[0].messages).toContainEqual({ id: 42, result: { decision: 'accept' } });
  });

  it('forwards a denial without running the requested commit', async () => {
    scenario('node report.js', true);
    const task = await create();
    await vi.waitFor(() => expect(harness.permissionRequests(task.id)).toHaveLength(1));
    harness.answerPermission(task.id, {
      requestId: harness.permissionRequests(task.id)[0]!.requestId,
      behavior: 'deny',
      message: 'Do not run this',
    });
    await harness.waitForIdle();
    expect(runs()[0].messages).toContainEqual({ id: 42, result: { decision: 'decline' } });
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: harness.store.getTask(task.id)!.worktreePath!,
        encoding: 'utf8',
      }),
    ).toBe('');
  });

  it('auto-approves an ordinary request', async () => {
    scenario('node report.js');
    const task = await create(true);
    await harness.waitForIdle();
    expect(harness.permissionRequests(task.id)).toEqual([]);
    expect(runs()[0].messages).toContainEqual({ id: 42, result: { decision: 'accept' } });
  });

  it('still asks about a dangerous wrapped command while auto-approve is on', async () => {
    scenario("/bin/bash -lc 'rm -rf /'");
    const task = await create(true);
    await vi.waitFor(() => expect(harness.permissionRequests(task.id)).toHaveLength(1));
    expect(harness.permissionRequests(task.id)[0]).toMatchObject({
      risk: 'deletes the system or your home directory',
      suggestedRules: [],
    });
    harness.stopTask(task.id);
    await harness.waitForIdle();
    expect(harness.permissionRequests(task.id)).toEqual([]);
    expect(harness.store.getTask(task.id)!.status).toBe('stopped');
  });

  it('continues a stopped conversation through thread/resume', async () => {
    writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ text: 'Report finished' }));
    const task = await create();
    await harness.waitForIdle();
    harness.store.updateTask(task.id, { status: 'stopped' });
    harness.chat(task.id, 'What is the progress?');
    await harness.waitForIdle();
    expect(runs()[1].messages[2]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'codex-thread', approvalPolicy: 'on-request' },
    });
    expect(runs()[1].messages[3].params.input).toEqual([
      { type: 'text', text: 'What is the progress?' },
    ]);
    expect(harness.store.lastEvent(task.id, 'chat_end')!.data).toEqual({ reason: 'completed' });
  });
});
