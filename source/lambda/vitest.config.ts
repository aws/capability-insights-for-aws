import { defineConfig } from 'vitest/config';

// Default config: exclude integration tests so `npm test` stays fast and
// pure-unit. Integration tests run via `npm run test:it` against a
// deployed stack.
export default defineConfig({
  test: {
    exclude: ['**/integration-tests/**', 'node_modules/**', 'dist/**'],
  },
});
