// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { deviceNameFromUserAgent, pairCodeFromHash, pairUrl } from '../src/phone';

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

describe('deviceNameFromUserAgent', () => {
  it('reads the model from an Android user agent', () => {
    expect(
      deviceNameFromUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
      ),
    ).toBe('Pixel 9');
  });

  it('drops the Build suffix older Android user agents carry', () => {
    expect(
      deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 8.0.0; SM-G950F Build/R16NW)'),
    ).toBe('SM-G950F');
  });

  it('names an iPhone without a model', () => {
    expect(deviceNameFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(
      'iPhone',
    );
  });

  it('falls back to Phone when the user agent says nothing', () => {
    expect(deviceNameFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Phone');
  });

  it('falls back to Phone for the generic Android model K', () => {
    expect(deviceNameFromUserAgent('Mozilla/5.0 (Linux; Android 10; K) Chrome/126.0')).toBe(
      'Phone',
    );
  });
});
