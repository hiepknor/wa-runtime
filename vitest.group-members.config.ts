import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/group-members.spec.ts'],
    globalSetup: ['test/support/group-members-global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
