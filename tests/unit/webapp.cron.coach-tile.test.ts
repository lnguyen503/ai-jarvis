/**
 * Unit tests for v1.20.0 ADR 020 D18: multi-profile coach tile UI additions to cron tile.
 *
 * Validates structural/safety properties of:
 *   - public/webapp/cron/app.js   — profile marker constants, renderTaskList per profile,
 *                                   profile picker, weekday picker
 *   - public/webapp/cron/index.html — multi-profile setup section structure
 *   - public/webapp/cron/styles.css — new CSS classes for profile/weekday picker
 *
 * Fast; no browser or server required (source code inspection).
 *
 * Test IDs: CMT-* (Coach Multi-profile Tile)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const indexHtml = readFileSync(path.join(root, 'public/webapp/cron/index.html'), 'utf8');
const appJs     = readFileSync(path.join(root, 'public/webapp/cron/app.js'), 'utf8');
const stylesCSS = readFileSync(path.join(root, 'public/webapp/cron/styles.css'), 'utf8');

// ---------------------------------------------------------------------------
// app.js: marker constants + helper functions
// ---------------------------------------------------------------------------
describe('cron multi-profile coach tile — app.js constants', () => {
  it('CMT-1: declares COACH_MARKER_PREFIX constant', () => {
    expect(appJs).toContain("COACH_MARKER_PREFIX = '__coach_'");
  });

  it('CMT-2: declares COACH_PROFILES array with all 4 profiles', () => {
    expect(appJs).toContain("'morning'");
    expect(appJs).toContain("'midday'");
    expect(appJs).toContain("'evening'");
    expect(appJs).toContain("'weekly'");
    expect(appJs).toContain('COACH_PROFILES');
  });

  it('CMT-3: declares COACH_MARKER_BY_PROFILE with per-profile markers', () => {
    expect(appJs).toContain('COACH_MARKER_BY_PROFILE');
    expect(appJs).toContain("'__coach_morning__'");
    expect(appJs).toContain("'__coach_midday__'");
    expect(appJs).toContain("'__coach_evening__'");
    expect(appJs).toContain("'__coach_weekly__'");
  });

  it('CMT-4: isCoachProfileMarker helper function exists', () => {
    expect(appJs).toContain('function isCoachProfileMarker');
  });

  it('CMT-5: profileFromMarker helper function exists', () => {
    expect(appJs).toContain('function profileFromMarker');
  });

  it('CMT-6: isAnyCoachTask helper function exists', () => {
    expect(appJs).toContain('function isAnyCoachTask');
  });

  it('CMT-7: COACH_PROFILE_LABELS declared with all profiles', () => {
    expect(appJs).toContain('COACH_PROFILE_LABELS');
    expect(appJs).toContain("'Coach (morning)'");
    expect(appJs).toContain("'Coach (midday)'");
    expect(appJs).toContain("'Coach (evening)'");
    expect(appJs).toContain("'Coach (weekly)'");
  });
});

// ---------------------------------------------------------------------------
// app.js: profile picker selection + weekday picker
// ---------------------------------------------------------------------------
describe('cron multi-profile coach tile — app.js profile picker', () => {
  it('CMT-8: selectCoachProfile function exists', () => {
    expect(appJs).toContain('function selectCoachProfile');
  });

  it('CMT-9: selectCoachWeekday function exists', () => {
    expect(appJs).toContain('function selectCoachWeekday');
  });

  it('CMT-10: handleCoachProfileSave function exists', () => {
    expect(appJs).toContain('function handleCoachProfileSave');
  });

  it('CMT-11: handleCoachProfileSave posts to /api/webapp/coach/setup with profile body', () => {
    expect(appJs).toContain('/api/webapp/coach/setup');
    expect(appJs).toContain("profile: _selectedProfile");
    expect(appJs).toContain("hhmm: timeVal");
  });

  it('CMT-12: weekly profile save includes weekday in body', () => {
    expect(appJs).toContain("body.weekday = _selectedWeekday");
  });
});

// ---------------------------------------------------------------------------
// app.js: renderTaskList multi-profile badge rendering
// ---------------------------------------------------------------------------
describe('cron multi-profile coach tile — app.js renderTaskList', () => {
  it('CMT-13: renderTaskList checks isCoachProfileMarker for multi-profile tasks', () => {
    expect(appJs).toContain('isCoachProfileMarker(task.description)');
  });

  it('CMT-14: multi-profile badge uses COACH_PROFILE_LABELS via textContent', () => {
    // Must look up the label from COACH_PROFILE_LABELS, not inline strings
    expect(appJs).toContain('COACH_PROFILE_LABELS[coachProfile]');
    // Must use textContent (not innerHTML) for badge content
    expect(appJs).toContain('coachBadge.textContent');
  });

  it('CMT-15: badge-coach-profile CSS class applied for multi-profile tasks', () => {
    expect(appJs).toContain('badge-coach-profile');
  });

  it('CMT-16: profile-specific task description uses profile label (not raw sentinel)', () => {
    // The desc for a profile task must show a friendly name, not '__coach_morning__'
    expect(appJs).toContain("COACH_PROFILE_LABELS[coachProfile] + ' session'");
  });

  it('CMT-17: legacy __coach__ task still gets coach badge (back-compat)', () => {
    expect(appJs).toContain('isLegacyCoachTask');
    // legacy path shows '🤖 Coach'
    expect(appJs).toContain("'🤖 Coach'");
  });
});

// ---------------------------------------------------------------------------
// index.html: multi-profile setup DOM structure
// ---------------------------------------------------------------------------
describe('cron multi-profile coach tile — index.html', () => {
  it('CMT-18: has coach-multi-profile-setup container', () => {
    expect(indexHtml).toContain('id="coach-multi-profile-setup"');
  });

  it('CMT-19: has profile picker buttons for all 4 profiles', () => {
    expect(indexHtml).toContain('data-profile="morning"');
    expect(indexHtml).toContain('data-profile="midday"');
    expect(indexHtml).toContain('data-profile="evening"');
    expect(indexHtml).toContain('data-profile="weekly"');
  });

  it('CMT-20: has weekday picker container with 7 buttons (Sun-Sat)', () => {
    expect(indexHtml).toContain('id="coach-weekday-picker"');
    expect(indexHtml).toContain('data-dow="0"'); // Sun
    expect(indexHtml).toContain('data-dow="1"'); // Mon
    expect(indexHtml).toContain('data-dow="6"'); // Sat
  });

  it('CMT-21: has coach-profile-time input and coach-profile-save button', () => {
    expect(indexHtml).toContain('id="coach-profile-time"');
    expect(indexHtml).toContain('id="coach-profile-save"');
  });

  it('CMT-22: has coach-profile-save-error element', () => {
    expect(indexHtml).toContain('id="coach-profile-save-error"');
  });

  it('CMT-23: weekday picker has hidden attribute by default (only shown for weekly)', () => {
    expect(indexHtml).toMatch(/id="coach-weekday-picker"[^>]*hidden/);
  });

  it('CMT-24: profile picker buttons have aria-pressed attributes (accessibility)', () => {
    expect(indexHtml).toContain('aria-pressed="true"');
    expect(indexHtml).toContain('aria-pressed="false"');
  });
});

// ---------------------------------------------------------------------------
// styles.css: new CSS classes
// ---------------------------------------------------------------------------
describe('cron multi-profile coach tile — styles.css', () => {
  it('CMT-25: has .coach-multi-profile-setup rule', () => {
    expect(stylesCSS).toContain('.coach-multi-profile-setup');
  });

  it('CMT-26: has .coach-profile-picker rule', () => {
    expect(stylesCSS).toContain('.coach-profile-picker');
  });

  it('CMT-27: has .coach-profile-btn rule', () => {
    expect(stylesCSS).toContain('.coach-profile-btn');
  });

  it('CMT-28: has .coach-profile-btn.active rule', () => {
    expect(stylesCSS).toContain('.coach-profile-btn.active');
  });

  it('CMT-29: has .coach-weekday-picker rule', () => {
    expect(stylesCSS).toContain('.coach-weekday-picker');
  });

  it('CMT-30: has .coach-weekday-btn rule', () => {
    expect(stylesCSS).toContain('.coach-weekday-btn');
  });

  it('CMT-31: has .coach-weekday-btn.active rule', () => {
    expect(stylesCSS).toContain('.coach-weekday-btn.active');
  });

  it('CMT-32: has .badge-coach-profile rule', () => {
    expect(stylesCSS).toContain('.badge-coach-profile');
  });
});
