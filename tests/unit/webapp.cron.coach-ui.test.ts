/**
 * Client-side unit tests for v1.18.0 ADR 018 coach UI additions to the Cron tile:
 *   - index.html: coach section, time input, setup btn, reset btn
 *   - app.js: COACH_TASK_DESCRIPTION sentinel, coach badge rendering, handleCoachSetup,
 *             handleResetMemory two-tap, updateCoachSection
 *   - styles.css: .coach-section, .coach-setup-btn, .coach-reset-btn, .badge-coach
 *
 * These tests load source files via fs.readFileSync and assert structural/
 * safety properties (no live execution). Fast; no browser or server required.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const indexHtml = readFileSync(path.join(root, 'public/webapp/cron/index.html'), 'utf8');
const appJs     = readFileSync(path.join(root, 'public/webapp/cron/app.js'), 'utf8');
const stylesCSS = readFileSync(path.join(root, 'public/webapp/cron/styles.css'), 'utf8');

// ---------------------------------------------------------------------------
// index.html structure (commit 10)
// ---------------------------------------------------------------------------
describe('cron coach UI — index.html', () => {
  it('CC-1: has coach section with id coach-section', () => {
    expect(indexHtml).toContain('id="coach-section"');
  });

  it('CC-2: has coach time input with id coach-time-input', () => {
    expect(indexHtml).toContain('id="coach-time-input"');
    expect(indexHtml).toContain('type="time"');
  });

  it('CC-3: has coach setup button with id coach-setup-btn', () => {
    expect(indexHtml).toContain('id="coach-setup-btn"');
  });

  it('CC-4: has coach reset button with id coach-reset-btn', () => {
    expect(indexHtml).toContain('id="coach-reset-btn"');
  });

  it('CC-5: has coach status element with id coach-status', () => {
    expect(indexHtml).toContain('id="coach-status"');
  });

  it('CC-6: has coach setup error element with id coach-setup-error', () => {
    expect(indexHtml).toContain('id="coach-setup-error"');
  });
});

// ---------------------------------------------------------------------------
// app.js structure
// ---------------------------------------------------------------------------
describe('cron coach UI — app.js', () => {
  it('CA-1: declares COACH_TASK_DESCRIPTION constant', () => {
    expect(appJs).toContain('COACH_TASK_DESCRIPTION');
    expect(appJs).toContain("'__coach__'");
  });

  it('CA-2: has badge-coach class assignment for coach task in renderTaskList', () => {
    expect(appJs).toContain('badge-coach');
  });

  it('CA-3: coach badge uses textContent (not innerHTML) — XSS guard', () => {
    // The coach badge must set its content via textContent
    expect(appJs).toContain('coachBadge.textContent');
    // Must NOT set innerHTML with any variable on coachBadge
    expect(appJs).not.toMatch(/coachBadge\.innerHTML\s*=\s*[^'"][^;]*/);
  });

  it('CA-4: handleCoachSetup function exists', () => {
    expect(appJs).toContain('function handleCoachSetup');
  });

  it('CA-5: handleResetMemory function exists with two-tap pattern', () => {
    expect(appJs).toContain('function handleResetMemory');
    expect(appJs).toContain('_resetMemoryArmed');
  });

  it('CA-6: updateCoachSection function exists', () => {
    expect(appJs).toContain('function updateCoachSection');
  });

  it('CA-7: handleCoachSetup posts to /api/webapp/coach/setup', () => {
    expect(appJs).toContain('/api/webapp/coach/setup');
  });

  it('CA-8: handleResetMemory posts to /api/webapp/coach/reset-memory', () => {
    expect(appJs).toContain('/api/webapp/coach/reset-memory');
  });

  it('CA-9: reset-memory call includes ?confirm=1', () => {
    expect(appJs).toContain('?confirm=1');
  });

  it('CA-10: coach section DOM refs wired in DOMContentLoaded', () => {
    expect(appJs).toContain("document.getElementById('coach-section')");
    expect(appJs).toContain("document.getElementById('coach-time-input')");
    expect(appJs).toContain("document.getElementById('coach-setup-btn')");
    expect(appJs).toContain("document.getElementById('coach-reset-btn')");
  });

  it('CA-11: Edit button is suppressed for coach task (no edit button for __coach__)', () => {
    // The isCoachTask check must gate the edit button
    expect(appJs).toContain('isCoachTask');
    expect(appJs).toContain('if (!isCoachTask)');
  });

  it('CA-12: coach task description uses textContent not user-authored content for display', () => {
    // The coach task renders 'Daily coach session' — a hardcoded string, not task.description
    expect(appJs).toContain('Daily coach session');
  });
});

// ---------------------------------------------------------------------------
// styles.css structure
// ---------------------------------------------------------------------------
describe('cron coach UI — styles.css', () => {
  it('CS-1: has .coach-section rule', () => {
    expect(stylesCSS).toContain('.coach-section');
  });

  it('CS-2: has .coach-setup-btn rule', () => {
    expect(stylesCSS).toContain('.coach-setup-btn');
  });

  it('CS-3: has .coach-reset-btn rule', () => {
    expect(stylesCSS).toContain('.coach-reset-btn');
  });

  it('CS-4: has .badge-coach rule', () => {
    expect(stylesCSS).toContain('.badge-coach');
  });

  it('CS-5: has .coach-reset-btn.confirming rule for two-tap visual state', () => {
    expect(stylesCSS).toContain('.coach-reset-btn.confirming');
  });

  it('CS-6: has .task-item-coach rule for coach task border accent', () => {
    expect(stylesCSS).toContain('.task-item-coach');
  });
});
