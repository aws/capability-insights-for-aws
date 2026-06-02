import { defineConfig } from 'vitest/config';

// Integration-test config. Picks up only `*.it.test.ts` files under
// integration-tests/. Hits real AWS — slow, requires creds, run on demand.
export default defineConfig({
  test: {
    include: ['integration-tests/**/*.it.test.ts'],
    // A single end-to-end run can take 60-120s; allow generous per-test
    // budget. Per-test timeout is also set inline at the test definition.
    testTimeout: 6 * 60 * 1000,
    hookTimeout: 60 * 1000,
    // Don't surface unrelated unit tests if someone runs this by mistake.
    exclude: ['**/!(*.it).test.ts', 'node_modules/**', 'dist/**'],
  },
});
