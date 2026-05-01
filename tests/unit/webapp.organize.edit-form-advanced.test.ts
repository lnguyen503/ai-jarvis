/**
 * Unit tests for v1.19.0 commit 16 — coaching pill picker behind Advanced disclosure (D16).
 *
 * Tests assert structural/safety properties via fs.readFileSync.
 *
 * Coverage:
 *  - ADV-1: index.html has <details class="coach-advanced"> wrapping the pill picker
 *  - ADV-2: index.html has <summary> inside <details>
 *  - ADV-3: index.html has intensity badge always visible outside <details>
 *  - ADV-4: edit-form.js defines _updateCoachIntensityBadge using textContent (not innerHTML assignment)
 *  - ADV-5: edit-form.js calls _updateCoachIntensityBadge in enterEditMode
 *  - ADV-6: edit-form.js calls _updateCoachIntensityBadge on pill click (initEditForm wiring)
 *  - ADV-7: styles.css defines .coach-advanced and .coach-advanced-summary
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const indexHtml  = readFileSync(path.join(root, 'public/webapp/organize/index.html'), 'utf8');
const editFormJs = readFileSync(path.join(root, 'public/webapp/organize/edit-form.js'), 'utf8');
const stylesCSS  = readFileSync(path.join(root, 'public/webapp/organize/styles.css'), 'utf8');

describe('Advanced disclosure — index.html (D16)', () => {
  it('ADV-1: pill picker is wrapped in <details class="coach-advanced">', () => {
    expect(indexHtml).toContain('coach-advanced');
    expect(indexHtml).toContain('<details');
  });

  it('ADV-2: <details> has a <summary> child for the disclosure label', () => {
    expect(indexHtml).toContain('<summary');
    expect(indexHtml).toContain('coach-advanced-summary');
  });

  it('ADV-3: intensity badge span is present always-visible outside disclosure', () => {
    expect(indexHtml).toContain('id="edit-coach-intensity-badge"');
    // Badge must appear BEFORE the <details> tag so it renders outside the disclosure
    const badgeIdx   = indexHtml.indexOf('id="edit-coach-intensity-badge"');
    const detailsIdx = indexHtml.indexOf('<details');
    expect(badgeIdx).toBeGreaterThanOrEqual(0);
    expect(detailsIdx).toBeGreaterThanOrEqual(0);
    expect(badgeIdx).toBeLessThan(detailsIdx);
  });
});

describe('Advanced disclosure — edit-form.js (D16)', () => {
  it('ADV-4: _updateCoachIntensityBadge sets textContent (not .innerHTML =) — ADR 009 D6', () => {
    expect(editFormJs).toContain('_updateCoachIntensityBadge');
    // The function body must assign via .textContent, not .innerHTML
    const fnIdx = editFormJs.indexOf('function _updateCoachIntensityBadge');
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    // Widened to 900 chars after v1.19.0 D1 added the 'auto' early-return path
    const fnBody = editFormJs.slice(fnIdx, fnIdx + 900);
    expect(fnBody).toContain('.textContent');
    // Must NOT assign via innerHTML (the word may appear in comments but not as assignment)
    expect(fnBody).not.toContain('.innerHTML =');
  });

  it('ADV-5: _updateCoachIntensityBadge is called inside enterEditMode', () => {
    const enterIdx = editFormJs.indexOf('export function enterEditMode');
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    // Search within 2000 chars of enterEditMode's body (coach section is ~1500 chars in)
    const enterBody = editFormJs.slice(enterIdx, enterIdx + 2000);
    expect(enterBody).toContain('_updateCoachIntensityBadge');
  });

  it('ADV-6: _updateCoachIntensityBadge is called on pill click (initEditForm wiring)', () => {
    // The pill click handler must update the badge so it stays in sync while <details> is closed
    const initIdx = editFormJs.indexOf('export function initEditForm');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    // Search within 2500 chars of initEditForm's body (pill wiring is ~1941 chars in)
    const initBody = editFormJs.slice(initIdx, initIdx + 2500);
    expect(initBody).toContain('_updateCoachIntensityBadge');
  });
});

describe('Advanced disclosure — styles.css (D16)', () => {
  it('ADV-CSS-1: defines .coach-advanced class', () => {
    expect(stylesCSS).toContain('.coach-advanced');
  });

  it('ADV-CSS-2: defines .coach-advanced-summary class', () => {
    expect(stylesCSS).toContain('.coach-advanced-summary');
  });
});

// ---------------------------------------------------------------------------
// v1.19.0 D1 cross-review I1 — 'auto' as 5th pill + implicit default
// ---------------------------------------------------------------------------
describe("'auto' intensity pill (D1 cross-review I1)", () => {
  it("AUTO-1: pill picker contains data-intensity='auto' button", () => {
    expect(indexHtml).toContain('data-intensity="auto"');
  });

  it("AUTO-2: enterEditMode falls back to 'auto' (not 'off') when item.coachIntensity unset", () => {
    // The default fallback string changed from 'off' to 'auto' in v1.19.0 D1
    const enterIdx = editFormJs.indexOf('export function enterEditMode');
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    const enterBody = editFormJs.slice(enterIdx, enterIdx + 2000);
    expect(enterBody).toContain("item.coachIntensity || 'auto'");
  });

  it("AUTO-3: submitEdit captures 'auto' as default newIntensity when no pill active", () => {
    // The default fallback for the active-pill query changed from 'off' to 'auto'
    expect(editFormJs).toContain("activeCoachPill.dataset.intensity : 'auto'");
    expect(editFormJs).toContain("currentDetailItem.coachIntensity || 'auto'");
  });

  it("AUTO-4: badge hides entirely when intensity is 'auto' (implicit default)", () => {
    // _updateCoachIntensityBadge must hide the badge when intensity === 'auto'
    const fnIdx = editFormJs.indexOf('function _updateCoachIntensityBadge');
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    const fnBody = editFormJs.slice(fnIdx, fnIdx + 800);
    expect(fnBody).toContain("=== 'auto'");
    expect(fnBody).toContain('hidden = true');
  });

  it("AUTO-5: styles.css gives 'auto' pill a visual default cue (border)", () => {
    expect(stylesCSS).toContain('data-intensity="auto"');
  });
});
