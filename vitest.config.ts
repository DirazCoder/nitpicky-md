import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.test-d.ts', 'tests/**/*.bench.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // spec suites are big; keep the noise down unless we ask for it
    reporters: 'default',
    env: {
      // fuzz iteration count, overridable: FUZZ_CASES=100000 npm run fuzz
      FUZZ_CASES: process.env.FUZZ_CASES ?? '2000',
    },
  },
})
