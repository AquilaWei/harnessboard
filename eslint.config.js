// SPDX-License-Identifier: Apache-2.0
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'android/**/build/**',
      'android/.gradle/**',
      'android/.kotlin/**',
      'android/buildSrc/.gradle/**',
      'android/buildSrc/.kotlin/**',
      'android/local.properties',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The service worker and the classic script it loads with `importScripts`.
    files: ['packages/web/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.serviceworker },
  },
);
