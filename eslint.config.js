// flat config. src/ can only import relative paths (node: builtins allowed in src/cli only).
// import-x catches anything reaching for a devDependency from src/.
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginImportX from 'eslint-plugin-import-x'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { 'import-x': pluginImportX },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // @ts-expect-error is allowed but must say why (ban-ts-comment enforces the description)
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': 'off',
    },
  },
  {
    // node scripts (fixture fetchers, bench drivers) get node globals but no TS rules
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // library code: relative imports only, no node builtins at all
    files: ['src/**/*.ts'],
    ignores: ['src/cli/**/*.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, optionalDependencies: false, peerDependencies: false },
      ],
      'no-restricted-imports': [
        'error',
        {
          // group globs match relative paths too, so use regex: anything that
          // doesn't start with "." is a bare/builtin/Scoped specifier
          patterns: [
            {
              regex: '^[^.]',
              message:
                'library code must be relative-imports only; the published package has zero dependencies',
            },
          ],
        },
      ],
    },
  },
  {
    // cli entry: relative imports + node builtins, still nothing from node_modules
    files: ['src/cli/**/*.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, optionalDependencies: false, peerDependencies: false },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // bare or scoped specifiers, but node: builtins are fine here
              regex: '^(?!node:)[^.]',
              message:
                "src/cli may only use relative imports and node: builtins; engines load from the user's project at runtime",
            },
          ],
        },
      ],
    },
  },
)
