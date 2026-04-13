import { reactRouter } from '@react-router/dev/vite';
import { defineConfig, type Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

function excludePublicData(): Plugin {
  return {
    name: 'exclude-public-data',
    writeBundle(options) {
      return rm(resolve(options.dir!, 'data'), { recursive: true, force: true }) as Promise<void>;
    },
  };
}

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths(), excludePublicData()],
  ssr: {
    noExternal: [/^@cloudscape-design\//],
  },
});
