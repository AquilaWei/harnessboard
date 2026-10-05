// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { pairCodeFromHash, pairHost, pairUrl, serveCommand } from '../src/phone';

describe('pairUrl', () => {
  it('puts the code in the hash of an https address on the remote host', () => {
    expect(pairUrl('pc.tail1234.ts.net', 'AbC-_12')).toBe(
      'https://pc.tail1234.ts.net/#pair=AbC-_12',
    );
  });

  it('escapes characters that would end the code', () => {
    expect(pairUrl('pc.tail1234.ts.net', 'a&b')).toBe('https://pc.tail1234.ts.net/#pair=a%26b');
  });
});

describe('pairCodeFromHash', () => {
  it('reads the code from a pairing hash', () => {
    expect(pairCodeFromHash('#pair=AbC-_12')).toBe('AbC-_12');
  });

  it('decodes an escaped code', () => {
    expect(pairCodeFromHash('#pair=a%26b')).toBe('a&b');
  });

  it('returns null for an empty hash', () => {
    expect(pairCodeFromHash('')).toBeNull();
  });

  it('returns null for a hash without a code', () => {
    expect(pairCodeFromHash('#task=3')).toBeNull();
  });

  it('returns null for an empty code', () => {
    expect(pairCodeFromHash('#pair=')).toBeNull();
  });
});

describe('serveCommand', () => {
  it('serves the board port in the background', () => {
    expect(serveCommand(4317)).toBe('tailscale serve --bg 4317');
  });
});

describe('pairHost', () => {
  it('prefers the Tailscale name when it is saved', () => {
    expect(pairHost(['other.example', 'PC.tail1234.ts.net'], 'pc.tail1234.ts.net')).toBe(
      'PC.tail1234.ts.net',
    );
  });

  it('falls back to the first saved host when the Tailscale name is not saved', () => {
    expect(pairHost(['other.example'], 'pc.tail1234.ts.net')).toBe('other.example');
  });

  it('uses the first saved host when Tailscale is not found', () => {
    expect(pairHost(['other.example'], null)).toBe('other.example');
  });

  it('returns null when no host is saved', () => {
    expect(pairHost([], 'pc.tail1234.ts.net')).toBeNull();
  });
});
