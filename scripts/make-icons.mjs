// Renders web/public/icons/icon.svg to the PNG sizes the manifest and iOS need.
// sharp comes in through wrangler (not a direct dependency), so run: node scripts/make-icons.mjs
import sharp from 'sharp';
const src = 'web/public/icons/icon.svg';
const sizes = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };
for (const [name, size] of Object.entries(sizes)) {
  await sharp(src, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(`web/public/icons/${name}`);
}
console.log('icons written');
