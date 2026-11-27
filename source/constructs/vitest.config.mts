import { configDefaults, defineConfig } from 'vitest/config';

// Vitest 4 only excludes node_modules/ and .git/ by default; keep tsc output (dist/)
// and CDK synth output (build/, cdk.out/) out of test collection.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**', 'build/**', 'cdk.out/**'],
  },
});
