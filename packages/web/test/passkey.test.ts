// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { passkeysAvailable } from '../src/passkey';

describe('passkeysAvailable', () => {
  it('is true in a browser with PublicKeyCredential', () => {
    expect(passkeysAvailable({ PublicKeyCredential: function PublicKeyCredential() {} })).toBe(
      true,
    );
  });

  it('is false in an in-app browser without PublicKeyCredential', () => {
    expect(passkeysAvailable({})).toBe(false);
  });

  it('is false when PublicKeyCredential is not a constructor', () => {
    expect(passkeysAvailable({ PublicKeyCredential: {} })).toBe(false);
  });
});
