// SPDX-License-Identifier: Apache-2.0
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { DeviceRecord, Passkey, Store } from '@harnessboard/core';

/** How long after pairing a device may register its passkey; after that it must pair again. */
export const REGISTRATION_WINDOW_MS = 10 * 60_000;

/** How long a registration or sign-in challenge stays usable. */
export const CHALLENGE_TTL_MS = 5 * 60_000;

/** Failed passkey checks in a row after which a device is refused for {@link AUTH_BLOCK_MS}. */
export const MAX_AUTH_FAILURES = 5;

/** How long a device stays refused after {@link MAX_AUTH_FAILURES} failed passkey checks. */
export const AUTH_BLOCK_MS = 15 * 60_000;

/** Name shown in the phone's passkey prompt and passkey manager. */
const RP_NAME = 'Harnessboard';

/**
 * The library's default without post-quantum ML-DSA: probing Node for it prints experimental
 * warnings on every call, and phones do not offer it yet.
 */
const ALGORITHMS = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256];

/** The relying party a ceremony is for: the remote host the phone opened, served over HTTPS. */
export interface Party {
  rpID: string;
  origin: string;
}

/**
 * The WebAuthn work, behind an interface so tests can fake the browser's signed responses.
 * Both verify methods throw when the response is not valid for the challenge and party.
 */
export interface PasskeyVerifier {
  registrationOptions(
    party: Party,
    deviceName: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(response: unknown, challenge: string, party: Party): Promise<Passkey>;
  authenticationOptions(
    party: Party,
    credentialId: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  /** Resolves to the authenticator's new signature counter. */
  verifyAuthentication(
    response: unknown,
    challenge: string,
    party: Party,
    passkey: Passkey,
  ): Promise<number>;
}

/**
 * The real verifier, using `@simplewebauthn/server`. User verification (face, fingerprint or
 * screen lock) is required, so a passkey alone without the phone's owner is not enough.
 */
export const webauthnVerifier: PasskeyVerifier = {
  registrationOptions: (party, deviceName) =>
    generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: party.rpID,
      userName: deviceName,
      attestationType: 'none',
      supportedAlgorithmIDs: ALGORITHMS,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    }),
  async verifyRegistration(response, challenge, party) {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!result.verified) throw new Error('the passkey could not be verified');
    const { id, publicKey, counter } = result.registrationInfo.credential;
    return { credentialId: id, publicKey, counter };
  },
  authenticationOptions: (party, credentialId) =>
    generateAuthenticationOptions({
      rpID: party.rpID,
      allowCredentials: [{ id: credentialId }],
      userVerification: 'required',
    }),
  async verifyAuthentication(response, challenge, party, passkey) {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
      },
      requireUserVerification: true,
    });
    if (!result.verified) throw new Error('the passkey check failed');
    return result.authenticationInfo.newCounter;
  },
};

/** A passkey step's outcome: its value, or why it was refused so the route can pick a status. */
export type PasskeyResult<T = null> =
  | { ok: true; value: T }
  | { ok: false; reason: 'has-passkey' | 'too-late' | 'no-passkey' | 'invalid' | 'blocked' };

type Refusal = Extract<PasskeyResult, { ok: false }>;

const done: PasskeyResult = { ok: true, value: null };

interface Challenge {
  kind: 'register' | 'authenticate';
  value: string;
  expiresAt: number;
}

/**
 * Passkey registration right after pairing, and the passkey check a device passes to unlock.
 * Open challenges and failure counts live in memory: a restart only means asking again.
 *
 * A device has one open challenge at a time, so a new one replaces the old one. After
 * {@link MAX_AUTH_FAILURES} failed checks in a row the device is refused for
 * {@link AUTH_BLOCK_MS}, the right passkey included. Counts are per device, since a request
 * must already carry the device's cookie to get here.
 */
export class Passkeys {
  private readonly challenges = new Map<number, Challenge>();
  private readonly failures = new Map<number, { count: number; blockedUntil: number }>();

