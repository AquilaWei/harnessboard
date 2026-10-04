// SPDX-License-Identifier: Apache-2.0
import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Bundled CommonJS dependencies call require(); ESM output has none of its own.
const requireShim = {
  js: "import { createRequire as __hbRequire } from 'node:module'; const require = __hbRequire(import.meta.url);",
};

export default defineConfig([
  // Electron's main process. `electron` is provided by the app at run time; everything else
  // is bundled in, since the packaged app has no node_modules.
  {
    entry: { main: 'src/main.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    noExternal: [/^(?!electron$)/],
    removeNodeProtocol: false,
    banner: requireShim,
  },
  // The server, with every dependency bundled in: the packaged app has no node_modules.
  {
    entry: { server: '../server/src/desktop.ts' },
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    platform: 'node',
    target: 'node22',
    noExternal: [/.*/],
    removeNodeProtocol: false,
    banner: requireShim,
    // The server serves the board from web/ next to its own file.
    onSuccess: async () => cpSync('../web/dist', 'dist/web', { recursive: true }),
  },
]);
