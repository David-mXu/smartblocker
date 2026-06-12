// Post-build: manifests/<target>.json -> dist/<target>/manifest.json.
// (The ORT .wasm binary is emitted into dist/<target>/assets/ by Vite itself;
// nothing else needs copying.)
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
