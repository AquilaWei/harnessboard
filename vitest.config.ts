// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    testTimeout: 20_000,
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
