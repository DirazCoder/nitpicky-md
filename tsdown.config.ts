import { defineConfig } from 'tsdown'

// two separate builds on purpose: index.js must be standalone (browser-safe,
// zero node builtins), cli.js is allowed node:*. a shared chunk would risk
// pulling cli imports into the library entry, and check-deps.mjs enforces this.
export default [
  defineConfig({
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: 'esm',
    dts: { sourcemap: true },
    platform: 'neutral',
    target: 'es2022',
    clean: false,
    unbundle: true,
  }),
  defineConfig({
    entry: { cli: 'src/cli/main.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    clean: false,
    unbundle: true,
    banner: {
      // dist/cli.js runs via package.json "bin" without an extension hint some old
      // shims need; the shebang makes direct execution work everywhere
      js: '#!/usr/bin/env node',
    },
  }),
]
