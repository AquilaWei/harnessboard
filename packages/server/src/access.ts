// SPDX-License-Identifier: Apache-2.0
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { DeviceRecord, Harness } from '@harnessboard/core';

/** Header every state-changing request must carry; see {@link access}. */
export const CLIENT_HEADER = 'x-harnessboard-client';

/** Cookie that holds a paired device's token. */
export const DEVICE_COOKIE = 'hb_device';

/**
 * What {@link access} hands to the routes: the remote device that made the request, unset for a
 * local request.
 */
export interface AccessEnv {
  Variables: { device?: DeviceRecord };
}

/** A device's `last_seen_at` is written at most this often, so reads do not all become writes. */
export const TOUCH_INTERVAL_MS = 60_000;

/** Headers a reverse proxy adds; a request carrying any of them did not come from this machine. */
const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded'];

/** Paths a remote request may reach without a device cookie, besides the static web files. */
const PAIR_PATH = '/api/pair';

/** Paths a paired device without a passkey may reach: registering one, and the passkey check. */
const PASSKEY_SETUP_PATHS = /^\/api\/(passkey(\/.*)?|auth\/.*)$/;

/** A device that has not been active for longer than this is locked until a passkey check. */
export const IDLE_LOCK_MS = 30 * 60_000;

/** A sensitive route needs a passkey check no older than this. */
export const REAUTH_MS = 5 * 60_000;

/** Paths a locked device may reach: the passkey check that unlocks it. */
const UNLOCK_PATHS = /^\/api\/auth\/.*$/;

/**
 * Routes that start or steer agents, or change what the board may do or who may use it. A remote
 * device needs a passkey check within {@link REAUTH_MS} to reach them. A null method means every
 * method. Keep this the only list; docs/plans/phone-access.md (M2 step 3) names the same routes.
 */
const SENSITIVE_ROUTES: { method: string | null; path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/tasks$/ },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/permission$/ },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/plan\/(feedback|approve)$/ },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/criteria\/approve$/ },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/chat$/ },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/merge$/ },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/complete$/ },
  { method: 'DELETE', path: /^\/api\/tasks\/[^/]+$/ },
  { method: 'PUT', path: /^\/api\/tasks\/[^/]+\/agents$/ },
  { method: 'POST', path: /^\/api\/tasks\/[^/]+\/queue$/ },
  // Settings-level routes (M1 step 5).
  { method: 'PUT', path: /^\/api\/settings$/ },
  { method: 'POST', path: /^\/api\/agents$/ },
  { method: 'PUT', path: /^\/api\/tasks\/[^/]+\/auto-approve$/ },
  { method: 'PUT', path: /^\/api\/tasks\/[^/]+\/allowed-tools$/ },
  { method: null, path: /^\/api\/pairing(\/.*)?$/ },
  { method: null, path: /^\/api\/devices(\/.*)?$/ },
];

/**
 * The API can start agents that edit files and run commands, so every request is checked:
 * - the Host must be a loopback name or one of the `remoteHosts` setting, which defeats DNS
 *   rebinding; any other Host gets 403;
 * - a request is local only when its Host is loopback and no proxy forwarded it. A proxy such
 *   as `tailscale serve` connects from 127.0.0.1, so the peer address proves nothing;
 * - Tailscale Funnel (the public internet) is always refused;
 * - non-GET requests need {@link CLIENT_HEADER}. Browsers cannot add a custom header to a
 *   cross-origin request without a CORS preflight, which this server never approves;
 * - a remote request to `/api/*` needs the cookie of a paired device (401 otherwise), except
 *   pairing itself. Static files are served without one so the web can show the pairing screen;
 * - a device without a passkey is not paired yet: it may only register one or reach
 *   `/api/auth/*` (401 otherwise);
 * - a device that never passed a passkey check, or was idle for over {@link IDLE_LOCK_MS}, is
 *   locked: it may only reach `/api/auth/*` (401 `{locked: true}` otherwise);
 * - a route in {@link SENSITIVE_ROUTES} answers 401 `{reauth: true}` when the device's last
 *   passkey check is older than {@link REAUTH_MS}.
 *
 * Local requests see neither the lock nor the reauth. Remote hosts are read from the harness on
 * every request, so a settings change applies at once. `now` is injectable for the lock, the
 * reauth and the throttled `last_seen_at` / `last_active_at` writes.
 */
export function access(
  harness: Harness,
  now: () => number = Date.now,
): MiddlewareHandler<AccessEnv> {
  const port = harness.config.port;
  const loopbackHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return async (c, next) => {
    if (c.req.header('tailscale-funnel-request') !== undefined) {
      return c.json({ error: 'Tailscale Funnel is not allowed' }, 403);
    }
    const host = (c.req.header('host') ?? '').toLowerCase();
    const loopback = loopbackHosts.has(host);
    const remoteHosts = harness.config.remoteHosts.map((h) => h.toLowerCase());
    if (!loopback && !remoteHosts.includes(host)) {
      return c.json({ error: 'forbidden host' }, 403);
    }
    if (c.req.method !== 'GET' && !c.req.header(CLIENT_HEADER)) {
      return c.json({ error: `missing ${CLIENT_HEADER} header` }, 403);
    }
    const forwarded = FORWARDING_HEADERS.some((h) => c.req.header(h) !== undefined);
    const path = c.req.path;
    if ((loopback && !forwarded) || !path.startsWith('/api/') || path === PAIR_PATH) {
      return next();
    }

    const token = getCookie(c, DEVICE_COOKIE);
    const device = token ? harness.store.findDeviceByToken(token) : undefined;
    if (!device) return c.json({ error: 'this device is not paired' }, 401);
    const at = now();
    if (at - device.lastSeenAt >= TOUCH_INTERVAL_MS) harness.store.touchDevice(device.id, at);
    c.set('device', device);
    if (!device.passkey) {
      if (PASSKEY_SETUP_PATHS.test(path)) return next();
      return c.json({ error: 'this device has no passkey yet; pair it again' }, 401);
    }
    if (UNLOCK_PATHS.test(path)) return next();
    if (
      device.verifiedAt === null ||
      device.lastActiveAt === null ||
      at - device.lastActiveAt > IDLE_LOCK_MS
    ) {
      return c.json({ error: 'this device is locked', locked: true }, 401);
    }
    // Read and write happen with no await between them, so no other request can lock the device
    // in between and have this write unlock it again.
    if (at - device.lastActiveAt >= TOUCH_INTERVAL_MS)
      harness.store.markDeviceActive(device.id, at);
    const method = c.req.method;
    const sensitive = SENSITIVE_ROUTES.some(
      (r) => (r.method === null || r.method === method) && r.path.test(path),
    );
    if (sensitive && at - device.verifiedAt > REAUTH_MS) {
      return c.json({ error: 'confirm with your passkey first', reauth: true }, 401);
    }
    return next();
  };
}
