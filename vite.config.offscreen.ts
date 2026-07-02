import { defineConfig } from 'vite';

// Offscreen document bundle: cloned from vite.config.background.ts with these
// key differences:
//   - input: src/background/offscreen/offscreen.ts
//   - output: offscreen.js
//   - format: 'es' + <script type="module"> in offscreen.html. This MUST stay
//     an ES module: in an IIFE bundle `import.meta.url` is unavailable and
//     onnxruntime-web falls back to dynamic-import()ing its wasm glue from the
//     jsdelivr CDN ("Failed to fetch dynamically imported module ...
//     ort-wasm-simd-threaded.jsep.mjs"), which the extension CSP blocks — the
//     model never loads. The ES build resolves everything against
//     chrome-extension:// exactly like the background bundle does.
//   - emptyOutDir: false — this runs AFTER the background build into the same
//     dist/<mode>/ directory; we must not wipe what the background build wrote
//
// Chrome-only: do NOT add this to the Firefox build. Firefox has no offscreen
// API; the SW-side IS_FIREFOX guard in classify-client.ts keeps it on the
// in-process path.
//
// Load-bearing constraints (same as vite.config.background.ts):
//   - inlineDynamicImports: true — Chrome rejects dynamic import() in restricted
//     contexts; this folds ORT's WASM glue in statically
//   - NEVER set env.backends.onnx.wasm.wasmPaths in offscreen.ts — any override
//     forces ORT down its dynamic-import() glue-loading path
export default defineConfig(({ mode }) => ({
  publicDir: false,
  build: {
    outDir: `dist/${mode}`,
    emptyOutDir: false, // runs after the background build; do NOT wipe the directory
    target: 'es2022',
    minify: false,
    rollupOptions: {
      input: 'src/background/offscreen/offscreen.ts',
      output: {
        entryFileNames: 'offscreen.js',
        format: 'es',
        inlineDynamicImports: true,
      },
    },
  },
}));
