// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    // Windows CI needs more time to create Git fixtures and run CLI integration flows.
    testTimeout: process.platform === 'win32' ? 60_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 10_000,
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
