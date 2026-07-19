import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // The isolation tests deliberately manipulate a shared connection pool to
    // force backend reuse. Running files in parallel would let one file's
    // pool surgery race another's assertions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
  },
});
