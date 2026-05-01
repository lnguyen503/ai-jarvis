/**
 * Unit tests for calendar-week-view.js (v1.19.0 commit 11).
 *
 * Tests assert structural/safety properties via fs.readFileSync — no live DOM
 * execution needed. Fast; no browser or server required.
 *
 * Coverage:
 *  - CWV-1 through CWV-10 (spec: ~10 cases)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const weekViewJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-week-view.js'), 'utf8');

describe('calendar-week-view.js — structure and security', () => {
  it('CWV-1: exports renderWeek function', () => {
    expect(weekViewJs).toContain('export function renderWeek');
  });

  it('CWV-2: imports from dates.js using UTC-aware helpers', () => {
    expect(weekViewJs).toMatch(/from\s*['"]\.\/dates\.js['"]/);
    expect(weekViewJs).toContain('formatISO');
    expect(weekViewJs).toContain('weekStart');
    expect(weekViewJs).toContain('addDays');
  });

  it('CWV-3: imports buildItemPill from calendar-month-view.js', () => {
    expect(weekViewJs).toContain("from './calendar-month-view.js'");
    expect(weekViewJs).toContain('buildItemPill');
  });

  it('CWV-4: does NOT use innerHTML on user content (ADR 009 D6)', () => {
    const dangerous = weekViewJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('CWV-5: uses textContent for day labels', () => {
    expect(weekViewJs).toContain('textContent');
  });

  it('CWV-6: renders coach overlay marker (🤖) for nudged items', () => {
    expect(weekViewJs).toContain('🤖');
    expect(weekViewJs).toContain('coach-overlay-marker');
  });

  it('CWV-7: coach overlay marker has aria-label for accessibility (D18)', () => {
    expect(weekViewJs).toContain('aria-label');
    expect(weekViewJs).toContain('Coach active on this item');
  });

  it('CWV-8: handles 7 columns (Monday first — FIRST_DAY_OF_WEEK = 1)', () => {
    expect(weekViewJs).toContain('FIRST_DAY_OF_WEEK = 1');
    expect(weekViewJs).toContain('for (let i = 0; i < 7; i++)');
  });

  it('CWV-9: item placement uses UTC hour accessor (getUTCHours)', () => {
    expect(weekViewJs).toContain('getUTCHours');
    expect(weekViewJs).not.toContain('.getHours()');
  });

  it('CWV-10: handles DnD dragover/dragleave/drop on week cells', () => {
    expect(weekViewJs).toContain('dragover');
    expect(weekViewJs).toContain('dragleave');
    expect(weekViewJs).toContain('drop');
    expect(weekViewJs).toContain('cell-drop-target');
  });
});

describe('calendar-week-view.js — coach overlay', () => {
  it('CWV-O-1: coachItemIds parameter defaults to empty Set', () => {
    expect(weekViewJs).toContain('coachItemIds = new Set()');
  });

  it('CWV-O-2: uses coachItemIds.has() to check overlay', () => {
    expect(weekViewJs).toContain('coachItemIds.has(');
  });
});
