/**
 * Unit tests for calendar-day-view.js (v1.19.0 commit 11).
 *
 * Tests assert structural/safety properties via fs.readFileSync — no live DOM
 * execution needed. Fast; no browser or server required.
 *
 * Coverage:
 *  - CDV-1 through CDV-10 (spec: ~10 cases)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const dayViewJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-day-view.js'), 'utf8');

describe('calendar-day-view.js — structure and security', () => {
  it('CDV-1: exports renderDay function', () => {
    expect(dayViewJs).toContain('export function renderDay');
  });

  it('CDV-2: imports from dates.js using UTC accessors only', () => {
    expect(dayViewJs).toMatch(/from\s*['"]\.\/dates\.js['"]/);
    expect(dayViewJs).toContain('formatISO');
    expect(dayViewJs).toContain('isSameDay');
  });

  it('CDV-3: imports buildItemPill from calendar-month-view.js', () => {
    expect(dayViewJs).toContain("from './calendar-month-view.js'");
    expect(dayViewJs).toContain('buildItemPill');
  });

  it('CDV-4: does NOT use innerHTML on user content (ADR 009 D6)', () => {
    // innerHTML = '' (clearing) is allowed; innerHTML = user data is not
    const dangerous = dayViewJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('CDV-5: uses textContent for item titles', () => {
    expect(dayViewJs).toContain('textContent');
  });

  it('CDV-6: renders coach overlay marker (🤖) for nudged items', () => {
    expect(dayViewJs).toContain('🤖');
    expect(dayViewJs).toContain('coach-overlay-marker');
  });

  it('CDV-7: coach overlay marker has aria-label for accessibility (D18)', () => {
    expect(dayViewJs).toContain('aria-label');
    expect(dayViewJs).toContain('Coach active on this item');
  });

  it('CDV-8: renders empty state when no items due today', () => {
    expect(dayViewJs).toContain('calendar-day-empty');
    expect(dayViewJs).toContain('No items due today.');
  });

  it('CDV-9: hourly grid uses UTC hour accessors (getUTCHours — not getHours)', () => {
    expect(dayViewJs).toContain('getUTCHours');
    expect(dayViewJs).not.toContain('.getHours()');
  });

  it('CDV-10: handles DnD dragover/dragleave/drop on hour slots', () => {
    expect(dayViewJs).toContain('dragover');
    expect(dayViewJs).toContain('dragleave');
    expect(dayViewJs).toContain('drop');
    expect(dayViewJs).toContain('cell-drop-target');
  });
});

describe('calendar-day-view.js — coach overlay', () => {
  it('CDV-O-1: coachItemIds parameter defaults to empty Set (no overlay when absent)', () => {
    // Function signature has coachItemIds = new Set()
    expect(dayViewJs).toContain('coachItemIds = new Set()');
  });

  it('CDV-O-2: uses coachItemIds.has() to check overlay (not indexOf)', () => {
    expect(dayViewJs).toContain('coachItemIds.has(');
  });
});
