// Post-build: manifests/<target>.json -> dist/<target>/manifest.json.
// (The ORT .wasm binary is emitted into dist/<target>/assets/ by Vite itself.)
// The offscreen document's HTML is hand-authored (the offscreen Vite pass has a
// .ts entry + publicDir:false, so it only emits offscreen.js) — copy it for
// Chrome/Edge, which is the only target with an offscreen document.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
if (target !== 'chrome' && target !== 'firefox') {
  console.error('usage: node scripts/copy-assets.mjs <chrome|firefox>');
  process.exit(1);
}

const dist = join('dist', target);
copyFileSync(join('manifests', `${target}.json`), join(dist, 'manifest.json'));
console.log(`[copy-assets] ${target}: manifest -> ${dist}`);

if (target === 'chrome') {
  copyFileSync(join('src', 'background', 'offscreen', 'offscreen.html'), join(dist, 'offscreen.html'));
  console.log(`[copy-assets] ${target}: offscreen.html -> ${dist}`);

  // ORT wasm glue + binary, under their UNHASHED names, for the offscreen
  // document. Outside a service worker, transformers.js defaults
  // env.backends.onnx.wasm.wasmPaths to its CDN (CSP-blocked in extensions),
  // so offscreen.ts overrides wasmPaths to these extension-local copies.
  const ortDist = join('node_modules', '@huggingface', 'transformers', 'dist');
  for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
    copyFileSync(join(ortDist, f), join(dist, f));
    console.log(`[copy-assets] ${target}: ${f} -> ${dist}`);
  }
}
