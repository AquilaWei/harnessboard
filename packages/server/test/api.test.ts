// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, defaultConfig } from '@harnessboard/core';
import type { Task } from '@harnessboard/shared';
import { CLIENT_HEADER, createApi, localOnly } from '../src/api.js';

const PORT = 4999;
let harness: Harness;
let app: Hono;
let repo: string;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hb-api-'));
  repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-qm',
    'init',
  ]);
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    port: PORT,
    agents: {
      claude: { provider: 'claude-code' as const, command: 'claude-not-used', model: null },
      checker: { provider: 'claude-code' as const, command: 'node', model: 'opus' },
    },
  };
  harness = Harness.open(config);
  app = new Hono();
  app.use('*', localOnly(PORT));
  app.route('/api', createApi(harness));
});

afterEach(() => harness.store.close());

const local = { host: `127.0.0.1:${PORT}` };
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(url, {
    method: 'POST',
    headers: { ...local, 'content-type': 'application/json', ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });

describe('localOnly', () => {
  it('rejects requests whose Host is not loopback', async () => {
    const res = await app.request('/api/tasks', { headers: { host: `evil.example:${PORT}` } });
    expect(res.status).toBe(403);
  });

  it('rejects state-changing requests without the client header', async () => {
    const res = await post('/api/tasks', { prompt: 'x', repo });
    expect(res.status).toBe(403);
  });

  it('allows reads from loopback without the client header', async () => {
    const res = await app.request('/api/tasks', { headers: local });
    expect(res.status).toBe(200);
  });
});

describe('tasks API', () => {
  it('creates a backlog task when queue is false', async () => {
    const res = await post('/api/tasks', { prompt: 'Fix it', repo }, { [CLIENT_HEADER]: 'test' });
    expect([res.status, ((await res.json()) as { status: string }).status]).toEqual([
      201,
      'backlog',
    ]);
  });

  it('returns the error message for an invalid request', async () => {
    const res = await post(
      '/api/tasks',
      { prompt: 'x', repo, softPct: 90, hardPct: 50 },
      { [CLIENT_HEADER]: 'test' },
    );
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid context thresholds/);
  });

  it('replaces the allowed tools of a task', async () => {
    const created = await post('/api/tasks', { prompt: 'x', repo }, { [CLIENT_HEADER]: 'test' });
    const { id } = (await created.json()) as { id: number };
    const res = await app.request(`/api/tasks/${id}/allowed-tools`, {
      method: 'PUT',
      headers: { ...local, 'content-type': 'application/json', [CLIENT_HEADER]: 'test' },
      body: JSON.stringify({ rules: ['WebSearch'] }),
    });
    expect(((await res.json()) as Task).permission.allowedTools).toEqual(['WebSearch']);
  });

  it('rejects allowed tools that are not a list of strings', async () => {
    const created = await post('/api/tasks', { prompt: 'x', repo }, { [CLIENT_HEADER]: 'test' });
    const { id } = (await created.json()) as { id: number };
    const res = await app.request(`/api/tasks/${id}/allowed-tools`, {
      method: 'PUT',
      headers: { ...local, 'content-type': 'application/json', [CLIENT_HEADER]: 'test' },
      body: JSON.stringify({ rules: 'WebSearch' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a permission answer without a valid behavior', async () => {
    const created = await post('/api/tasks', { prompt: 'x', repo }, { [CLIENT_HEADER]: 'test' });
    const { id } = (await created.json()) as { id: number };
    const res = await post(
      `/api/tasks/${id}/permission`,
      { requestId: 'r1', behavior: 'maybe' },
      { [CLIENT_HEADER]: 'test' },
    );
    expect(((await res.json()) as { error: string }).error).toMatch(/"allow" or "deny"/);
  });

  it('rejects a permission answer when nothing is waiting', async () => {
    const created = await post('/api/tasks', { prompt: 'x', repo }, { [CLIENT_HEADER]: 'test' });
    const { id } = (await created.json()) as { id: number };
    const res = await post(
      `/api/tasks/${id}/permission`,
      { requestId: 'r1', behavior: 'allow' },
      { [CLIENT_HEADER]: 'test' },
    );
    expect(((await res.json()) as { error: string }).error).toMatch(
      /no pending permission request/,
    );
  });

  it('deletes a task that is not running', async () => {
    const created = await post('/api/tasks', { prompt: 'x', repo }, { [CLIENT_HEADER]: 'test' });
    const { id } = (await created.json()) as { id: number };
    const res = await app.request(`/api/tasks/${id}`, {
      method: 'DELETE',
      headers: { ...local, [CLIENT_HEADER]: 'test' },
    });
    expect([res.status, await res.json(), harness.store.getTask(id)]).toEqual([
      200,
      { id, branch: null },
      undefined,
    ]);
  });

  it('returns 404 when deleting an unknown task', async () => {
    const res = await app.request('/api/tasks/99', {
      method: 'DELETE',
      headers: { ...local, [CLIENT_HEADER]: 'test' },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown task', async () => {
    const res = await app.request('/api/tasks/99', { headers: local });
    expect(res.status).toBe(404);
  });

  it('creates a loop task with its verify command', async () => {
    const res = await post(
      '/api/tasks',
      { prompt: 'Build it', repo, mode: 'loop', verifyCommand: 'npm test' },
      { [CLIENT_HEADER]: 'test' },
    );
    const task = (await res.json()) as { mode: string; verifyCommand: string };
    expect([task.mode, task.verifyCommand]).toEqual(['loop', 'npm test']);
  });
});

describe('loop progress', () => {
  const features = [
    { id: 'F1', description: 'a', passes: true },
    { id: 'F2', description: 'b', passes: true },
    { id: 'F3', description: 'c', passes: false },
  ];
  const verify = { command: 'npm test', ok: false, exitCode: 1, timedOut: false, output: 'x' };

  async function loopTaskWithSnapshot(): Promise<number> {
    const task = await harness.createTask({
      prompt: 'Build it',
      repo,
      mode: 'loop',
      verifyCommand: 'npm test',
    });
    harness.store.appendEvent(task.id, null, 'features', { features, verify, verifiedPassing: 1 });
    return task.id;
  }

  it('reports claimed and verified features in the task list', async () => {
    await loopTaskWithSnapshot();
    const res = await app.request('/api/tasks', { headers: local });
    const [task] = (await res.json()) as { loop: unknown }[];
    expect(task!.loop).toEqual({ total: 3, claimed: 2, verified: 1, lastVerify: verify });
  });

  it('includes the latest feature list in the task detail', async () => {
    const id = await loopTaskWithSnapshot();
    const res = await app.request(`/api/tasks/${id}`, { headers: local });
    expect(((await res.json()) as { features: unknown }).features).toEqual(features);
  });
});

describe('agents API', () => {
  it('reports which agent CLIs run', async () => {
    const res = await app.request('/api/agents', { headers: local });
    const agents = (await res.json()) as { id: string; ok: boolean }[];
    expect(agents.map((a) => [a.id, a.ok])).toEqual([
      ['claude', false],
      ['checker', true],
    ]);
  });
});

describe('reviewed tasks', () => {
  it('creates a task with the chosen reviewer', async () => {
    const res = await post(
      '/api/tasks',
      { prompt: 'Build it', repo, reviewer: 'checker' },
      { [CLIENT_HEADER]: 'test' },
    );
    const task = (await res.json()) as { agents: { reviewer: string } };
    expect(task.agents.reviewer).toBe('checker');
  });

  it('rejects a reviewer that is not a profile', async () => {
    const res = await post(
      '/api/tasks',
      { prompt: 'Build it', repo, reviewer: 'ghost' },
      { [CLIENT_HEADER]: 'test' },
    );
    expect(((await res.json()) as { error: string }).error).toMatch(/"ghost" is not configured/);
  });

  it('lists review steps in the timeline', async () => {
    const task = await harness.createTask({ prompt: 'Build it', repo, reviewer: 'checker' });
    const request = { round: 1, since: 'a', head: 'b', status: '' };
    const review = {
      round: 1,
      agentId: 'checker',
      verdict: 'changes',
      findings: '- add a test',
      head: 'b',
    };
    harness.store.appendEvent(task.id, null, 'review_request', request, 1000);
    harness.store.appendEvent(task.id, null, 'review', review, 2000);
    const res = await app.request(`/api/tasks/${task.id}/timeline`, { headers: local });
    expect(await res.json()).toEqual([
      { kind: 'review_request', ts: 1000, request },
      { kind: 'review', ts: 2000, review },
    ]);
  });

  it('shows the latest review on the task', async () => {
    const task = await harness.createTask({ prompt: 'Build it', repo, reviewer: 'checker' });
    const review = { round: 1, agentId: 'checker', verdict: 'approve', findings: '', head: 'b' };
    harness.store.appendEvent(task.id, null, 'review', review);
    const res = await app.request(`/api/tasks/${task.id}`, { headers: local });
    expect(((await res.json()) as { lastReview: unknown }).lastReview).toEqual(review);
  });
});

describe('folders API', () => {
  it('lists subfolders and marks git repositories', async () => {
    const parent = path.dirname(repo);
    const res = await app.request(`/api/folders?path=${encodeURIComponent(parent)}`, {
      headers: local,
    });
    const listing = (await res.json()) as { entries: { name: string; isRepo: boolean }[] };
    expect(listing.entries).toContainEqual(expect.objectContaining({ name: 'repo', isRepo: true }));
  });

  it('reports whether a typed path is a usable repository', async () => {
    const res = await app.request(`/api/folders/inspect?path=${encodeURIComponent(repo)}`, {
      headers: local,
    });
    expect(await res.json()).toEqual({
      path: repo,
      exists: true,
      repoRoot: repo,
      hasCommits: true,
    });
  });
});

describe('plan API', () => {
  it('shows no features before the planner has run', async () => {
    const task = await harness.createTask({ prompt: 'Build it', repo, mode: 'loop' });
    const res = await app.request(`/api/tasks/${task.id}/plan`, { headers: local });
    expect(await res.json()).toEqual({
      features: null,
      error: null,
      suggestedVerify: null,
      questions: [],
      reply: null,
      approved: false,
    });
  });

  it('refuses feedback while the plan is not waiting for approval', async () => {
    const task = await harness.createTask({ prompt: 'Build it', repo, mode: 'loop' });
    const res = await post(
      `/api/tasks/${task.id}/plan/feedback`,
      { message: 'more tests' },
      { [CLIENT_HEADER]: 'test' },
    );
    expect(((await res.json()) as { error: string }).error).toMatch(
      /not waiting for plan approval/,
    );
  });
});
