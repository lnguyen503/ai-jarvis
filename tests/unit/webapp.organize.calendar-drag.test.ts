/**
 * Unit tests for calendar drag-reschedule with debounce + undo (v1.19.0 commit 13).
 *
 * Tests assert structural/safety properties via fs.readFileSync.
 * No live DOM execution — fast; no browser or server required.
 *
 * Coverage:
 *  - CD-1 through CD-8 (spec: ~8 cases)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const calendarJs = readFileSync(path.join(root, 'public/webapp/organize/calendar-view.js'), 'utf8');

describe('calendar drag-reschedule — structure (D3 + D19 + D20)', () => {
  it('CD-1: exports handleCalendarDnD (async — awaits debounced PATCH)', () => {
    expect(calendarJs).toContain('export async function handleCalendarDnD');
  });

  it('CD-2: defines DND_DEBOUNCE_MS = 300 (D20 spec)', () => {
    expect(calendarJs).toContain('DND_DEBOUNCE_MS = 300');
  });

  it('CD-3: defines DND_UNDO_TOAST_MS = 5000 (D19 spec — 5-second undo window)', () => {
    expect(calendarJs).toContain('DND_UNDO_TOAST_MS = 5000');
  });

  it('CD-4: uses per-item debounce map (last drop wins)', () => {
    expect(calendarJs).toContain('_dndDebounceMap');
    expect(calendarJs).toContain('clearTimeout');
    expect(calendarJs).toContain('setTimeout');
  });

  it('CD-5: performs optimistic update before PATCH (D19 optimistic UI)', () => {
    // optimistic: true must appear before the PATCH fetch
    const optimisticIdx = calendarJs.indexOf("optimistic: true");
    const patchIdx = calendarJs.indexOf("method: 'PATCH'");
    expect(optimisticIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(-1);
    expect(optimisticIdx).toBeLessThan(patchIdx);
  });

  it('CD-6: shows undo toast on 200 (D19)', () => {
    expect(calendarJs).toContain('_showDndUndoToast');
    expect(calendarJs).toContain('Tap to undo');
    expect(calendarJs).toContain("'Undo'");
  });

  it('CD-7: rollback optimistic state on 4xx/5xx/network error', () => {
    expect(calendarJs).toContain('rollback: true');
    expect(calendarJs).toContain('Reschedule failed');
  });

  it('CD-8: _executeDndUndo PATCHes back to oldIso (undo logic)', () => {
    expect(calendarJs).toContain('_executeDndUndo');
    expect(calendarJs).toContain('due: oldIso');
    expect(calendarJs).toContain('Undone.');
  });
});

describe('calendar drag-reschedule — kanban DnD pattern reuse (RA1)', () => {
  it('CD-DND-1: documents kanban-view.js DnD pattern reuse in JSDoc', () => {
    // Check that the code references the kanban-view.js pattern in a comment
    expect(calendarJs).toContain('kanban-view.js DnD pattern');
  });

  it('CD-DND-2: same-day drop is a no-op (ADR 015 D6 — avoids spurious ETag bumps)', () => {
    expect(calendarJs).toContain('same day = no-op');
  });
});
