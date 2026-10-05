// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PushSubscriptionInfo } from '@harnessboard/shared';

/** File in the data folder (`HARNESSBOARD_HOME` when set) that holds the board's VAPID keys. */
export const VAPID_FILE = 'vapid.json';

/** Longest push endpoint accepted; real ones are a few hundred characters. */
const MAX_ENDPOINT = 2048;

/** Longest `p256dh` or `auth` value accepted; real ones are under 100 characters. */
const MAX_KEY = 256;

/**
 * The board's VAPID key pair, base64url, in the form `web-push` takes: the public key is the
 * uncompressed P-256 point, the private key the 32-byte scalar.
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * The VAPID keys in `dir`, made on first use and read back afterwards, so subscriptions keep
 * working across restarts. The file is readable by its owner only, since the private key lets
 * anyone push to the paired phones. Throws when the file exists but is not valid JSON; deleting
 * it makes new keys, and every phone then has to turn notifications on again.
 */
export function loadVapidKeys(dir: string): VapidKeys {
  const file = path.join(dir, VAPID_FILE);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const keys = newVapidKeys();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  return keys;
}

function newVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // A JWK holds each coordinate and the scalar at full length, so no padding is needed.
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d! };
}

/**
 * The subscription in a `POST /api/push/subscribe` body, or null when it is not one. The board
 * will post to the endpoint, so it must be an https URL.
 */
export function parseSubscription(body: unknown): PushSubscriptionInfo | null {
  const { endpoint, keys } = (body ?? {}) as { endpoint?: unknown; keys?: unknown };
  const { p256dh, auth } = (keys ?? {}) as { p256dh?: unknown; auth?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return null;
  if (!isKey(p256dh) || !isKey(auth)) return null;
  if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== 'https:') return null;
  return { endpoint, keys: { p256dh, auth } };
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY;
}
