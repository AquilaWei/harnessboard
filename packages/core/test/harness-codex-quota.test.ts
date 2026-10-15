// SPDX-License-Identifier: Apache-2.0
// Codex reports no usage while it runs; the harness reads it from Codex's session logs.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { createHistoricalTask, makeRepo, tempDir } from './helpers.js';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const IN_AN_HOUR_SEC = Math.floor(Date.now() / 1000) + 3600;
const AN_HOUR_AGO_SEC = Math.floor(Date.now() / 1000) - 3600;
let harness: Harness;
let repo: string;
let dir: string;

beforeEach(() => {
  dir = tempDir('codex-quota-wait');
  repo = makeRepo();
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex-home'));
  vi.stubEnv('FAKE_CODEX_SCENARIO', path.join(dir, 'scenario.json'));
  vi.stubEnv('FAKE_CODEX_LOG', path.join(dir, 'runs.jsonl'));
  writeFileSync(
    path.join(dir, 'scenario.json'),
    JSON.stringify({ error: { message: 'You have hit your usage limit. Try again at 12:36 PM.' } }),
  );
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

/** Records five-hour usage in a Codex session log, as Codex does after each model call. */
function codexUsage(usedPercent: number, resetsAtSec: number): void {
  const logs = path.join(dir, 'codex-home', 'sessions', '2026', '10', '15');
  mkdirSync(logs, { recursive: true });
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: resetsAtSec },
      },
    },
  });
  writeFileSync(path.join(logs, 'rollout-2026-10-15T09-00-00-a.jsonl'), line + '\n');
}

function createCodexTask(queue: boolean) {
  return createHistoricalTask(harness, {
    prompt: 'Write a report and commit it',
    repo,
    confirmPlan: false,
    implementer: 'codex',
    queue,
  });
}

describe('a restart while Codex is nearly used up', () => {
  it('does not start a queued Codex task', async () => {
    codexUsage(99, IN_AN_HOUR_SEC);
    const task = await createCodexTask(false);
    harness.store.updateTask(task.id, { status: 'queued' });
    await harness.start();
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)).toEqual([]);
  });
});

describe('a Codex session that hits the usage limit', () => {
  it('waits until the reset time Codex recorded', async () => {
    codexUsage(80, IN_AN_HOUR_SEC);
    const task = await createCodexTask(true);
    await harness.waitForIdle();
    const stored = harness.store.getTask(task.id)!;
    expect([stored.status, stored.resumeAt]).toEqual(['waiting_quota', IN_AN_HOUR_SEC * 1000]);
  });

  it('waits the retry interval when the recorded reset has already passed', async () => {
    codexUsage(80, AN_HOUR_AGO_SEC);
    const before = Date.now();
    const task = await createCodexTask(true);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.resumeAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
  });
});

describe('a lower pause level for Codex alone', () => {
  it('keeps a queued Codex task from starting at a usage under the shared level', async () => {
    harness.config.quotaPauseByProvider = { codex: 0.5 };
    codexUsage(60, IN_AN_HOUR_SEC);
    const task = await createCodexTask(false);
    harness.store.updateTask(task.id, { status: 'queued' });
    await harness.start();
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)).toEqual([]);
  });
});
