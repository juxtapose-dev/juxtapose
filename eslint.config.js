import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Shipped package source: what the package tsconfigs compile.
const TYPED_SRC = ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'];
const TYPED_SRC_IGNORES = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/__tests__/**',
  '**/__fixtures__/**',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/storybook-static/**',
      '**/storybook-profile/**',
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
      // Package source makes this an error (below); elsewhere it warns.
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

  // Type-aware linting for shipped package source. Scoped to the files the
  // package tsconfigs actually compile: tests, fixtures, scripts and examples
  // are outside every project, so the type-aware rules cannot run there and
  // they keep the syntax-only rules above.
  //
  // recommended-type-checked, minus require-await (9 hits when enabled).
  // Those are interface methods and callbacks that are `async` without an
  // await on purpose: `async` turns a synchronous throw into a rejection the
  // caller's `.catch` sees. Dropping it would change that; keeping it under
  // the rule would mean `Promise.resolve` wrappers that say less.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TYPED_SRC,
    ignores: TYPED_SRC_IGNORES,
  })),
  {
    files: TYPED_SRC,
    ignores: TYPED_SRC_IGNORES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',

      '@typescript-eslint/require-await': 'off',
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
