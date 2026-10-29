// SPDX-License-Identifier: Apache-2.0
// A session already running stops once its platform's usage reaches the pause level.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  createHistoricalTask,
  hang,
  init,
  makeRepo,
  rateLimit,
  result,
  tempDir,
  writeScenario,
} from './helpers.js';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const IN_AN_HOUR_SEC = Math.floor(Date.now() / 1000) + 3600;
let harness: Harness;
let repo: string;
let dir: string;

beforeEach(() => {
  dir = tempDir('quota-pause');
  repo = makeRepo();
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex-home'));
  vi.stubEnv('FAKE_CODEX_SCENARIO', path.join(dir, 'codex-scenario.json'));
  vi.stubEnv('FAKE_CODEX_LOG', path.join(dir, 'codex-runs.jsonl'));
  vi.stubEnv('FAKE_CLAUDE_LOG', path.join(dir, 'claude-runs.jsonl'));
  writeFileSync(path.join(dir, 'codex-scenario.json'), JSON.stringify({ hang: true }));
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    quotaPauseUtilization: 0.9,
    agents: {
      claude: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
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
function codexUsage(usedPercent: number): void {
  const logs = path.join(dir, 'codex-home', 'sessions', '2026', '10', '15');
  mkdirSync(logs, { recursive: true });
  const line = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: IN_AN_HOUR_SEC },
      },
    },
  });
  writeFileSync(path.join(logs, 'rollout-2026-10-15T09-00-00-a.jsonl'), line + '\n');
}

/** A Codex task whose session runs until it is stopped, at `usedPercent` when it starts. */
async function runningCodexTask(usedPercent: number) {
  codexUsage(usedPercent);
  const task = await createHistoricalTask(harness, {
    prompt: 'Write a report and commit it',
    repo,
    confirmPlan: false,
    implementer: 'codex',
    queue: true,
  });
  await vi.waitFor(() => expect(harness.store.listSessions(task.id)).toHaveLength(1));
  return task;
}

/** The next tick is due to read Codex's usage again. */
const tickAfterAMinute = () => harness.tick(Date.now() + 61_000);

it('pauses when quota changes while a recorded session is still being prepared', async () => {
  const run = harness['runOne'].bind(harness);
  harness['runOne'] = async (...args) => {
    codexUsage(95);
    await harness['readQuotas'](Date.now());
    return run(...args);
  };
  const task = await runningCodexTask(50);
  await vi.waitFor(() => expect(harness.store.getTask(task.id)!.status).toBe('waiting_quota'));
});

describe('a running Codex session whose usage reaches the pause level', () => {
  it('pauses the task for quota', async () => {
    const task = await runningCodexTask(50);
    codexUsage(95);
    tickAfterAMinute();
    await vi.waitFor(() => expect(harness.store.getTask(task.id)!.status).toBe('waiting_quota'));
  });

  it('ends the session as cut off by quota, so it continues the same conversation', async () => {
    const task = await runningCodexTask(50);
    codexUsage(95);
    tickAfterAMinute();
    await harness.waitForIdle([task.id]);
    expect(harness.store.listSessions(task.id).map((s) => s.endReason)).toEqual(['quota']);
  });
});

describe('a running Codex session below the pause level', () => {
  it('keeps running', async () => {
    const task = await runningCodexTask(50);
    codexUsage(60);
    tickAfterAMinute();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.store.getTask(task.id)!.status).toBe('running');
  });
});

describe('a running Claude session that reports usage past the pause level', () => {
  it('pauses the task for quota', async () => {
    vi.stubEnv(
      'FAKE_CLAUDE_SCENARIO',
      writeScenario(dir, [[[init(), rateLimit('allowed_warning', 0.95, IN_AN_HOUR_SEC), hang]]]),
    );
    const task = await createHistoricalTask(harness, {
      prompt: 'Write a report and commit it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await vi.waitFor(() => expect(harness.store.getTask(task.id)!.status).toBe('waiting_quota'));
  });
});

describe('a Claude session that reports usage past the pause level after its reply', () => {
  it('ends as completed', async () => {
    vi.stubEnv(
      'FAKE_CLAUDE_SCENARIO',
      writeScenario(dir, [
        [[init(), result('done'), rateLimit('allowed_warning', 0.95, IN_AN_HOUR_SEC)]],
      ]),
    );
    const task = await createHistoricalTask(harness, {
      prompt: 'Write a report and commit it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle([task.id]);
    expect(harness.store.listSessions(task.id).map((s) => s.endReason)).toEqual(['completed']);
  });
});
