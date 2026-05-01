/**
 * Unit tests for v1.19.0 commit 12 — visual hierarchy color + accessibility icons.
 *
 * Tests assert structural/safety properties via fs.readFileSync.
 *
 * Coverage:
 *  - VH-1 through VH-5 (spec: ~5 cases)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const monthViewJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-month-view.js'), 'utf8');
const stylesCSS = readFileSync(path.join(root, 'public/webapp/organize/styles.css'), 'utf8');
const dayViewJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-day-view.js'), 'utf8');
const weekViewJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-week-view.js'), 'utf8');

describe('visual hierarchy — calendar-month-view.js', () => {
  it('VH-1: applies type-goal / type-task / type-event CSS classes based on item.type', () => {
    expect(monthViewJs).toContain("classList.add('type-goal')");
    expect(monthViewJs).toContain("classList.add('type-task')");
    expect(monthViewJs).toContain("classList.add('type-event')");
  });

  it('VH-2: applies status-active / status-done / status-overdue CSS classes', () => {
    expect(monthViewJs).toContain("classList.add('status-done')");
    expect(monthViewJs).toContain("classList.add('status-active')");
    expect(monthViewJs).toContain("classList.add('status-overdue')");
  });

  it('VH-3: applies coach-persistent ring class for persistent intensity', () => {
    expect(monthViewJs).toContain("classList.add('coach-persistent')");
  });

  it('VH-4: accessibility icons use aria-label (D18 — not color alone)', () => {
    expect(monthViewJs).toContain('aria-label');
    expect(monthViewJs).toContain("'Done'");
    expect(monthViewJs).toContain("'Overdue'");
    expect(monthViewJs).toContain('overdue-icon');
    expect(monthViewJs).toContain('done-icon');
  });

  it('VH-5: exports applyItemClasses and appendAccessibilityIcon helpers', () => {
    expect(monthViewJs).toContain('export function applyItemClasses');
    expect(monthViewJs).toContain('export function appendAccessibilityIcon');
  });
});

describe('visual hierarchy — styles.css classes', () => {
  it('VH-CSS-1: defines .calendar-item-pill.type-goal (purple)', () => {
    expect(stylesCSS).toContain('.calendar-item-pill.type-goal');
  });

  it('VH-CSS-2: defines .calendar-item-pill.type-task (blue)', () => {
    expect(stylesCSS).toContain('.calendar-item-pill.type-task');
  });

  it('VH-CSS-3: defines .calendar-item-pill.type-event (green)', () => {
    expect(stylesCSS).toContain('.calendar-item-pill.type-event');
  });

  it('VH-CSS-4: defines .calendar-item-pill.status-overdue (red border)', () => {
    expect(stylesCSS).toContain('.calendar-item-pill.status-overdue');
  });

  it('VH-CSS-5: defines .coach-persistent ring', () => {
    expect(stylesCSS).toContain('.calendar-item-pill.coach-persistent');
  });
});
