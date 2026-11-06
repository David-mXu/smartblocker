import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Blocked page build (extension-OWNED force-mode block screen, DNR redirect
// target — see src/blocked/blocked.html). Mirrors the popup/options passes:
// separate build because inlineDynamicImports (background) is illegal with
// multiple rollup inputs. Plain TS entry — no React on this page.
export default defineConfig(({ mode }) => ({
  root: 'src/blocked',
  publicDir: false,
  base: './',
  plugins: [tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, `dist/${mode}`),
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/blocked/blocked.html'),
    },
  },
}));
