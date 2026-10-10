// SPDX-License-Identifier: Apache-2.0
import { tailscaleHost } from '@harnessboard/core';

/** How long a found Tailscale name is reused; the name rarely changes. */
const FOUND_TTL_MS = 5 * 60_000;
/** How long "no Tailscale" is reused, so starting it is noticed soon without a spawn per request. */
const MISSING_TTL_MS = 5_000;

/**
 * This machine's Tailscale name for the host check of {@link access}, which runs on every
 * request and so cannot start `tailscale` each time. Concurrent callers share one lookup.
 */
export function cachedTailscaleHost(
  detect: () => Promise<string | null> = () => tailscaleHost(),
  now: () => number = Date.now,
): () => Promise<string | null> {
  let last: { host: string | null; at: number } | null = null;
  let pending: Promise<string | null> | null = null;
  return async () => {
    if (last && now() - last.at < (last.host ? FOUND_TTL_MS : MISSING_TTL_MS)) return last.host;
    pending ??= detect()
      .then((host) => {
        last = { host, at: now() };
        return host;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
