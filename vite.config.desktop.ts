import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Desktop companion UI (src/desktop) → the Tauri crate's ui-dist/.
//
// Output is a CLASSIC script, not an ES module: Chromium refuses
// <script type="module"> and `crossorigin` stylesheets on file:// (origin
// "null"), and the build must also open straight from disk for previews.
// Tauri serves it from its own origin either way, so nothing is lost.
// No asset inlining: the window's CSP (default-src 'self') blocks data: URIs.
function classicScript(): Plugin {
  return {
    name: 'sb-desktop-classic-script',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin src=/g, '<script defer src=')
        .replace(/<script type="module" src=/g, '<script defer src=')
        .replace(/ crossorigin(?=[\s>])/g, '');
    },
  };
}

export default defineConfig({
  root: 'src/desktop',
  publicDir: false,
  base: './',
  plugins: [react(), tailwindcss(), classicScript()],
  build: {
    outDir: resolve(import.meta.dirname, 'companion/crates/smartblocker-companion/ui-dist'),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    // One linked stylesheet (non-ES chunks would otherwise inject CSS from JS).
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/desktop/index.html'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
});
