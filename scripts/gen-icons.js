#!/usr/bin/env node
/*
 * Rasterizes scripts/icon.svg into every PNG size the PWA manifest,
 * apple-touch-icon, and favicon need. Requires `sharp` (devDependency only;
 * not needed at runtime). Re-run with: node scripts/gen-icons.js
 */
const path = require('path');
const sharp = require('sharp');

const svgPath = path.join(__dirname, 'icon.svg');
const outDir = path.join(__dirname, '..', 'web', 'icons');

const targets = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-192.png', size: 192 },
  { file: 'icon-maskable-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'favicon-32.png', size: 32 },
  { file: 'favicon-16.png', size: 16 },
];

(async () => {
  for (const t of targets) {
    await sharp(svgPath, { density: 384 })
      .resize(t.size, t.size)
      .png()
      .toFile(path.join(outDir, t.file));
    console.log('wrote', t.file);
  }
})();
