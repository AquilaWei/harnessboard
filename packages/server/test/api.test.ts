// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, Harness, defaultConfig } from '@harnessboard/core';
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
  const config = { ...defaultConfig({}), dataDir: path.join(dir, 'data'), port: PORT };
  harness = Harness.open(config, new ClaudeCodeAdapter('claude-not-used'));
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

  it('returns 404 for an unknown task', async () => {
    const res = await app.request('/api/tasks/99', { headers: local });
    expect(res.status).toBe(404);
  });
});
