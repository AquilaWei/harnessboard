// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuotaInfo } from '@harnessboard/shared';

/** How many of the newest session logs are searched for a usage reading. */
const LOGS_SEARCHED = 20;
const FIVE_HOURS_MIN = 300;
const SEVEN_DAYS_MIN = 7 * 24 * 60;

interface RateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface RateLimits {
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
  rate_limit_reached_type?: string | null;
}

/**
 * The account's usage as one `rate_limits` record of a Codex session log describes it: its
 * five-hour and seven-day windows, whichever of `primary` and `secondary` they are.
 * `null` when the record has neither window.
 */
export function parseCodexRateLimits(limits: RateLimits): QuotaInfo | null {
  const windows = [limits.primary, limits.secondary].filter(
    (w): w is RateWindow => typeof w?.used_percent === 'number',
  );
  const of = (minutes: number) => windows.find((w) => w.window_minutes === minutes) ?? null;
  const fiveHour = of(FIVE_HOURS_MIN);
  const sevenDay = of(SEVEN_DAYS_MIN);
  if (!fiveHour && !sevenDay) return null;
  const utilization = (w: RateWindow | null) => (w ? w.used_percent! / 100 : null);
  const resets = (w: RateWindow | null) => (w?.resets_at ? w.resets_at * 1000 : null);
  // The fuller window is the one that refuses requests first.
  const limiting = [fiveHour, sevenDay]
    .filter((w) => w !== null)
    .sort((a, b) => b.used_percent! - a.used_percent!)[0]!;
  return {
    status: limits.rate_limit_reached_type ? 'rejected' : 'allowed',
    fiveHourUtilization: utilization(fiveHour),
    sevenDayUtilization: utilization(sevenDay),
    fiveHourResetsAt: resets(fiveHour),
    sevenDayResetsAt: resets(sevenDay),
    resetsAt: resets(limiting),
  };
}

/**
 * The account's latest Codex usage, from the session logs Codex keeps under `codexHome`
 * (`~/.codex` unless `CODEX_HOME` says otherwise). `codex exec --json` does not report usage,
 * but every session log records it after each model call, including the user's own
 * sessions outside Harnessboard. These logs are Codex's own files, not a documented
 * interface: `null` when none is found or none can be read.
 */
export function readCodexQuota(codexHome = codexHomeDir()): QuotaInfo | null {
  for (const file of newestLogs(path.join(codexHome, 'sessions'), LOGS_SEARCHED)) {
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      continue; // removed while being read
    }
    for (const line of lines.reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const limits = (JSON.parse(line) as { payload?: { rate_limits?: RateLimits } }).payload
          ?.rate_limits;
        const quota = limits ? parseCodexRateLimits(limits) : null;
        if (quota) return quota;
      } catch {
        // a line cut off while Codex was writing it; older ones may still do
      }
    }
  }
  return null;
}

function codexHomeDir(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** The newest `limit` session logs: sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl. */
function newestLogs(dir: string, limit: number): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(current).sort().reverse(); // dates and times sort as text
    } catch {
      return;
    }
    for (const name of names) {
      if (found.length >= limit) return;
      const next = path.join(current, name);
      if (depth < 3) walk(next, depth + 1);
      else if (name.endsWith('.jsonl')) found.push(next);
    }
  };
  walk(dir, 0);
  return found;
}
