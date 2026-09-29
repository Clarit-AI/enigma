// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'plugins/enigma/dist/**',
      'node_modules/**',
      'graft/**',
      'coverage/**',
      // Issue #106: generated ledger-worker bundle (rebuilt by
      // vitest's globalSetup before each run from the TS source).
      'test/fixtures/ledger-worker.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
