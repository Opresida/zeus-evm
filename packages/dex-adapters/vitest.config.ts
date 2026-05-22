import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000, // 30s — RPC pode demorar
    hookTimeout: 30_000,
    globalSetup: ['./tests/setup.ts'],
  },
});
