// SPDX-License-Identifier: Apache-2.0
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PairingCode } from '@harnessboard/shared';

/** How long a pairing code shown on the computer stays usable. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

/** Failed pairing attempts in a row after which pairing is blocked until a new code is made. */
export const MAX_PAIR_FAILURES = 5;

/** Why {@link Pairing.redeem} refused a code. */
export type RedeemResult = 'ok' | 'invalid' | 'blocked';

/**
 * The one-time code a phone sends to `POST /api/pair`. Kept in memory only: a restart drops
 * any open code, which is harmless because the computer can show a new one at once.
 *
 * Only one code is open at a time; making a new one replaces the old one. After
 * {@link MAX_PAIR_FAILURES} wrong, expired or used codes in a row every attempt is refused,
 * the right code included, until the computer makes a new code. All remote requests reach the
 * board from the proxy's address, so the count is shared rather than kept per client.
 */
export class Pairing {
  private code: { value: Buffer; expiresAt: number } | null = null;
  private failures = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** A new 128-bit code; the previous one stops working and the failure count starts over. */
  create(): PairingCode {
    const code = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.code = { value: Buffer.from(code), expiresAt };
    this.failures = 0;
    return { code, expiresAt };
  }

  /** Uses up `code` when it is the open one and not expired; any other code counts as a failure. */
  redeem(code: string): RedeemResult {
    if (this.failures >= MAX_PAIR_FAILURES) return 'blocked';
    const open = this.code;
    const given = Buffer.from(code);
    if (
      open &&
      this.now() < open.expiresAt &&
      given.length === open.value.length &&
      timingSafeEqual(given, open.value)
    ) {
      this.code = null;
      this.failures = 0;
      return 'ok';
    }
    this.failures += 1;
    return 'invalid';
  }
}

/** A new device token: 32 random bytes, the value of the device cookie. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}
