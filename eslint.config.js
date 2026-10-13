import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/storybook-static/**',
      'examples/*/build/**',
      '**/.juxtapose/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Unused args are often meaningful documentation in interface
      // implementations; allow the conventional underscore opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // page.evaluate bodies are typed as running in the browser, and the
      // window shapes we probe are platform internals with no published
      // types. Casting through `unknown` to a local interface is the honest
      // way to express that, and it is already how the adapters do it.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Empty catch is a deliberate, load-bearing pattern in the settle
      // pipeline: a timeout waiting for a render signal must not abort the
      // run. Those sites are commented; requiring a body would add noise.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Browser-context files: page.evaluate callbacks reference DOM globals.
  {
    files: ['packages/core/src/capture/**', 'packages/adapter-*/src/**'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Test files and scripts are looser by design.
  {
    files: ['**/*.test.ts', 'scripts/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // The browser driver is a self-contained unit: it may use Node built-ins and
  // its own files, never the rest of core, so it can move to its own package
  // with a `git mv`. One `..` leaves browser/ from its top level, two from
  // daemon/. Tests and fixtures are exempt.
  {
    files: ['packages/core/src/browser/*.ts'],
    ignores: ['**/*.test.ts', '**/__tests__/**', '**/__fixtures__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./',
              message: 'browser/ must not import from the rest of core.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/browser/daemon/*.ts'],
    ignores: ['**/*.test.ts', '**/__tests__/**', '**/__fixtures__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./\\.\\./',
              message: 'browser/ must not import from the rest of core.',
            },
          ],
        },
      ],
    },
  },

  // Examples are plain JSX consumed by a bundler, not part of the build.
  {
    files: ['examples/**'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
