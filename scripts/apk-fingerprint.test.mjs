// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findAndroidSdk } from './android-check.mjs';
import { certificateFingerprints, findBuildTool } from './apk-fingerprint.mjs';

const SCRIPT = fileURLToPath(new URL('./apk-fingerprint.mjs', import.meta.url));

describe('certificateFingerprints', () => {
  it('turns the signer digest into upper-case bytes separated by colons', () => {
    const output = [
      'Signer #1 certificate DN: CN=harnessboard',
      'Signer #1 certificate SHA-256 digest: 311e20596d5b0c2479d4037095267697' +
        '26aaae2631e6a28dd5ede91dece300b2',
      'Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567',
    ].join('\n');
    expect(certificateFingerprints(output)).toEqual([
      '31:1E:20:59:6D:5B:0C:24:79:D4:03:70:95:26:76:97:' +
        '26:AA:AE:26:31:E6:A2:8D:D5:ED:E9:1D:EC:E3:00:B2',
    ]);
  });

  it('returns nothing when the output has no signer digest', () => {
    expect(certificateFingerprints('DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF')).toEqual(
      [],
    );
  });
});

describe('findBuildTool', () => {
  it('picks the newest build-tools version that has the tool, comparing numbers', () => {
    const sdk = mkdtempSync(path.join(tmpdir(), 'hb-sdk-'));
    for (const version of ['9.0.0', '36.0.0', '37.0.0']) {
      mkdirSync(path.join(sdk, 'build-tools', version), { recursive: true });
    }
    writeFileSync(path.join(sdk, 'build-tools', '9.0.0', 'apksigner'), '');
    writeFileSync(path.join(sdk, 'build-tools', '36.0.0', 'apksigner'), '');
    expect(findBuildTool(sdk, 'apksigner')).toBe(
      path.join(sdk, 'build-tools', '36.0.0', 'apksigner'),
    );
  });

  it('returns null when the SDK has no build-tools', () => {
    const sdk = mkdtempSync(path.join(tmpdir(), 'hb-sdk-'));
    expect(findBuildTool(sdk, 'apksigner')).toBeNull();
  });
});

// The end-to-end check needs the Android SDK (aapt2, apksigner, a platform) and keytool;
// GitHub's ubuntu runners have both, so CI runs it.
const sdk = findAndroidSdk({
  env: process.env,
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
});
const aapt2 = sdk && findBuildTool(sdk, 'aapt2');
const apksigner = sdk && findBuildTool(sdk, 'apksigner');
const platforms =
  sdk && existsSync(path.join(sdk, 'platforms')) ? readdirSync(path.join(sdk, 'platforms')) : [];
const keytool = spawnSync('keytool', ['-help']).error === undefined;
const toolsMissing = !aapt2 || !apksigner || platforms.length === 0 || !keytool;

/** Builds an empty APK with minSdk 24 and signs it with a new key using only scheme v2. */
function signedV2OnlyApk(dir) {
  writeFileSync(
    path.join(dir, 'AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" ' +
      'package="dev.harnessboard.fingerprinttest"><uses-sdk android:minSdkVersion="24"/></manifest>',
  );
  const androidJar = path.join(sdk, 'platforms', platforms[0], 'android.jar');
  const unsigned = path.join(dir, 'unsigned.apk');
  execFileSync(aapt2, [
    'link',
    '-o',
    unsigned,
    '--manifest',
    path.join(dir, 'AndroidManifest.xml'),
    '-I',
    androidJar,
  ]);
  const keystore = path.join(dir, 'test.jks');
  execFileSync(
    'keytool',
    [
      '-genkeypair',
      '-keystore',
      keystore,
      '-storetype',
      'PKCS12',
      '-storepass',
      'test-pass',
      '-alias',
      'test',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '1',
      '-dname',
      'CN=test',
    ],
    { stdio: 'ignore' },
  );
  const signed = path.join(dir, 'signed.apk');
  execFileSync(
    apksigner,
    [
      'sign',
      '--ks',
      keystore,
      '--ks-pass',
      'pass:test-pass',
      '--v1-signing-enabled',
      'false',
      '--v2-signing-enabled',
      'true',
      '--out',
      signed,
      unsigned,
    ],
    { stdio: 'ignore' },
  );
  const listing = execFileSync(
    'keytool',
    ['-list', '-v', '-keystore', keystore, '-storepass', 'test-pass'],
    {
      encoding: 'utf8',
    },
  );
  return { apk: signed, keyFingerprint: /SHA256: ([0-9A-F:]+)/.exec(listing)[1] };
}

describe('apk-fingerprint.mjs', () => {
  // Regression: keytool -printcert -jarfile says "Not a signed jar file" for this APK.
  it.skipIf(toolsMissing)(
    'prints the signing key fingerprint of an APK signed only with scheme v2',
    () => {
      const { apk, keyFingerprint } = signedV2OnlyApk(mkdtempSync(path.join(tmpdir(), 'hb-apk-')));
      const out = execFileSync(process.execPath, [SCRIPT, apk], {
        encoding: 'utf8',
        env: { ...process.env, ANDROID_HOME: sdk },
      });
      expect(out).toBe(`${keyFingerprint}\n`);
    },
    60_000,
  );

  it.skipIf(toolsMissing)(
    'fails on an unsigned APK',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'hb-apk-'));
      const unsigned = path.join(dir, 'unsigned.apk');
      writeFileSync(
        path.join(dir, 'AndroidManifest.xml'),
        '<manifest package="dev.harnessboard.unsigned"/>',
      );
      execFileSync(aapt2, [
        'link',
        '-o',
        unsigned,
        '--manifest',
        path.join(dir, 'AndroidManifest.xml'),
        '-I',
        path.join(sdk, 'platforms', platforms[0], 'android.jar'),
      ]);
      const result = spawnSync(process.execPath, [SCRIPT, unsigned], {
        env: { ...process.env, ANDROID_HOME: sdk },
      });
      expect(result.status).not.toBe(0);
    },
    60_000,
  );
});
