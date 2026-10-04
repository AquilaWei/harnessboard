// SPDX-License-Identifier: Apache-2.0
// Codex usage, read from the session logs Codex keeps, since `codex exec --json` omits it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProfile, QuotaInfo } from '@harnessboard/shared';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import { parseCodexRateLimits, readCodexQuota } from '../src/codex-quota.js';
import { CodexAdapter } from '../src/codex.js';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { tempDir } from './helpers.js';

const limits = {
  primary: { used_percent: 12.0, window_minutes: 300, resets_at: 1_791_075_016 },
  secondary: { used_percent: 40.0, window_minutes: 10_080, resets_at: 1_791_661_816 },
  rate_limit_reached_type: null,
};

describe('parseCodexRateLimits', () => {
  it('reads the five-hour and seven-day windows', () => {
    expect(parseCodexRateLimits(limits)).toEqual({
      status: 'allowed',
      fiveHourUtilization: 0.12,
      sevenDayUtilization: 0.4,
      fiveHourResetsAt: 1_791_075_016_000,
      sevenDayResetsAt: 1_791_661_816_000,
      resetsAt: 1_791_661_816_000,
    });
  });

  it('tells the windows apart by their length, not their order', () => {
    const swapped = { primary: limits.secondary, secondary: limits.primary };
    expect(parseCodexRateLimits(swapped)?.fiveHourUtilization).toBe(0.12);
  });

  it('reports a reached limit as refused', () => {
    const reached = { ...limits, rate_limit_reached_type: 'primary' };
    expect(parseCodexRateLimits(reached)?.status).toBe('rejected');
  });

  it('gives nothing without either window', () => {
    expect(parseCodexRateLimits({ primary: null, secondary: null })).toBeNull();
  });
});

describe('readCodexQuota', () => {
  const tokenCount = (used: number) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1 } },
      },
    });

  function log(home: string, day: string, name: string, lines: string[]): void {
    const dir = path.join(home, 'sessions', '2026', '10', day);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
  }

  it('reads the last reading of the newest log', () => {
    const home = tempDir('codex-home');
    log(home, '02', 'rollout-2026-10-02T10-00-00-a.jsonl', [tokenCount(5)]);
    log(home, '03', 'rollout-2026-10-03T10-00-00-b.jsonl', [tokenCount(7), tokenCount(9)]);
    expect(readCodexQuota(home)?.fiveHourUtilization).toBe(0.09);
  });

  it('looks further back when the newest log has no reading', () => {
    const home = tempDir('codex-home');
    log(home, '02', 'rollout-2026-10-02T10-00-00-a.jsonl', [tokenCount(5)]);
    log(home, '03', 'rollout-2026-10-03T10-00-00-b.jsonl', ['{"type":"turn.started"}']);
    expect(readCodexQuota(home)?.fiveHourUtilization).toBe(0.05);
  });

  it('skips a reading cut off while it was written', () => {
    const home = tempDir('codex-home');
    log(home, '03', 'rollout-2026-10-03T10-00-00-b.jsonl', [
      tokenCount(9),
      '{"payload":{"rate_limits":{"prim',
    ]);
    expect(readCodexQuota(home)?.fiveHourUtilization).toBe(0.09);
  });

  it('gives nothing when Codex has no session logs', () => {
    expect(readCodexQuota(tempDir('codex-home'))).toBeNull();
  });
});

describe('Codex usage on the board', () => {
  const quota: QuotaInfo = {
    status: 'allowed',
    fiveHourUtilization: 0.99,
    sevenDayUtilization: null,
    fiveHourResetsAt: Date.now() + 60 * 60_000,
    sevenDayResetsAt: null,
    resetsAt: null,
  };
  let harness: Harness;

  function open(): void {
    const dir = tempDir('codex-usage');
    const config = {
      ...defaultConfig({}),
      dataDir: path.join(dir, 'data'),
      agents: {
        claude: { provider: 'claude-code' as const, command: 'claude', model: null },
        codex: { provider: 'codex' as const, command: 'codex', model: null },
      },
    };
    const adapterFactory = (profile: AgentProfile) =>
      profile.provider === 'codex'
        ? Object.assign(new CodexAdapter(profile.command), {
            readQuota: () => Promise.resolve(quota),
          })
        : new ClaudeCodeAdapter(profile.command);
    harness = Harness.open(config, { adapterFactory });
  }

  afterEach(() => harness.store.close());

  it('is shown in the status', async () => {
    open();
    harness.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.status().quotas.codex).toEqual(quota);
  });

  it('pauses Codex sessions when it is nearly used up', async () => {
    open();
    harness.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.status().quotaPaused).toEqual(['codex']);
  });
});
