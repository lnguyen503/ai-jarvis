/**
 * Unit tests for v1.21.0 ADR 021 Pillar 4 hub banner identity badge.
 *
 * Validates structural/safety properties of:
 *   public/webapp/app.js
 *     - initBotNameBadge function exists
 *     - fetches /api/webapp/identity
 *     - populates #bot-name-badge via textContent (XSS-safe)
 *     - removes hidden attribute after successful fetch
 *     - silently skips on network failure
 *   public/webapp/index.html
 *     - #bot-name-badge element exists in the <h1>
 *   public/webapp/styles.css
 *     - .bot-name-badge class is defined
 *
 * Fast; no browser or server required (source code inspection).
 * Test IDs: HBI-* (Hub Banner Identity)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const appJs = readFileSync(path.join(root, 'public/webapp/app.js'), 'utf8');
const indexHtml = readFileSync(path.join(root, 'public/webapp/index.html'), 'utf8');
const styles = readFileSync(path.join(root, 'public/webapp/styles.css'), 'utf8');

describe('hub banner identity — app.js source structure', () => {
  it('HBI-1: initBotNameBadge function exists', () => {
    expect(appJs).toContain('function initBotNameBadge');
  });

  it('HBI-2: fetches /api/webapp/identity', () => {
    expect(appJs).toContain("'/api/webapp/identity'");
  });

  it('HBI-3: populates badge via textContent (XSS-safe; no innerHTML)', () => {
    expect(appJs).toContain("badgeEl.textContent");
  });

  it('HBI-4: removes hidden attribute after successful fetch', () => {
    expect(appJs).toContain("badgeEl.removeAttribute('hidden')");
  });

  it('HBI-5: initBotNameBadge is called after auth success', () => {
    expect(appJs).toContain('initBotNameBadge(initData)');
  });
});

describe('hub banner identity — index.html structure', () => {
  it('HBI-6: #bot-name-badge element exists', () => {
    expect(indexHtml).toContain('id="bot-name-badge"');
  });

  it('HBI-7: #bot-name-badge has .bot-name-badge class', () => {
    expect(indexHtml).toContain('class="bot-name-badge"');
  });

  it('HBI-8: #bot-name-badge starts hidden', () => {
    expect(indexHtml).toMatch(/id="bot-name-badge"[^>]*hidden/);
  });
});

describe('hub banner identity — styles.css', () => {
  it('HBI-9: .bot-name-badge class is defined', () => {
    expect(styles).toContain('.bot-name-badge');
  });

  it('HBI-10: badge uses hint-color (subdued)', () => {
    // Find the .bot-name-badge block and verify hint-color is used
    const idx = styles.indexOf('.bot-name-badge');
    expect(idx).toBeGreaterThan(-1);
    const block = styles.slice(idx, idx + 300);
    expect(block).toContain('hint-color');
  });
});
