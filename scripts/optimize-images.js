/**
 * Scans assets/images for JPG/JPEG/PNG files and outputs:
 *  - {name}-opt.jpg  (max width, quality; transparent PNGs flattened on white)
 *  - {name}-opt.webp (quality; alpha preserved)
 * Files that already end in -opt are skipped (idempotent).
 *
 * Config via environment variables:
 *  - MAX_WIDTH (default 1200)
 *  - JPG_QUALITY (default 80)
 *  - WEBP_QUALITY (default 75)
 */
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');
const glob = require('glob');

const MAX_WIDTH = parseInt(process.env.MAX_WIDTH || '1200', 10);
const JPG_QUALITY = parseInt(process.env.JPG_QUALITY || '80', 10);
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY || '75', 10);
const SRC_DIR = 'assets/images';

(async () => {
  try {
    let files = glob.sync(`${SRC_DIR}/**/*.+(jpg|jpeg|png)`, { nodir: true })
      .filter(f => !/-opt\.(jpg|jpeg|webp)$/.test(f));
    if (!files.length) {
      console.log('No images found to optimize.');
      return;
    }
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const base = file.slice(0, -ext.length);
      const outJpg = `${base}-opt.jpg`;
      const outWebp = `${base}-opt.webp`;
      try {
        const metadata = await sharp(file, { failOnError: false }).metadata();
        const needsResize = metadata.width && metadata.width > MAX_WIDTH;
        const hasAlpha = metadata.hasAlpha;

        // JPEG: flatten transparent PNGs onto white, otherwise black.
        let pipeline = sharp(file, { failOnError: false });
        if (needsResize) pipeline = pipeline.resize({ width: MAX_WIDTH });
        if (hasAlpha) pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
        await pipeline.jpeg({ quality: JPG_QUALITY, mozjpeg: true }).toFile(outJpg);

        // WebP: keep alpha.
        let pipeline2 = sharp(file, { failOnError: false });
        if (needsResize) pipeline2 = pipeline2.resize({ width: MAX_WIDTH });
        await pipeline2.webp({ quality: WEBP_QUALITY }).toFile(outWebp);

        const before = (await fs.stat(file)).size;
        const after = await Promise.all([fs.stat(outJpg), fs.stat(outWebp)]);
        console.log(`Optimized: ${file} (${(before / 1024).toFixed(0)} KB) -> ${outJpg} (${(after[0].size / 1024).toFixed(0)} KB), ${outWebp} (${(after[1].size / 1024).toFixed(0)} KB)`);
      } catch (err) {
        console.error(`Failed to optimize ${file}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Error scanning images:', err);
    process.exit(1);
  }
})();
