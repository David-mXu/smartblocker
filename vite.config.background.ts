import { defineConfig } from 'vite';

// Background bundle: one flat file with no reachable dynamic imports
// (Chrome MV3 service workers reject dynamic import() at runtime;
// inlineDynamicImports folds onnxruntime-web's WASM glue in statically).
//
// Format differs per target because onnxruntime-web resolves its .wasm asset
// against import.meta.url:
//  - chrome: ES module service worker ("type": "module" in the manifest) —
//    import.meta.url is native. An IIFE build would get Vite's
//    document.baseURI fallback, and `document` doesn't exist in a SW.
//  - firefox: classic background script (event page). Firefox's generated
//    background page HAS a document, so the baseURI fallback works there.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: `dist/${mode}`,
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: 'src/background/index.ts',
      output: {
        entryFileNames: 'background.js',
        format: mode === 'chrome' ? 'es' : 'iife',
        inlineDynamicImports: true,
      },
    },
  },
}));
