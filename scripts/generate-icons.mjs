#!/usr/bin/env node
// Generates the SmartBlocker icon set (extension + Tauri companion) with no
// image dependencies: pixels are rasterized in pure JS (8x supersampling for
// crisp anti-aliased edges) and encoded to PNG via node:zlib deflateSync +
// hand-rolled CRC32, then repacked into a Windows .ico.
//
//   node scripts/generate-icons.mjs   (re-run after any design tweak)
//
// Design: a dark-slate rounded square (#0f172a) holding a geometric shield
// with a vibrant indigo -> emerald vertical gradient and a dark keyhole
// cutout — matching the emerald/slate SmartBlocker brand.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SS = 8; // supersample factor (anti-aliasing)

// --- palette (RGB 0-255) ---------------------------------------------------
const BG = [15, 23, 42]; // #0f172a — dark slate rounded square
const SHIELD_TOP = [99, 102, 241]; // #6366f1 — indigo-500
const SHIELD_BOTTOM = [16, 185, 129]; // #10b981 — emerald-500
const KEYHOLE = [4, 8, 20]; // slightly deeper than BG for depth

// --- geometry (normalized [0,1] coords, y pointing down) -------------------
const CORNER_R = 0.225; // rounded-square corner radius
const SHIELD = [
  // flat top, straight shoulders, pointed base
  [0.27, 0.24],
  [0.73, 0.24],
  [0.73, 0.5],
  [0.5, 0.78],
  [0.27, 0.5],
];
const [SHIELD_Y0, SHIELD_Y1] = [0.24, 0.78]; // gradient span
const KEY = { cx: 0.5, cy: 0.415, r: 0.085 }; // keyhole circle
// tapered slot under the circle; top edge tucked inside it
const KEY_SLOT = [
  [0.452, 0.425],
  [0.548, 0.425],
  [0.528, 0.63],
  [0.472, 0.63],
];

/** Signed distance to the centered rounded square; <= 0 means inside. */
function roundedSquareDist(x, y, r) {
  const qx = Math.abs(x - 0.5) - (0.5 - r);
  const qy = Math.abs(y - 0.5) - (0.5 - r);
  return (
    Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
  );
}

/** Even-odd point-in-polygon test. */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Per-sample color in normalized coords: [r, g, b, a] (0-255). */
function sample(x, y) {
  if (roundedSquareDist(x, y, CORNER_R) > 0) return [0, 0, 0, 0];
  let rgb = BG;
  const inShield = inPolygon(x, y, SHIELD);
  if (inShield) {
    const t = Math.min(1, Math.max(0, (y - SHIELD_Y0) / (SHIELD_Y1 - SHIELD_Y0)));
    rgb = [
      Math.round(SHIELD_TOP[0] + (SHIELD_BOTTOM[0] - SHIELD_TOP[0]) * t),
      Math.round(SHIELD_TOP[1] + (SHIELD_BOTTOM[1] - SHIELD_TOP[1]) * t),
      Math.round(SHIELD_TOP[2] + (SHIELD_BOTTOM[2] - SHIELD_TOP[2]) * t),
    ];
  }
  if (
    inShield &&
    (Math.hypot(x - KEY.cx, y - KEY.cy) <= KEY.r || inPolygon(x, y, KEY_SLOT))
  ) {
    rgb = KEYHOLE;
  }
  return [rgb[0], rgb[1], rgb[2], 255];
}

/** Rasterize at SS x supersampling, then box-filter down to `size` RGBA.
 *  Averaging in premultiplied space avoids dark fringes on transparent
 *  edges. */
function render(size) {
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

// --- PNG encoding (8-bit RGBA, filter byte 0 per scanline) ------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Windows .ico wrapping PNG-compressed entries ([[size, pngBuf], ...]). */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach(([size, png], i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; // width (0 encodes 256)
    dir[o + 1] = size >= 256 ? 0 : size; // height
    dir[o + 2] = 0; // palette colors (0 = truecolor)
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map(([, png]) => png)]);
}

// --- generation --------------------------------------------------------------
const JOBS = [
  ['src/assets/icons/icon-16.png', 16],
  ['src/assets/icons/icon-32.png', 32],
  ['src/assets/icons/icon-48.png', 48],
  ['src/assets/icons/icon-128.png', 128],
  ['companion/crates/smartblocker-companion/icons/32x32.png', 32],
  ['companion/crates/smartblocker-companion/icons/128x128.png', 128],
  ['companion/crates/smartblocker-companion/icons/128x128@2x.png', 256],
  ['companion/crates/smartblocker-companion/icons/icon.png', 256],
];

const rendered = new Map(); // size -> PNG buffer
for (const [path, size] of JOBS) {
  if (!rendered.has(size)) rendered.set(size, encodePng(size, render(size)));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rendered.get(size));
  console.log(`[icons] ${path} (${size}x${size})`);
}

// Windows .ico: 32px taskbar/alt-tab icon + 256px high-DPI source.
writeFileSync(
  'companion/crates/smartblocker-companion/icons/icon.ico',
  encodeIco([
    [32, rendered.get(32)],
    [256, rendered.get(256)],
  ]),
);
console.log('[icons] companion/crates/smartblocker-companion/icons/icon.ico (32 + 256)');
