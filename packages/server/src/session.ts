// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from 'node:crypto';

/**
 * Header that carries the session token a passed passkey check hands out. The web keeps the
 * token in page memory, so opening the board again starts a new, locked session.
 */
export const SESSION_HEADER = 'x-harnessboard-session';

/**
 * Query parameter that carries the session token on `GET /api/events` only, because the
 * browser's EventSource cannot send headers.
 */
export const SESSION_QUERY = 'session';

/** Sessions a device keeps at once, e.g. one per open tab; opening one more ends the oldest. */
export const MAX_SESSIONS_PER_DEVICE = 8;

/**
 * Board sessions of paired remote devices. A session starts only with a passed passkey check or
 * registration, so a device that opens the board again is locked until the next check.
 * Sessions live in memory: a server restart locks every phone, which is also a new session.
 * Only token hashes are kept, so a memory dump does not hand out working tokens.
 */
export class Sessions {
  private readonly byDevice = new Map<number, string[]>();

  /** Starts a session for the device and returns its token. */
  open(deviceId: number): string {
    const token = randomBytes(32).toString('base64url');
    const hashes = [...(this.byDevice.get(deviceId) ?? []), hash(token)];
    this.byDevice.set(deviceId, hashes.slice(-MAX_SESSIONS_PER_DEVICE));
    return token;
  }

  /** Whether `token` is an open session of the device; false for a missing token. */
  has(deviceId: number, token: string | undefined): boolean {
    return token !== undefined && (this.byDevice.get(deviceId)?.includes(hash(token)) ?? false);
  }

  /** Ends every session of the device, e.g. when it is revoked and its id may be used again. */
  end(deviceId: number): void {
    this.byDevice.delete(deviceId);
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
