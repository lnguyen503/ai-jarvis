/**
 * Unit tests for v1.19.0 commit 15 — empty-state polish.
 *
 * Tests assert structural/safety properties via fs.readFileSync.
 *
 * Coverage:
 *  - ES-1 through ES-5 (spec: ~5 cases)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const indexHtml = readFileSync(path.join(root, 'public/webapp/organize/index.html'), 'utf8');
const stylesCSS = readFileSync(path.join(root, 'public/webapp/organize/styles.css'), 'utf8');
const dayViewJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-day-view.js'), 'utf8');
const weekViewJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-week-view.js'), 'utf8');
const focusCardJs = readFileSync(path.join(root, 'public/webapp/organize/today-focus-card.js'), 'utf8');

describe('empty-state polish — organize/index.html', () => {
  it('ES-1: #empty-state uses empty-state-graphic class (D5 visual upgrade)', () => {
    expect(indexHtml).toContain('empty-state-graphic');
    expect(indexHtml).toContain('id="empty-state"');
  });

  it('ES-2: #empty-state has empty-state-icon element', () => {
    expect(indexHtml).toContain('empty-state-icon');
  });

  it('ES-3: #empty-state has empty-state-message element', () => {
    expect(indexHtml).toContain('empty-state-message');
  });
});

describe('empty-state polish — styles.css', () => {
  it('ES-CSS-1: defines .empty-state-graphic class', () => {
    expect(stylesCSS).toContain('.empty-state-graphic');
  });

  it('ES-CSS-2: defines .empty-state-icon class', () => {
    expect(stylesCSS).toContain('.empty-state-icon');
  });

  it('ES-CSS-3: defines .empty-state-message class', () => {
    expect(stylesCSS).toContain('.empty-state-message');
  });
});

describe('empty-state polish — calendar views (D5)', () => {
  it('ES-CAL-1: day view renders empty state text when no items due', () => {
    expect(dayViewJs).toContain('No items due today.');
    expect(dayViewJs).toContain('calendar-day-empty');
  });

  it('ES-CAL-2: Today focus card renders empty state with nudge CTA', () => {
    expect(focusCardJs).toContain('Nothing on the docket today');
    expect(focusCardJs).toContain('today-focus-empty');
  });
});
