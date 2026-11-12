// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { LocalAiService } from '../src/localai.js';
import { draftCommit, draftSlug } from '../src/localai-drafts.js';
import { FAKE_CLAUDE, makeRepo, tempDir } from './helpers.js';

const services: LocalAiService[] = [];
let dir: string;
const binary = fileURLToPath(new URL('./fixtures/fake-localai.mjs', import.meta.url));
beforeEach(() => {
  dir = tempDir('localai-drafts');
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.unstubAllEnvs();
});

function ai(answer: string, hang = false, enabled = true): LocalAiService {
  const file = path.join(dir, 'scenario.json');
  writeFileSync(
    file,
    JSON.stringify({
      hang,
      lines: [
        { type: 'start', data: {} },
        { type: 'delta', data: { channel: 'answer', text: answer } },
        { type: 'usage', data: {} },
        { type: 'done', data: {} },
      ],
    }),
  );
  vi.stubEnv('FAKE_LOCALAI_SCENARIO', file);
  const service = new LocalAiService({
    enabled,
    command: binary,
    models: { pricing: 'p', slug: 's', commit: 'c' },
  });
  services.push(service);
  return service;
}

it('accepts a valid English title and ASCII slug', async () => {
  expect(await draftSlug(ai('{"title":"Fix login","slug":"fix-login"}'), '修正登入')).toEqual({
    englishTitle: 'Fix login',
    branchSlug: 'fix-login',
  });
});

it.each([
  '{"title":"修正登入","slug":"fix-login"}',
  '{"title":"Fix\\nlogin","slug":"fix-login"}',
  '{"title":"Fix login","slug":"BAD"}',
  '{"title":"Fix login","slug":"../bad"}',
  'not JSON',
])('falls back for invalid slug output: %s', async (answer) => {
  expect(await draftSlug(ai(answer), '修正登入')).toBeNull();
});

it('falls back on timeout', async () => {
  expect(await draftSlug(ai('{}', true), '修正登入', 30)).toBeNull();
});

it('falls back when disabled without asking a model', async () => {
  expect(await draftSlug(ai('{}', false, false), '修正登入')).toBeNull();
});

it('includes a busy queue in the caller deadline', async () => {
  const service = ai('{}', true);
  const controller = new AbortController();
  const pricing = service.request('pricing', 'long request', {
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  try {
    expect(await draftSlug(service, '修正登入', 30)).toBeNull();
    expect(service.status().running?.useCase).toBe('pricing');
  } finally {
    controller.abort();
    await pricing;
  }
});

it('persists translated metadata during task creation while preserving the original title', async () => {
  const config = defaultConfig({});
  config.dataDir = dir;
  config.agents.claude = { provider: 'claude-code', command: FAKE_CLAUDE, model: null };
  const harness = Harness.open(config);
  const request = vi.spyOn(harness.localAi, 'request').mockResolvedValue({
    status: 'ok',
    answer: '{"title":"Fix login","slug":"fix-login"}',
    reasoning: '',
  });
  try {
    const task = await harness.createTask({
      prompt: '修正登入',
      title: '修正登入',
      repo: makeRepo(),
    });
    expect(harness.store.getTask(task.id)).toMatchObject({
      title: '修正登入',
      englishTitle: 'Fix login',
      branchSlug: 'fix-login',
    });
    expect(request).toHaveBeenCalledWith(
      'slug',
      expect.any(String),
      expect.objectContaining({ timeoutMs: 6_000 }),
    );
    await harness.waitForIdle();
    const ready = harness.store.getTask(task.id)!;
    expect(ready.branch).toBe(`hb/${task.id}-fix-login`);
  } finally {
    await harness.shutdown();
    harness.store.close();
  }
});

it('does not request a translation for an existing ASCII slug', async () => {
  const config = defaultConfig({});
  config.dataDir = dir;
  config.agents.claude = { provider: 'claude-code', command: FAKE_CLAUDE, model: null };
  const harness = Harness.open(config);
  const request = vi.spyOn(harness.localAi, 'request');
  try {
    await harness.createTask({ prompt: 'Fix login', repo: makeRepo() });
    expect(request).not.toHaveBeenCalled();
  } finally {
    await harness.shutdown();
    harness.store.close();
  }
});

it('accepts a valid integration message and changelog bullet', async () => {
  expect(
    await draftCommit(
      ai('{"commit":"feat: improve login","changelog":"- Login is easier"}'),
      'Improve login',
      ['login.ts'],
    ),
  ).toEqual({ commit: 'feat: improve login', changelogDraft: '- Login is easier' });
});

it.each([
  '{"commit":"revert: improve login","changelog":"- Login is easier"}',
  '{"commit":"feat: 改善登入","changelog":"- Login is easier"}',
  '{"commit":"feat: improve\\nlogin","changelog":"- Login is easier"}',
  '{"commit":"feat: improve login","changelog":"Not a bullet"}',
  'not JSON',
])('falls back for an invalid integration draft: %s', async (answer) => {
  expect(await draftCommit(ai(answer), 'Improve login', ['login.ts'])).toBeNull();
});

it('falls back on integration draft timeout', async () => {
  expect(await draftCommit(ai('{}', true), 'Improve login', ['login.ts'], 30)).toBeNull();
});

it('falls back when integration drafts are disabled', async () => {
  expect(await draftCommit(ai('{}', false, false), 'Improve login', ['login.ts'])).toBeNull();
});
