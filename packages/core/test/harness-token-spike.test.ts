// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import type { HarnessConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  assistantText,
  compactBoundary,
  createHistoricalTask,
  init,
  makeRepo,
  result,
  tempDir,
  usageResult,
  writeFile,
  writeScenario,
} from './helpers.js';

let harness: Harness;
let config: HarnessConfig;
let dir: string;
let repo: string;

beforeEach(() => {
  dir = tempDir('token-spike');
  repo = makeRepo();
  vi.stubEnv('FAKE_CLAUDE_LOG', path.join(dir, 'runs.jsonl'));
  config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
      codex: {
        provider: 'codex',
        command: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
        model: null,
      },
      gemini: {
        provider: 'gemini',
        command: fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url)),
        model: null,
      },
    },
  };
  harness = Harness.open(config);
});

afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
  vi.unstubAllEnvs();
});

const call = (id: string, tokens: number) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id,
    model: 'test-model',
    content: [{ type: 'text', text: 'Working' }],
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_read_input_tokens: tokens - 20,
      cache_creation_input_tokens: 0,
    },
  },
});

function scenario(...sessions: unknown[][][]) {
  vi.stubEnv('FAKE_CLAUDE_SCENARIO', writeScenario(dir, sessions));
}

const create = (extra = {}) =>
  createHistoricalTask(harness, {
    prompt: 'Build it',
    repo,
    confirmPlan: false,
    queue: true,
    compactPct: 0,
    softPct: 80,
    hardPct: 90,
    ...extra,
  });

describe('token spike protection', () => {
  it('stops a live agent before its final result', async () => {
    scenario([[init(), call('one', 60_000), call('two', 40_001), { __hang: true }]]);
    const task = await create();
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
    expect(harness.store.listSessions(task.id)[0]?.endReason).toBe('safety_pause');
  });

  it('persists evidence including cached consumption', async () => {
    scenario([[init(), call('one', 100_001), { __hang: true }]]);
    const task = await create();
    await harness.waitForIdle();
    expect(harness.store.lastEvent(task.id, 'safety_pause')?.data).toMatchObject({
      observedTokens: 100_001,
      maxTokens: 100_000,
      windowSeconds: 60,
      source: 'claude-code',
    });
  });

  it('retains partial usage when killed before a final result', async () => {
    scenario([[init(), call('one', 100_001), { __hang: true }]]);
    const task = await create();
    await harness.waitForIdle();
    expect(harness.store.lastEvent(task.id, 'usage')?.data).toMatchObject({
      usage: {
        models: { 'test-model': { input: 10, output: 10, cacheRead: 99_981, cacheWrite: 0 } },
      },
    });
  });

  it('does not count repeated assistant messages twice', async () => {
    scenario([
      [init(), call('one', 60_000), call('one', 60_000), usageResult('done', 60_000, 0, 0.1)],
    ]);
    const task = await create();
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('review');
  });

  it('preserves work already written by the agent', async () => {
    scenario([
      [init(), writeFile('progress.txt', 'Keep this'), call('one', 100_001), { __hang: true }],
    ]);
    const task = await create();
    await harness.waitForIdle();
    const current = harness.store.getTask(task.id)!;
    expect(readFileSync(path.join(current.worktreePath!, 'progress.txt'), 'utf8')).toBe(
      'Keep this',
    );
  });

  it('blocks a subsequent workflow step when only final usage is available', async () => {
    scenario([[init(), usageResult('done', 100_001, 0, 0.1)]]);
    const task = await create({ reviewer: 'claude' });
    await harness.waitForIdle();
    harness.tick();
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)).toHaveLength(1);
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
  });

  it('allows other tasks to run after one pauses', async () => {
    scenario([[init(), call('one', 100_001), { __hang: true }]], [[init(), result('done')]]);
    const paused = await create();
    await harness.waitForIdle();
    const other = await create();
    await harness.waitForIdle();
    expect([
      harness.store.getTask(paused.id)?.status,
      harness.store.getTask(other.id)?.status,
    ]).toEqual(['paused_safety', 'review']);
  });

  it('does not automatically deliver queued chat while safety-paused', async () => {
    scenario([[init(), call('one', 100_001), { __hang: true }]]);
    const task = await create();
    await harness.waitForIdle();
    harness.chat(task.id, 'Please explain');
    harness.tick();
    await harness.waitForIdle();
    expect(harness.pendingChat(task.id)).toEqual(['Please explain']);
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
  });

  it('keeps a paused task paused after restarting the harness', async () => {
    scenario([[init(), call('one', 100_001), { __hang: true }]]);
    const task = await create();
    await harness.waitForIdle();
    await harness.shutdown();
    harness.store.close();
    harness = Harness.open(config);
    await harness.start();
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
    expect(harness.status().running).toEqual([]);
  });

  it('resets the window and subtracts old conversation usage on manual resume', async () => {
    scenario(
      [[init(), call('one', 100_001), { __hang: true }]],
      [[init(), call('two', 50_000), usageResult('done', 150_001, 0, 0.1)]],
    );
    const task = await create();
    await harness.waitForIdle();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('review');
    expect(harness.store.eventsOfKind(task.id, 'safety_pause')).toHaveLength(1);
  });

  it('pauses again when new consumption exceeds the limit after resume', async () => {
    scenario(
      [[init(), call('one', 100_001), { __hang: true }]],
      [[init(), call('two', 100_001), { __hang: true }]],
    );
    const task = await create();
    await harness.waitForIdle();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.eventsOfKind(task.id, 'safety_pause')).toHaveLength(2);
  });

  it('does not restore a chat task to review after a safety pause', async () => {
    scenario(
      [[init(), assistantText('done', 1_000), result('done')]],
      [[init(), call('one', 100_001), { __hang: true }]],
    );
    const task = await create();
    await harness.waitForIdle();
    harness.chat(task.id, 'Keep working');
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
    expect(harness.store.lastEvent(task.id, 'chat_end')?.data).toEqual({ reason: 'safety_pause' });
  });

  it('monitors usage reported at the end of compaction', async () => {
    scenario([
      [init(), assistantText('done', 35_000), usageResult('done', 10, 0, 0.01)],
      [compactBoundary(35_000, 4_000), usageResult('', 100_001, 0, 0.1)],
    ]);
    config.fallbackContextWindow = 100_000;
    const task = await create({ compactPct: 30 });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
  });

  it('leaves a task paused when protection is disabled', async () => {
    scenario([[init(), call('one', 100_001), { __hang: true }]]);
    const task = await create();
    await harness.waitForIdle();
    harness.updateSettings({ tokenSpike: { ...config.tokenSpike, enabled: false } });
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
  });

  it('allows high consumption with protection disabled', async () => {
    harness.updateSettings({ tokenSpike: { ...config.tokenSpike, enabled: false } });
    scenario([[init(), call('one', 100_001), result('done')]]);
    const task = await create();
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('review');
  });
});

