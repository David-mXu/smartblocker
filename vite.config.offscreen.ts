import { defineConfig } from 'vite';

// Offscreen document bundle: cloned from vite.config.background.ts with these
// key differences:
//   - input: src/background/offscreen/offscreen.ts
//   - output: offscreen.js
//   - format: 'iife' (the offscreen page HAS a real document, so ORT can use
//     document.baseURI to resolve the .wasm asset; ES module not needed here,
//     and offscreen.html loads it via a plain <script src="offscreen.js"> tag)
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
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
}));
