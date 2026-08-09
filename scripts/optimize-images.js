/**
 * Scans assets/images for JPG/JPEG/PNG files and outputs:
 *  - {name}-opt.jpg  (max width, quality)
 *  - {name}-opt.webp (quality)
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

(async () => {
  try {
    const files = glob.sync('assets/images/**/*.+(jpg|jpeg|png)', { nodir: true });
    if (!files.length) {
      console.log('No images found to optimize.');
      return;
    }
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const base = file.slice(0, -ext.length);
      const outJpg = `${base}-opt.jpg`;
      const outWebp = `${base}-opt.webp`;

      // Read image and create resized/compressed JPEG
      try {
        const img = sharp(file, { failOnError: false });
        const metadata = await img.metadata();

        let pipeline = img;
        if (metadata.width && metadata.width > MAX_WIDTH) {
          pipeline = pipeline.resize({ width: MAX_WIDTH });
        }

        // Write optimized JPEG
        await pipeline
          .jpeg({ quality: JPG_QUALITY, mozjpeg: true })
          .toFile(outJpg);

        // Write optimized WebP
        // Recreate pipeline since sharp streams are consumed
        let pipeline2 = sharp(file, { failOnError: false });
        if (metadata.width && metadata.width > MAX_WIDTH) {
          pipeline2 = pipeline2.resize({ width: MAX_WIDTH });
        }
        await pipeline2.webp({ quality: WEBP_QUALITY }).toFile(outWebp);

        console.log(`Optimized: ${file} -> ${outJpg}, ${outWebp}`);
      } catch (err) {
        console.error(`Failed to optimize ${file}:`, err);
      }
    }
  } catch (err) {
    console.error('Error scanning images:', err);
    process.exit(1);
  }
})();
