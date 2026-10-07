// SPDX-License-Identifier: Apache-2.0
// Tests, lints and builds the Android app (`android/`) without prompts: `pnpm android:check`.
// Set HARNESSBOARD_SKIP_ANDROID=1 to skip it on a machine without the Android SDK.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRADLE_TASKS = ['ktlintCheck', 'test', 'lintDebug', 'assembleDebug'];

/**
 * Where the Android SDK is: `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then the folder Android
 * Studio installs to on this platform. A variable that is set wins even when its folder is
 * missing, so a typo there fails loudly instead of silently using another SDK.
 * Returns null when nothing is set and the default folder does not exist.
 */
export function findAndroidSdk({ env, platform, home, exists }) {
  if (env.ANDROID_HOME) return env.ANDROID_HOME;
  if (env.ANDROID_SDK_ROOT) return env.ANDROID_SDK_ROOT;
  let fallback;
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) return null;
    fallback = win32.join(env.LOCALAPPDATA, 'Android', 'Sdk');
  } else if (platform === 'darwin') {
    fallback = posix.join(home, 'Library', 'Android', 'sdk');
  } else {
    fallback = posix.join(home, 'Android', 'Sdk');
  }
  return exists(fallback) ? fallback : null;
}

function main() {
  if (process.env.HARNESSBOARD_SKIP_ANDROID === '1') {
    console.log('android:check skipped (HARNESSBOARD_SKIP_ANDROID=1)');
    return 0;
  }
  const sdk = findAndroidSdk({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    exists: existsSync,
  });
  if (!sdk) {
    console.error(
      'android:check: Android SDK not found. Set ANDROID_HOME (or ANDROID_SDK_ROOT) to it, ' +
        'install it in the default place, or set HARNESSBOARD_SKIP_ANDROID=1 to skip.',
    );
    return 1;
  }
  const androidDir = fileURLToPath(new URL('../android/', import.meta.url));
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? 'gradlew.bat' : './gradlew',
    ['--console=plain', ...GRADLE_TASKS],
    {
      cwd: androidDir,
      // AGP reads the SDK location from ANDROID_HOME, so local.properties is not needed.
      env: { ...process.env, ANDROID_HOME: sdk },
      stdio: 'inherit',
      // Node only runs a .bat file through the shell.
      shell: windows,
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
