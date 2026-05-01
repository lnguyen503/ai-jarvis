/**
 * Detail-panel.js extraction tests — Jarvis v1.17.0 (W1 verification).
 *
 * Verifies:
 *   - renderDetail is defined in detail-panel.js (grep check)
 *   - renderDetail is NOT defined as a function declaration in app.js (only appears as import)
 *   - No duplicates (zombie copy prevention — closes v1.15.0 P2 R1 trap)
 *
 * W1 pre-extraction grep baseline in app.js: 1 (function renderDetail).
 * W1 post-extraction grep in app.js: 0. Grep in detail-panel.js: ≥1.
 *
 * These tests are static source-file assertions (no browser/server needed).
 *
 * v1.17.0 — ADR 017 D1 + W1 binding.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const appJs = readFileSync(path.join(root, 'public/webapp/organize/app.js'), 'utf8');
const detailPanelJs = readFileSync(path.join(root, 'public/webapp/organize/detail-panel.js'), 'utf8');

// ------------------------------------------------------------------
// W1 verification — source grep tests
// ------------------------------------------------------------------

describe('webapp organize detail-panel — W1 extraction verification', () => {
  it('renderDetail is defined (exported) in detail-panel.js', () => {
    // Matches "export function renderDetail" as defined in detail-panel.js
    expect(detailPanelJs).toMatch(/export\s+function\s+renderDetail/);
  });

  it('renderDetail is NOT defined as a function declaration in app.js (import only)', () => {
    // After extraction, app.js must not contain "function renderDetail" (the definition).
    // It MAY import renderDetail — that's fine and expected.
    expect(appJs).not.toMatch(/function\s+renderDetail\s*\(/);
  });

  it('enterDetailView is NOT defined as a function declaration in app.js', () => {
    expect(appJs).not.toMatch(/function\s+enterDetailView\s*\(/);
  });

  it('exitDetailView is NOT defined as a function declaration in app.js', () => {
    expect(appJs).not.toMatch(/function\s+exitDetailView\s*\(/);
  });

  it('renderDetailMeta is NOT defined in either file (function was never extracted — was inline code in renderDetail)', () => {
    // No standalone renderDetailMeta function should exist
    expect(appJs).not.toMatch(/function\s+renderDetailMeta/);
    expect(detailPanelJs).not.toMatch(/function\s+renderDetailMeta/);
  });

  it('app.js imports renderDetail from detail-panel.js', () => {
    expect(appJs).toContain("from './detail-panel.js'");
    expect(appJs).toContain('renderDetail');
  });

  it('detail-panel.js exports initDetailPanel', () => {
    expect(detailPanelJs).toMatch(/export\s+function\s+initDetailPanel/);
  });

  it('detail-panel.js exports getCurrentDetailItem', () => {
    expect(detailPanelJs).toMatch(/export\s+function\s+getCurrentDetailItem/);
  });

  it('detail-panel.js exports getCurrentDetailEtag', () => {
    expect(detailPanelJs).toMatch(/export\s+function\s+getCurrentDetailEtag/);
  });

  it('detail-panel.js exports clearDetailState', () => {
    expect(detailPanelJs).toMatch(/export\s+function\s+clearDetailState/);
  });

  it('detail-panel.js uses textContent only for user content (no innerHTML for user data)', () => {
    // The only innerHTML usage allowed is the safe clear: .innerHTML = ''
    // Should NOT have innerHTML = someVar or innerHTML = template-literal with user content
    // Allow .innerHTML = '' (safe clear) and .innerHTML = ''; (with semicolon)
    const dangerousInnerHtml = detailPanelJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])/g);
    // The only safe use should be the safe clear: innerHTML = ''; or innerHTML = "" — handled by .innerHTML = ''
    // All other assignments should be absent
    // Verify: only allowed form is empty string clear
    const allInnerHtml = [...(detailPanelJs.matchAll(/\.innerHTML\s*=\s*(.+)/g) || [])];
    for (const match of allInnerHtml) {
      const rhs = match[1].trim();
      // Permitted: empty string clear ('', "")
      expect(rhs).toMatch(/^['"`]\s*['"`]/);
    }
  });

  it('app.js uses accessor functions (getCurrentDetailItem) not direct variable access post-extraction', () => {
    // After extraction, app.js should call getCurrentDetailItem() not reference currentDetailItem directly
    // The state variable currentDetailItem is no longer declared in app.js
    expect(appJs).not.toMatch(/let\s+currentDetailItem\s*=/);
    expect(appJs).not.toMatch(/let\s+currentDetailEtag\s*=/);
  });

  it('detail-panel.js imports renderMarkdown from markdown.js', () => {
    expect(detailPanelJs).toContain("from './markdown.js'");
    expect(detailPanelJs).toContain('renderMarkdown');
  });

  it('detail-panel.js imports exitEditMode from edit-form.js', () => {
    expect(detailPanelJs).toContain("from './edit-form.js'");
    expect(detailPanelJs).toContain('exitEditMode');
  });
});
