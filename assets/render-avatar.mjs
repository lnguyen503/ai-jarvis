/**
 * One-shot SVG → PNG renderer for the Jarvis avatar.
 *
 * Uses Playwright Chromium (already installed for the browse_url tool) to
 * load the SVG in a 640×640 viewport and screenshot it. The result is
 * exactly the file BotFather expects: 640×640 PNG, ready to upload.
 *
 * Usage: node assets/render-avatar.mjs
 */

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SVG_PATH = path.join(__dirname, 'jarvis-avatar.svg');
const PNG_PATH = path.join(__dirname, 'jarvis-avatar.png');

const svg = await readFile(SVG_PATH, 'utf8');

// Wrap the SVG in a minimal HTML document so the browser renders it at
// exactly 640×640 with no margins or scrollbars.
const html = `<!doctype html>
<html><head><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: 640px; height: 640px; }
</style></head><body>${svg}</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 640, height: 640 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'load' });
const png = await page.screenshot({
  type: 'png',
  clip: { x: 0, y: 0, width: 640, height: 640 },
  omitBackground: false,
});
await browser.close();

await writeFile(PNG_PATH, png);
console.log(`Wrote ${PNG_PATH} (${png.length} bytes)`);