  constructor(
    private readonly store: Store,
    private readonly verifier: PasskeyVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  /** Options for the phone's registration prompt; refused once the device has a passkey. */
  async registrationOptions(
    device: DeviceRecord,
    party: Party,
  ): Promise<PasskeyResult<PublicKeyCredentialCreationOptionsJSON>> {
    const refused = this.registrationRefusal(device);
    if (refused) return refused;
    const options = await this.verifier.registrationOptions(party, device.name);
    this.open(device.id, 'register', options.challenge);
    return { ok: true, value: options };
  }

  /** Stores the passkey from the phone's registration prompt. */
  async register(device: DeviceRecord, party: Party, response: unknown): Promise<PasskeyResult> {
    const refused = this.registrationRefusal(device);
    if (refused) return refused;
    const challenge = this.take(device.id, 'register');
    if (!challenge) return { ok: false, reason: 'invalid' };
    let passkey: Passkey;
    try {
      passkey = await this.verifier.verifyRegistration(response, challenge, party);
    } catch {
      // The phone's response did not verify; nothing is stored and the device may try again.
      return { ok: false, reason: 'invalid' };
    }
    if (!this.store.setDevicePasskey(device.id, passkey, this.now())) {
      return { ok: false, reason: 'has-passkey' };
    }
    return done;
  }

  /** Options for the phone's sign-in prompt, limited to the device's own passkey. */
  async authenticationOptions(
    device: DeviceRecord,
    party: Party,
  ): Promise<PasskeyResult<PublicKeyCredentialRequestOptionsJSON>> {
    if (!device.passkey) return { ok: false, reason: 'no-passkey' };
    const options = await this.verifier.authenticationOptions(party, device.passkey.credentialId);
    this.open(device.id, 'authenticate', options.challenge);
    return { ok: true, value: options };
  }

  /**
   * Checks the phone's signed challenge and records the check. A signature counter that did not
   * go up is refused, as it can mean a cloned authenticator; passkeys that always report 0 pass.
   */
  async verify(device: DeviceRecord, party: Party, response: unknown): Promise<PasskeyResult> {
    if (!device.passkey) return { ok: false, reason: 'no-passkey' };
    const at = this.now();
    const failed = this.failures.get(device.id);
    if (failed && at < failed.blockedUntil) return { ok: false, reason: 'blocked' };
    const challenge = this.take(device.id, 'authenticate');
    let counter: number | null = null;
    if (challenge) {
      try {
        counter = await this.verifier.verifyAuthentication(
          response,
          challenge,
          party,
          device.passkey,
        );
      } catch {
        // A response that does not verify counts as a failed check below.
      }
    }
    // The counter is compared with the stored one as it is saved, not with `device`: another
    // check may have stored a higher counter while this one waited on the verifier.
    if (counter === null || !this.store.markDeviceVerified(device.id, counter, at)) {
      this.fail(device.id, at);
      return { ok: false, reason: 'invalid' };
    }
    this.failures.delete(device.id);
    return done;
  }

  /** Counts a failed check; a block that has run out starts the count over. */
  private fail(deviceId: number, at: number): void {
    const previous = this.failures.get(deviceId);
    const count = previous && previous.count < MAX_AUTH_FAILURES ? previous.count + 1 : 1;
    this.failures.set(deviceId, {
      count,
      blockedUntil: count >= MAX_AUTH_FAILURES ? at + AUTH_BLOCK_MS : 0,
    });
  }

  private registrationRefusal(device: DeviceRecord): Refusal | null {
    if (device.passkey) return { ok: false, reason: 'has-passkey' };
    if (this.now() - device.createdAt > REGISTRATION_WINDOW_MS) {
      return { ok: false, reason: 'too-late' };
    }
    return null;
  }

  private open(deviceId: number, kind: Challenge['kind'], value: string): void {
    this.challenges.set(deviceId, { kind, value, expiresAt: this.now() + CHALLENGE_TTL_MS });
  }

  /** The device's open challenge of `kind`, used up so it cannot be replayed. */
  private take(deviceId: number, kind: Challenge['kind']): string | null {
    const open = this.challenges.get(deviceId);
    this.challenges.delete(deviceId);
    if (!open || open.kind !== kind || this.now() >= open.expiresAt) return null;
    return open.value;
  }
}
