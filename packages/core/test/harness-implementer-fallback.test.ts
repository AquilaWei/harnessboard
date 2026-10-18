// SPDX-License-Identifier: Apache-2.0
// Another agent implements while the implementer's platform is out of quota.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateTaskInput } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  createHistoricalTask,
  errorResult,
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

function open(defaultImplementerFallback: string | null = null, quotaRetryMinutes = 15): void {
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    quotaPauseUtilization: 0.9,
    quotaRetryMinutes,
    defaultImplementerFallback,
    agents: {
      claude: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
      codex: { provider: 'codex', command: FAKE_CODEX, model: null },
    },
  });
}

beforeEach(() => {
  dir = tempDir('implementer-fallback');
  repo = makeRepo();
  vi.stubEnv('CODEX_HOME', path.join(dir, 'codex-home'));
  vi.stubEnv('FAKE_CODEX_SCENARIO', path.join(dir, 'codex-scenario.json'));
  vi.stubEnv('FAKE_CODEX_LOG', path.join(dir, 'codex-runs.jsonl'));
  vi.stubEnv('FAKE_CLAUDE_LOG', path.join(dir, 'claude-runs.jsonl'));
  codexScenario({ hang: true });
});

afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
  vi.unstubAllEnvs();
});

function codexScenario(scenario: unknown): void {
  writeFileSync(path.join(dir, 'codex-scenario.json'), JSON.stringify(scenario));
}

const claudeSessions = (...sessions: unknown[][]) =>
  vi.stubEnv(
    'FAKE_CLAUDE_SCENARIO',
    writeScenario(
      dir,
      sessions.map((lines) => [lines]),
    ),
  );

const refused = () => [init(), rateLimit('rejected', 1, IN_AN_HOUR_SEC), errorResult(429)];

const task = (input: Partial<CreateTaskInput> = {}) =>
  createHistoricalTask(harness, {
    prompt: 'Write a report and commit it',
    repo,
    confirmPlan: false,
    queue: true,
    implementerFallback: 'codex',
    ...input,
  });

const agentsOf = (id: number) => harness.store.listSessions(id).map((s) => s.agentId);

/** Ticks as the board's timer does until the task's sessions were run by `agents`. */
const ranBy = (id: number, agents: string[]) =>
  vi.waitFor(() => {
    harness.tick();
    expect(agentsOf(id)).toEqual(agents);
  });

/** Ticks as the board's timer does until the task has the status. */
const reaches = (id: number, status: string) =>
  vi.waitFor(() => {
    harness.tick();
    expect(harness.store.getTask(id)!.status).toBe(status);
  });

describe('an implementer refused for quota, with a fallback', () => {
  beforeEach(() => {
    open();
    claudeSessions(refused());
  });

  it('goes on with the fallback instead of waiting', async () => {
    const { id } = await task();
    await ranBy(id, ['claude', 'codex']);
  });

  it('records the switch', async () => {
    const { id } = await task();
    await ranBy(id, ['claude', 'codex']);
    expect(harness.store.lastEvent(id, 'agent_switch')!.data).toEqual({
      from: 'claude',
      to: 'codex',
    });
  });
});

describe('an implementer refused for quota without a fallback', () => {
  it('waits for the quota', async () => {
    open();
    claudeSessions(refused());
    const { id } = await task({ implementerFallback: null });
    await reaches(id, 'waiting_quota');
  });
});

describe('an implementer refused without usage figures', () => {
  it('goes on with the fallback', async () => {
    open();
    claudeSessions([init(), errorResult(429)]);
    const { id } = await task();
    await ranBy(id, ['claude', 'codex']);
  });
});

describe('an implementer past the pause level', () => {
  beforeEach(() => open());

  it('hands a running session over to the fallback', async () => {
    claudeSessions([init(), rateLimit('allowed_warning', 0.95, IN_AN_HOUR_SEC), hang]);
    const { id } = await task();
    await ranBy(id, ['claude', 'codex']);
  });

  it('lets a queued task start with the fallback', async () => {
    claudeSessions([init(), result('done'), rateLimit('allowed_warning', 0.95, IN_AN_HOUR_SEC)]);
    const first = await task({ implementerFallback: null });
    await harness.waitForIdle([first.id]);
    const { id } = await task();
    await ranBy(id, ['codex']);
  });
});

describe('a fallback that runs out of quota too', () => {
  beforeEach(() => {
    // Without usage logs, Codex's refusal is retried after three hours.
    open(null, 180);
    claudeSessions(refused(), [init(), hang]);
    codexScenario({ error: { message: 'You have hit your usage limit.' } });
  });

  it('waits for the sooner of the two resets', async () => {
    const { id } = await task();
    await ranBy(id, ['claude', 'codex']);
    await reaches(id, 'waiting_quota');
    expect(harness.store.getTask(id)!.resumeAt).toBe(IN_AN_HOUR_SEC * 1000);
  });

  it('goes back to the implementer once its quota is back', async () => {
    const { id } = await task();
    await ranBy(id, ['claude', 'codex']);
    await reaches(id, 'waiting_quota');
    harness.tick(IN_AN_HOUR_SEC * 1000 + 1);
    await ranBy(id, ['claude', 'codex', 'claude']);
  });
});

describe('a fallback session', () => {
  it("runs with its own profile's model, not the implementer's", async () => {
    open();
    claudeSessions(refused());
    codexScenario({ text: 'done' });
    const { id } = await task({ implementerModel: 'claude-opus-test', implementerEffort: 'max' });
    await ranBy(id, ['claude', 'codex']);
    await harness.waitForIdle([id]);
    const runs = path.join(dir, 'codex-runs.jsonl');
    expect(existsSync(runs) && readFileSync(runs, 'utf8')).not.toMatch(/claude-opus-test|max/);
  });
});

describe('creating a task', () => {
  it('takes the configured fallback', async () => {
    open('codex');
    const created = await createHistoricalTask(harness, { prompt: 'x', repo });
    expect(created.agents.implementerFallback).toBe('codex');
  });

  it('leaves the fallback off when asked to', async () => {
    open('codex');
    const created = await task({ implementerFallback: null, queue: false });
    expect(created.agents.implementerFallback).toBeNull();
  });

  it('leaves out a configured fallback that is the implementer itself', async () => {
    open('codex');
    const created = await createHistoricalTask(harness, {
      prompt: 'x',
      repo,
      implementer: 'codex',
    });
    expect(created.agents.implementerFallback).toBeNull();
  });

  it('refuses the implementer as its own fallback', async () => {
    open();
    await expect(task({ implementerFallback: 'claude', queue: false })).rejects.toThrow(
      /another agent than the implementer/,
    );
  });

  it('refuses a fallback that is not configured', async () => {
    open();
    await expect(task({ implementerFallback: 'ghost', queue: false })).rejects.toThrow(
      /"ghost" is not configured/,
    );
  });
});

describe('changing a task’s fallback', () => {
  it('saves it', async () => {
    open();
    const created = await task({ implementerFallback: null, queue: false });
    const updated = harness.setAgents(created.id, { implementerFallback: 'codex' });
    expect(updated.agents.implementerFallback).toBe('codex');
  });
});
