// SPDX-License-Identifier: Apache-2.0
// Builds the installers for this platform with the version from packages/server/package.json,
// the only place it is written. Extra arguments go to electron-builder (e.g. `--linux AppImage`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('../server/package.json', 'utf8'));
execFileSync(
  'electron-builder',
  [`-c.extraMetadata.version=${version}`, ...process.argv.slice(2)],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
