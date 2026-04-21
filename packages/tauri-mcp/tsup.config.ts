import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  noExternal: [/.*/],
  clean: true,
  sourcemap: true,
  shims: false,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  outDir: 'dist',
});
