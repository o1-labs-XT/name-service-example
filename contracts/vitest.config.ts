import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['build/**/*.test.js'],
  },
  resolve: {
    alias: {
        'o1js': path.resolve(__dirname, 'node_modules/o1js/dist/node/index.js'),
        'node-fetch': 'main',
    }
  },
  esbuild: false // no support for metadata reflection https://github.com/evanw/esbuild/issues/257
});