// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'tsup';

// Internal workspace packages are bundled in, so only `harnessboard` is published.
export default defineConfig({
  // desktop.js is what the desktop app runs; it shares chunks with the CLI.
  entry: ['src/cli.ts', 'src/desktop.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: [/^@harnessboard\//],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  // `sqlite` only exists as `node:sqlite`; keep the prefix on every built-in import.
  removeNodeProtocol: false,
});
