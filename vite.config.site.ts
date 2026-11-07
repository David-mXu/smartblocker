import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Standalone marketing landing page. Separate output tree (dist-site/) so the
// extension build passes in dist/<browser>/ remain untouched.
export default defineConfig({
  root: 'site',
  publicDir: 'public',
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-site',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    rollupOptions: {
      input: fileURLToPath(new URL('./site/index.html', import.meta.url)),
    },
  },
});
