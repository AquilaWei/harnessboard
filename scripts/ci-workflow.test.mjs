// SPDX-License-Identifier: Apache-2.0
// Checks the parts of the CI workflow that ship the Android APK; actionlint is not installed here.
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const workflow = load(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
);
const android = workflow.jobs.android;

describe('CI workflow', () => {
  it('runs only when a v* tag is pushed', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } });
  });

  it('builds the Android app on ubuntu after the tests pass', () => {
    expect(android['runs-on']).toBe('ubuntu-latest');
    expect(android.needs).toBe('test');
  });

  it('pins the JDK the Gradle toolchain uses', () => {
    const java = android.steps.find((s) => s.uses === 'actions/setup-java@v5');
    expect(java.with).toEqual({ distribution: 'temurin', 'java-version': '21' });
  });

  it('runs pnpm android:check before the release build', () => {
    const runs = android.steps.map((s) => s.run);
    expect(runs.indexOf('pnpm android:check')).toBeLessThan(
      runs.indexOf('./gradlew --console=plain assembleRelease'),
    );
  });

  it('passes the signing secrets only to the release build step', () => {
    const withSecrets = android.steps.filter((s) => s.env);
    expect(withSecrets).toHaveLength(1);
    expect(withSecrets[0].env).toEqual({
      HB_ANDROID_KEYSTORE: '${{ secrets.HB_ANDROID_KEYSTORE }}',
      HB_ANDROID_KEYSTORE_PASSWORD: '${{ secrets.HB_ANDROID_KEYSTORE_PASSWORD }}',
      HB_ANDROID_KEY_ALIAS: '${{ secrets.HB_ANDROID_KEY_ALIAS }}',
      HB_ANDROID_KEY_PASSWORD: '${{ secrets.HB_ANDROID_KEY_PASSWORD }}',
    });
  });

  it('names the uploaded APK harnessboard-<version>.apk', () => {
    const rename = android.steps.find((s) => s.name === 'Name the APK after the version');
    expect(rename.run).toContain('cp "$apk" "apk/harnessboard-$version.apk"');
  });

  it('prints the APK fingerprint with apk-fingerprint.mjs, which reads v2 signatures', () => {
    const rename = android.steps.find((s) => s.name === 'Name the APK after the version');
    expect(rename.run).toContain(
      'node scripts/apk-fingerprint.mjs "apk/harnessboard-$version.apk"',
    );
    expect(rename.run).not.toContain('keytool');
  });

  it('adds the APK to the draft release, whose checksums cover every file', () => {
    const release = workflow.jobs.release;
    expect(release.needs).toEqual(['desktop', 'android']);
    const checksums = release.steps.find((s) => s.name === 'Checksums');
    expect(checksums.run).toBe('sha256sum * > SHA256SUMS.txt');
  });
});
