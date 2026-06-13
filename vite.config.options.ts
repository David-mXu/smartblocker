import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Separate build pass from the background: inlineDynamicImports (required
// there) is illegal with multiple rollup inputs.
export default defineConfig(({ mode }) => ({
  root: 'src/options',
  publicDir: false,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, `dist/${mode}`),
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/options/options.html'),
    },
  },
}));
