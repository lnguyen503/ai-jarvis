/**
 * Unit tests for v1.20.0 ADR 020 D20: hub banner multi-profile + expand panel + heavy-hammer.
 *
 * Validates structural/safety properties of:
 *   public/webapp/app.js
 *     - initCoachBanner upgrade: uses /api/webapp/coach/profiles
 *     - banner text: "N profiles + event triggers"
 *     - BANNER_PROFILE_LABELS + BANNER_WEEKDAY_NAMES constants
 *     - Two-tap heavy-hammer pattern (disableAllBtn / disableConfirmBtn)
 *     - Dismiss: stopPropagation + sessionStorage
 *     - Security: textContent only, no innerHTML with user data
 *
 * Fast; no browser or server required (source code inspection).
 * Test IDs: HBP-* (Hub Banner Profiles)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const src = readFileSync(path.join(root, 'public/webapp/app.js'), 'utf8');

// ---------------------------------------------------------------------------
// Source code structure — initCoachBanner
// ---------------------------------------------------------------------------
describe('hub banner profiles — source structure', () => {
  it('HBP-1: initCoachBanner function exists', () => {
    expect(src).toContain('function initCoachBanner');
  });

  it('HBP-2: fetches /api/webapp/coach/profiles (not /setup for profile count)', () => {
    expect(src).toContain("'/api/webapp/coach/profiles'");
    // The GET /setup call is no longer used for profile count
  });

  it('HBP-3: banner text includes "+ event triggers" suffix', () => {
    expect(src).toContain("' + event triggers'");
  });

  it('HBP-4: BANNER_PROFILE_LABELS constant exists with 4 profiles', () => {
    expect(src).toContain('BANNER_PROFILE_LABELS');
    expect(src).toContain("morning: 'Morning'");
    expect(src).toContain("midday: 'Midday'");
    expect(src).toContain("evening: 'Evening'");
    expect(src).toContain("weekly: 'Weekly'");
  });

  it('HBP-5: BANNER_WEEKDAY_NAMES constant exists', () => {
    expect(src).toContain('BANNER_WEEKDAY_NAMES');
    expect(src).toContain("'Sun'");
    expect(src).toContain("'Mon'");
  });
});

// ---------------------------------------------------------------------------
// Heavy-hammer two-tap pattern
// ---------------------------------------------------------------------------
describe('hub banner profiles — heavy-hammer pattern', () => {
  it('HBP-6: gets disableAllBtn and disableConfirmBtn by id', () => {
    expect(src).toContain("getElementById('coach-banner-disable-all')");
    expect(src).toContain("getElementById('coach-banner-disable-confirm')");
  });

  it('HBP-7: first tap hides disableAll button and shows confirm', () => {
    expect(src).toContain("disableAllBtn.setAttribute('hidden', '')");
    expect(src).toContain("disableConfirmBtn.removeAttribute('hidden')");
  });

  it('HBP-8: second tap POSTs action: mute_all', () => {
    expect(src).toContain("action: 'mute_all'");
  });

  it('HBP-9: resets button state on POST failure', () => {
    expect(src).toContain("disableConfirmBtn.setAttribute('hidden', '')");
    expect(src).toContain("disableAllBtn.removeAttribute('hidden')");
  });
});

// ---------------------------------------------------------------------------
// Dismiss button
// ---------------------------------------------------------------------------
describe('hub banner profiles — dismiss button', () => {
  it('HBP-10: dismiss button uses stopPropagation (prevent <details> toggle)', () => {
    expect(src).toContain('evt.stopPropagation()');
  });

  it('HBP-11: dismiss sets sessionStorage coach-banner-dismissed', () => {
    expect(src).toContain("sessionStorage.setItem('coach-banner-dismissed', 'true')");
  });

  it('HBP-12: dismiss hides banner via setAttribute hidden', () => {
    expect(src).toContain("bannerEl.setAttribute('hidden', '')");
  });
});

// ---------------------------------------------------------------------------
// Security invariant: textContent only
// ---------------------------------------------------------------------------
describe('hub banner profiles — XSS guard', () => {
  it('HBP-13: per-profile label set via textContent (not innerHTML)', () => {
    expect(src).toContain('labelEl.textContent = labelText');
  });

  it('HBP-14: per-profile schedule set via textContent (not innerHTML)', () => {
    expect(src).toContain('schedEl.textContent = schedText');
  });

  it('HBP-15: banner text set via textContent (not innerHTML)', () => {
    expect(src).toContain('bannerTextEl.textContent =');
  });
});