describe('legacy usage baseline', () => {
  it('retains earlier consumption when the most recent historical record has no usage', async () => {
    scenario(
      [[init(), call('one', 100_001), { __hang: true }]],
      [[init(), call('two', 50_000), usageResult('done', 150_001, 0, 0.1)]],
    );
    const task = await create();
    await harness.waitForIdle();
    const session = harness.store.listSessions(task.id)[0]!;
    harness.store.appendEvent(task.id, session.id, 'usage', {
      role: 'implementer',
      agentId: 'claude',
      durationMs: 1,
      usage: null,
    });
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.eventsOfKind(task.id, 'safety_pause')).toHaveLength(1);
  });
});

describe('crash recovery of safety pauses', () => {
  it('retains the last checkpoint as the usage baseline after an interrupted shutdown', async () => {
    scenario(
      [[init(), call('one', 100_001), { __hang: true }]],
      [[init(), call('two', 50_000), usageResult('done', 150_001, 0, 0.1)]],
    );
    const task = await create();
    await harness.waitForIdle();
    harness.store.startSession('unfinished', task.id, 'implementer', 'claude', 'sess');
    harness.store.updateSessionContext('unfinished', 1_000, null);
    harness.store.appendEvent(task.id, 'unfinished', 'usage_checkpoint', {
      usage: {
        costUsd: null,
        models: {
          'test-model': { input: 100_001, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
        },
      },
    });
    await harness.shutdown();
    harness.store.close();
    harness = Harness.open(config);
    await harness.start();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(harness.store.eventsOfKind(task.id, 'safety_pause')).toHaveLength(1);
    expect(harness.store.getTask(task.id)?.status).toBe('review');
  });

  it('closes a dangling chat without restoring its previous executable status', async () => {
    scenario([[init(), call('one', 100_001), { __hang: true }]]);
    const task = await create();
    await harness.waitForIdle();
    const session = harness.store.listSessions(task.id)[0]!;
    harness.store.appendEvent(task.id, session.id, 'chat_message', {
      text: 'Working',
      returnTo: 'queued',
    });
    await harness.start();
    expect(harness.store.lastEvent(task.id, 'chat_end')?.data).toEqual({ reason: 'safety_pause' });
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
  });
});

describe('provider consumption monitoring', () => {
  it('pauses Codex from a live cumulative usage update', async () => {
    const file = path.join(dir, 'codex.json');
    vi.stubEnv('FAKE_CODEX_SCENARIO', file);
    writeFileSync(
      file,
      JSON.stringify({
        hang: true,
        tokenUsage: {
          total: { inputTokens: 100_000, cachedInputTokens: 90_000, outputTokens: 1 },
          last: { inputTokens: 1_000 },
        },
      }),
    );
    const task = await create({ implementer: 'codex' });
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
    expect(harness.store.lastEvent(task.id, 'safety_pause')?.data).toMatchObject({
      observedTokens: 100_001,
      source: 'codex',
    });
  });

  it('pauses Gemini at turn end before starting its reviewer', async () => {
    const file = path.join(dir, 'gemini.json');
    vi.stubEnv('FAKE_GEMINI_SCENARIO', file);
    writeFileSync(
      file,
      JSON.stringify({
        runs: [
          [
            { type: 'init', session_id: 'gemini-thread' },
            { type: 'message', role: 'assistant', content: 'done' },
            {
              type: 'result',
              status: 'success',
              stats: { input_tokens: 100_000, output_tokens: 1 },
            },
          ],
        ],
      }),
    );
    const task = await create({ implementer: 'gemini', reviewer: 'claude' });
    await harness.waitForIdle();
    harness.tick();
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)?.status).toBe('paused_safety');
    expect(harness.store.listSessions(task.id)).toHaveLength(1);
  });
});
