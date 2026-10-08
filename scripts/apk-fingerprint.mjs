// SPDX-License-Identifier: Apache-2.0
// Verifies a signed APK and prints its signing certificate's SHA-256 fingerprint in the form
// the androidAppFingerprints setting takes: `node scripts/apk-fingerprint.mjs <apk>`.
// keytool -printcert -jarfile only reads v1 (JAR) signatures, and release APKs with
// minSdk 24 or higher carry only a v2 signature, so this asks apksigner instead.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAndroidSdk } from './android-check.mjs';

// Build-tools before 37 print `Signer #1 certificate …`; 37 prints `V3.0 Signer: certificate …`.
const DIGEST_LINE =
  /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer):? certificate SHA-256 digest: ([0-9a-f]{64})$/i;

/**
 * The SHA-256 certificate digests in `apksigner verify --print-certs` output, upper case with
 * a colon between bytes (`AB:CD:…`). apksigner prints them as one run of hex; the setting and
 * Digital Asset Links want the colon form. Returns an empty list when no signer line is found.
 */
export function certificateFingerprints(output) {
  const digests = output
    .split(/\r?\n/)
    .map((line) => DIGEST_LINE.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => match[1].toUpperCase().match(/../g).join(':'));
  return [...new Set(digests)];
}

/**
 * The newest build-tools version folder under `sdk` that has `tool` in it, or null when none
 * does. Versions are compared number by number, so 36.0.0 is newer than 9.0.0.
 */
export function findBuildTool(sdk, tool) {
  const root = path.join(sdk, 'build-tools');
  if (!existsSync(root)) return null;
  const versions = readdirSync(root)
    .filter((version) => existsSync(path.join(root, version, tool)))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const newest = versions.at(-1);
  return newest === undefined ? null : path.join(root, newest, tool);
}

function main(apk) {
  if (!apk) {
    console.error('usage: node scripts/apk-fingerprint.mjs <apk>');
    return 1;
  }
  const sdk = findAndroidSdk({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    exists: existsSync,
  });
  const windows = process.platform === 'win32';
  const apksigner = sdk && findBuildTool(sdk, windows ? 'apksigner.bat' : 'apksigner');
  if (!apksigner) {
    console.error(
      'apk-fingerprint: apksigner not found; set ANDROID_HOME to an SDK with build-tools.',
    );
    return 1;
  }
  // Fails (non-zero) when the APK is unsigned or any signature does not verify.
  const result = spawnSync(apksigner, ['verify', '--print-certs', apk], {
    encoding: 'utf8',
    shell: windows,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    console.error(`apk-fingerprint: ${apk} did not verify`);
    return result.status ?? 1;
  }
  const fingerprints = certificateFingerprints(result.stdout);
  if (fingerprints.length === 0) {
    console.error(`apk-fingerprint: apksigner printed no certificate for ${apk}`);
    return 1;
  }
  console.log(fingerprints.join('\n'));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv[2]);
}
