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

/**
 * Routes that change what the board may do or who may use it. A remote device must not reach
 * them without a fresh passkey check, which does not exist yet, so they are refused to every
 * remote device. TODO: F6 in feature_list.json - move these into `SENSITIVE_ROUTES` behind the
 * passkey reauth check.
 */
const SETTINGS_ROUTES: { method: string | null; path: RegExp }[] = [
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
 *   `/api/auth/*` (401 otherwise).
 *
 * Remote hosts are read from the harness on every request, so a settings change applies at once.
 * `now` is injectable for the `last_seen_at` throttle.
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
    if (!device.passkey && !PASSKEY_SETUP_PATHS.test(path)) {
      return c.json({ error: 'this device has no passkey yet; pair it again' }, 401);
    }
    const method = c.req.method;
    if (
      SETTINGS_ROUTES.some((r) => (r.method === null || r.method === method) && r.path.test(path))
    ) {
      return c.json({ error: 'this can only be changed on the computer running the board' }, 403);
    }
    return next();
  };
}
