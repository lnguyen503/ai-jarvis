/**
 * Unit tests for v1.20.0 ADR 020 D19: today-focus-card spontaneous activity feed.
 *
 * Validates structural/safety properties of:
 *   public/webapp/organize/today-focus-card.js
 *     - extractSpontaneousActivity logic (via source inspection)
 *     - formatRelativeTime helper
 *     - buildSpontaneousSection + buildSpontaneousRow
 *
 * Fast; no browser or server required (source code inspection + JSDOM not available).
 * All assertions are on source text / behavioral contracts.
 *
 * Test IDs: TFS-* (Today Focus card Spontaneous activity)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const src = readFileSync(
  path.join(root, 'public/webapp/organize/today-focus-card.js'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Source code structure — extractSpontaneousActivity
// ---------------------------------------------------------------------------
describe('today-focus-card spontaneous activity — source structure', () => {
  it('TFS-1: extractSpontaneousActivity function exists', () => {
    expect(src).toContain('function extractSpontaneousActivity');
  });

  it('TFS-2: filters on LAST_SPONTANEOUS_SUBKEY constant (.lastSpontaneousAt)', () => {
    expect(src).toContain("LAST_SPONTANEOUS_SUBKEY = '.lastSpontaneousAt'");
    expect(src).toContain('LAST_SPONTANEOUS_SUBKEY');
  });

  it('TFS-3: reads triggerType from body and defaults to item-state on missing', () => {
    expect(src).toContain("'item-state'"); // fallback for older entries
    expect(src).toContain("body['triggerType']");
  });

  it('TFS-4: sorts activity most-recent-first before slicing', () => {
    expect(src).toContain('tb - ta'); // descending sort
  });

  it('TFS-5: limits to last 3 entries (slice(0, 3))', () => {
    expect(src).toContain('slice(0, 3)');
  });

  it('TFS-6: returns item from items array (or null if not found)', () => {
    expect(src).toContain('items.find((i) => i.id === itemId)');
    expect(src).toContain('?? null');
  });
});

// ---------------------------------------------------------------------------
// Source code structure — TRIGGER_TYPE_ICONS
// ---------------------------------------------------------------------------
describe('today-focus-card spontaneous activity — trigger type icons', () => {
  it('TFS-7: TRIGGER_TYPE_ICONS constant exists', () => {
    expect(src).toContain('TRIGGER_TYPE_ICONS');
  });

  it('TFS-8: item-state trigger type maps to target icon', () => {
    expect(src).toContain("'item-state': '🎯'");
  });

  it('TFS-9: chat trigger type maps to speech bubble icon', () => {
    expect(src).toContain("'chat': '💬'");
  });

  it('TFS-10: calendar trigger type maps to calendar icon', () => {
    expect(src).toContain("'calendar': '📅'");
  });
});

// ---------------------------------------------------------------------------
// Source code structure — formatRelativeTime
// ---------------------------------------------------------------------------
describe('today-focus-card spontaneous activity — formatRelativeTime', () => {
  it('TFS-11: formatRelativeTime function exists', () => {
    expect(src).toContain('function formatRelativeTime');
  });

  it('TFS-12: handles "just now" for very recent events', () => {
    expect(src).toContain("'just now'");
  });

  it('TFS-13: formats hours ago with "h ago" suffix', () => {
    expect(src).toContain("'h ago'");
  });

  it('TFS-14: formats "yesterday" for 1 day ago', () => {
    expect(src).toContain("'yesterday'");
  });

  it('TFS-15: formats "d ago" for multi-day entries', () => {
    expect(src).toContain("'d ago'");
  });
});

// ---------------------------------------------------------------------------
// Source code structure — buildSpontaneousSection + buildSpontaneousRow
// ---------------------------------------------------------------------------
describe('today-focus-card spontaneous activity — DOM builders', () => {
  it('TFS-16: buildSpontaneousSection function exists', () => {
    expect(src).toContain('function buildSpontaneousSection');
  });

  it('TFS-17: buildSpontaneousRow function exists', () => {
    expect(src).toContain('function buildSpontaneousRow');
  });

  it('TFS-18: spontaneous section uses today-spont-section CSS class', () => {
    expect(src).toContain('today-spont-section');
  });

  it('TFS-19: buildSpontaneousRow renders item title via textContent (XSS guard)', () => {
    expect(src).toContain('titleEl.textContent = title');
    // Must NOT set innerHTML with user content
    expect(src).not.toMatch(/titleEl\.innerHTML\s*=\s*[^'"]/);
  });

  it('TFS-20: spontaneous section is collapsible with sessionStorage persistence', () => {
    expect(src).toContain("SPONT_COLLAPSE_KEY = 'today-spont-activity-collapsed'");
    expect(src).toContain("sessionStorage.setItem(SPONT_COLLAPSE_KEY");
    expect(src).toContain("sessionStorage.removeItem(SPONT_COLLAPSE_KEY");
  });
});

// ---------------------------------------------------------------------------
// Integration into renderCard + renderTodayFocusCard
// ---------------------------------------------------------------------------
describe('today-focus-card spontaneous activity — rendering integration', () => {
  it('TFS-21: renderTodayFocusCard calls extractSpontaneousActivity', () => {
    expect(src).toContain('extractSpontaneousActivity(data.entries, items)');
  });

  it('TFS-22: renderCard receives spontaneousActivity as 4th argument', () => {
    // The function signature must include spontaneousActivity
    expect(src).toContain('function renderCard(todayIso, coachPicks, dueTodayItems, spontaneousActivity');
  });

  it('TFS-23: spontaneous section only appended when activity.length > 0 (hidden on empty)', () => {
    expect(src).toContain('if (spontaneousActivity.length > 0)');
  });

  it('TFS-24: renderCard call in renderTodayFocusCard passes spontaneousActivity', () => {
    expect(src).toContain('renderCard(todayIso, coachPicks, dueTodayItems, spontaneousActivity');
  });
});
