/**
 * W1 — No zombie detail-panel symbols in app.js (v1.17.0).
 *
 * ADR 017 W1 BINDING:
 * After the detail-panel.js extraction (commit -1), the functions
 * renderDetail, enterDetailView, exitDetailView, renderDetailMeta
 * MUST NOT be defined as function declarations in app.js.
 *
 * They may appear as imports from detail-panel.js — that's correct and expected.
 * They must appear as function definitions in detail-panel.js.
 *
 * Prevents the v1.15.0 P2 R1 "zombie copy" trap where extraction
 * added the new file but forgot to delete the originals.
 *
 * v1.17.0 — ADR 017 D1 + W1.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_JS = path.join(PROJECT_ROOT, 'public/webapp/organize/app.js');
const DETAIL_PANEL_JS = path.join(PROJECT_ROOT, 'public/webapp/organize/detail-panel.js');

const EXTRACTED_SYMBOLS = [
  'renderDetail',
  'enterDetailView',
  'exitDetailView',
  'renderDetailMeta',
];

describe('W1 — no zombie detail-panel symbols in app.js', () => {
  it('app.js exists', () => {
    expect(fs.existsSync(APP_JS)).toBe(true);
  });

  it('detail-panel.js exists', () => {
    expect(fs.existsSync(DETAIL_PANEL_JS)).toBe(true);
  });

  it('app.js contains ZERO function declarations for extracted symbols', () => {
    const src = fs.readFileSync(APP_JS, 'utf-8');
    const violations: string[] = [];

    for (const sym of EXTRACTED_SYMBOLS) {
      // Match `function <sym>(` — the function declaration form
      const re = new RegExp(`\\bfunction\\s+${sym}\\s*\\(`, 'g');
      if (re.test(src)) {
        violations.push(`app.js still contains function declaration for '${sym}' (zombie copy)`);
      }
    }

    if (violations.length > 0) {
      const msg = [
        'W1 violation: extracted symbols still declared in app.js.',
        'Remove the zombie copies from app.js (the functions should only exist in detail-panel.js).',
        '',
        ...violations,
      ].join('\n');
      expect(violations.length, msg).toBe(0);
    }
  });

  it('detail-panel.js exports renderDetail as a function', () => {
    const src = fs.readFileSync(DETAIL_PANEL_JS, 'utf-8');
    expect(src).toMatch(/export\s+function\s+renderDetail\s*\(/);
  });

  it('detail-panel.js exports enterDetailView as a function', () => {
    const src = fs.readFileSync(DETAIL_PANEL_JS, 'utf-8');
    expect(src).toMatch(/export\s+function\s+enterDetailView\s*\(/);
  });

  it('detail-panel.js exports exitDetailView as a function', () => {
    const src = fs.readFileSync(DETAIL_PANEL_JS, 'utf-8');
    expect(src).toMatch(/export\s+function\s+exitDetailView\s*\(/);
  });

  it('app.js imports from detail-panel.js (not duplicating)', () => {
    const src = fs.readFileSync(APP_JS, 'utf-8');
    expect(src).toContain("from './detail-panel.js'");
  });
});
