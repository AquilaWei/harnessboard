// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { findAndroidSdk } from './android-check.mjs';

const nothingExists = () => false;
const everythingExists = () => true;

describe('findAndroidSdk', () => {
  it('uses ANDROID_HOME first', () => {
    const sdk = findAndroidSdk({
      env: { ANDROID_HOME: '/opt/sdk-home', ANDROID_SDK_ROOT: '/opt/sdk-root' },
      platform: 'linux',
      home: '/home/u',
      exists: everythingExists,
    });
    expect(sdk).toBe('/opt/sdk-home');
  });

  it('uses ANDROID_SDK_ROOT when ANDROID_HOME is not set', () => {
    const sdk = findAndroidSdk({
      env: { ANDROID_SDK_ROOT: '/opt/sdk-root' },
      platform: 'linux',
      home: '/home/u',
      exists: everythingExists,
    });
    expect(sdk).toBe('/opt/sdk-root');
  });

  it('keeps a set variable even when its folder is missing', () => {
    const sdk = findAndroidSdk({
      env: { ANDROID_HOME: '/typo/sdk' },
      platform: 'linux',
      home: '/home/u',
      exists: nothingExists,
    });
    expect(sdk).toBe('/typo/sdk');
  });

  it('falls back to ~/Android/Sdk on Linux', () => {
    const sdk = findAndroidSdk({
      env: {},
      platform: 'linux',
      home: '/home/u',
      exists: (p) => p === '/home/u/Android/Sdk',
    });
    expect(sdk).toBe('/home/u/Android/Sdk');
  });

  it('falls back to ~/Library/Android/sdk on macOS', () => {
    const sdk = findAndroidSdk({
      env: {},
      platform: 'darwin',
      home: '/Users/u',
      exists: (p) => p === '/Users/u/Library/Android/sdk',
    });
    expect(sdk).toBe('/Users/u/Library/Android/sdk');
  });

  it('falls back to %LOCALAPPDATA%\\Android\\Sdk on Windows', () => {
    const sdk = findAndroidSdk({
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      platform: 'win32',
      home: 'C:\\Users\\u',
      exists: (p) => p === 'C:\\Users\\u\\AppData\\Local\\Android\\Sdk',
    });
    expect(sdk).toBe('C:\\Users\\u\\AppData\\Local\\Android\\Sdk');
  });

  it('returns null when nothing is set and the default folder is missing', () => {
    const sdk = findAndroidSdk({
      env: {},
      platform: 'linux',
      home: '/home/u',
      exists: nothingExists,
    });
    expect(sdk).toBeNull();
  });
});
