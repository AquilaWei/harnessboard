// SPDX-License-Identifier: Apache-2.0
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, setSession } from './api';

/**
 * Whether this browser can use passkeys at all. In-app browsers such as LINE's lack
 * `PublicKeyCredential`, and a passkey prompt there fails, so the page tells the user to open
 * it in Chrome or Safari instead.
 */
export function passkeysAvailable(
  win: { PublicKeyCredential?: unknown } = window as { PublicKeyCredential?: unknown },
): boolean {
  return typeof win.PublicKeyCredential === 'function';
}

/**
 * Creates the device's passkey right after pairing and starts a board session with it. Fails
 * when the prompt is cancelled, or when the server refuses (already has one, or paired too
 * long ago); the device stays unpaired until this succeeds.
 */
export async function registerPasskey(): Promise<void> {
  const optionsJSON = await api.passkeyOptions();
  const response = await startRegistration({ optionsJSON });
  setSession((await api.registerPasskey(response)).session);
}

/**
 * Runs the passkey prompt and starts a new board session, which unlocks the device and counts
 * as the recent check sensitive actions need. Fails when the prompt is cancelled or the server
 * refuses the answer.
 */
export async function checkPasskey(): Promise<void> {
  const optionsJSON = await api.passkeyChallenge();
  const response = await startAuthentication({ optionsJSON });
  setSession((await api.verifyPasskey(response)).session);
}
