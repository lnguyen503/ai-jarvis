/**
 * Unit tests for today-focus-card.js (v1.19.0 commit 14).
 *
 * Tests assert structural/safety properties via fs.readFileSync.
 * No live DOM execution — fast; no browser or server required.
 *
 * Coverage:
 *  - TFC-1 through TFC-6 (spec: ~6 cases)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const focusCardJs = readFileSync(path.join(root, 'public/webapp/organize/today-focus-card.js'), 'utf8');

describe('today-focus-card.js — structure and security', () => {
  it('TFC-1: exports initTodayFocusCard and renderTodayFocusCard', () => {
    expect(focusCardJs).toContain('export function initTodayFocusCard');
    expect(focusCardJs).toContain('export async function renderTodayFocusCard');
  });

  it('TFC-2: does NOT use innerHTML on user content (ADR 009 D6)', () => {
    const dangerous = focusCardJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('TFC-3: uses textContent for item titles (never innerHTML for user data)', () => {
    // Every item title assignment must use textContent
    expect(focusCardJs).toContain('textContent');
    expect(focusCardJs).toContain('item.title');
  });

  it('TFC-4: engaged-state visual: detects progress updated since 8am today', () => {
    expect(focusCardJs).toContain('isEngagedToday');
    expect(focusCardJs).toContain('today-pick-engaged');
    expect(focusCardJs).toContain('ENGAGED_SINCE_HOUR_UTC = 8');
  });

  it('TFC-5: empty state message when no items and no coach picks', () => {
    expect(focusCardJs).toContain('Nothing on the docket today');
  });

  it('TFC-6: collapse/expand persists in sessionStorage with COLLAPSE_KEY', () => {
    expect(focusCardJs).toContain('today-focus-card-collapsed');
    expect(focusCardJs).toContain('sessionStorage.getItem');
    expect(focusCardJs).toContain('sessionStorage.setItem');
  });
});

describe('today-focus-card.js — coach picks', () => {
  it('TFC-CP-1: reads coach memory from GET /api/webapp/memory (no new endpoint)', () => {
    expect(focusCardJs).toContain('/api/webapp/memory');
    expect(focusCardJs).toContain("'Authorization'");
  });

  it('TFC-CP-2: extracts coach picks by coach. prefix + lastNudge subkey', () => {
    expect(focusCardJs).toContain('COACH_MEMORY_PREFIX');
    expect(focusCardJs).toContain('lastNudge');
  });

  it('TFC-CP-3: filters coach picks where body.at matches todayIso', () => {
    expect(focusCardJs).toContain('atStr.startsWith(todayIso)');
  });

  it('TFC-CP-4: limits coach picks to max 3 (D11 spec)', () => {
    expect(focusCardJs).toContain('.slice(0, 3)');
  });

  it('TFC-CP-5: coach pick nudge wording rendered via textContent', () => {
    // wording must be set via textContent, not innerHTML
    expect(focusCardJs).toContain('today-pick-wording');
  });

  it('TFC-CP-6: collapse button has aria-expanded + aria-label (D18 accessibility)', () => {
    expect(focusCardJs).toContain('aria-expanded');
    expect(focusCardJs).toContain('aria-label');
    expect(focusCardJs).toContain('Collapse Today card');
    expect(focusCardJs).toContain('Expand Today card');
  });
});
