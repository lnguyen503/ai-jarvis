/**
 * Client-side unit tests for v1.18.0 ADR 018 D1 coach UI additions:
 *   - edit-form.js: Coaching subsection (pill picker, nudge info, PATCH dispatch)
 *   - list-view.js: intensity badge on cards
 *   - app.js: "Coached only" filter chip + coachedOnlyFilter logic
 *   - index.html: coaching fieldset, filter chip, CSS class markers
 *   - styles.css: .coach-pill-picker, .coach-pill, .coach-badge, .coach-filter-chip
 *
 * These tests load source files via fs.readFileSync and assert structural/
 * safety properties (no live execution). Fast; no browser or server required.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const indexHtml  = readFileSync(path.join(root, 'public/webapp/organize/index.html'), 'utf8');
const appJs      = readFileSync(path.join(root, 'public/webapp/organize/app.js'), 'utf8');
const editFormJs = readFileSync(path.join(root, 'public/webapp/organize/edit-form.js'), 'utf8');
const listViewJs = readFileSync(path.join(root, 'public/webapp/organize/list-view.js'), 'utf8');
const stylesCSS  = readFileSync(path.join(root, 'public/webapp/organize/styles.css'), 'utf8');

// ---------------------------------------------------------------------------
// index.html structure
// ---------------------------------------------------------------------------
describe('coach UI — index.html', () => {
  it('CI-1: has coaching fieldset with id edit-coach-section', () => {
    expect(indexHtml).toContain('id="edit-coach-section"');
  });

  it('CI-2: has all 5 coach intensity pill buttons (auto/off/gentle/moderate/persistent) — v1.19.0 D1 cross-review I1', () => {
    expect(indexHtml).toContain('data-intensity="auto"');
    expect(indexHtml).toContain('data-intensity="off"');
    expect(indexHtml).toContain('data-intensity="gentle"');
    expect(indexHtml).toContain('data-intensity="moderate"');
    expect(indexHtml).toContain('data-intensity="persistent"');
    // Verify exactly 5 pill buttons in the picker (no duplicates, no missing values)
    const pillMatches = indexHtml.match(/data-intensity="(auto|off|gentle|moderate|persistent)"/g) || [];
    expect(pillMatches.length).toBe(5);
  });

  it('CI-3: has coach nudge info element', () => {
    expect(indexHtml).toContain('id="edit-coach-nudge-info"');
  });

  it('CI-4: has coached-only filter chip', () => {
    expect(indexHtml).toContain('id="filter-coached"');
  });

  it('CI-5: coach pill picker container has id edit-coach-intensity', () => {
    expect(indexHtml).toContain('id="edit-coach-intensity"');
  });
});

// ---------------------------------------------------------------------------
// edit-form.js
// ---------------------------------------------------------------------------
describe('coach UI — edit-form.js', () => {
  it('EF-1: declares _coachIntensityEl and _coachNudgeInfoEl module-level vars', () => {
    expect(editFormJs).toContain('_coachIntensityEl');
    expect(editFormJs).toContain('_coachNudgeInfoEl');
  });

  it('EF-2: wires coach-pill click listeners in initEditForm', () => {
    expect(editFormJs).toContain('coach-pill');
    expect(editFormJs).toContain('querySelectorAll');
  });

  it('EF-3: enterEditMode populates coach intensity from item.coachIntensity', () => {
    expect(editFormJs).toContain('coachIntensity');
    // intensity pill activation uses dataset.intensity comparison
    expect(editFormJs).toContain("dataset.intensity === intensity");
  });

  it('EF-4: enterEditMode sets nudge count info text', () => {
    expect(editFormJs).toContain('coachNudgeCount');
    expect(editFormJs).toContain('nudge');
  });

  it('EF-5: cancelEdit restores coach intensity pill state', () => {
    // cancelEdit should reference coachIntensity restoration
    expect(editFormJs).toContain('currentDetailItem.coachIntensity');
  });

  it('EF-6: submitEdit captures coachIntensity from active pill and includes in patch when changed', () => {
    // Must read active pill dataset.intensity and compare to currentDetailItem.coachIntensity
    expect(editFormJs).toContain("patch.coachIntensity");
  });

  it('EF-7: coach pills use textContent (never innerHTML) — security invariant', () => {
    // Pill text is hardcoded in HTML; JS only toggles class. No innerHTML = user data here.
    // But ensure no innerHTML call with user-supplied coach content.
    // The coach section should not use innerHTML to set intensity labels.
    expect(editFormJs).not.toMatch(/innerHTML\s*=\s*.*coachIntensity/);
  });
});

// ---------------------------------------------------------------------------
// list-view.js
// ---------------------------------------------------------------------------
describe('coach UI — list-view.js', () => {
  it('LV-1: buildItemCard renders coach badge for coached items', () => {
    expect(listViewJs).toContain('coach-badge');
  });

  it('LV-2: badge only shown when intensity !== off', () => {
    expect(listViewJs).toContain("!== 'off'");
  });

  it('LV-3: coach badge uses textContent (never innerHTML) — security invariant', () => {
    // The badge text (emoji) is from our own lookup object, not from user input
    // Verify: coachBadge.textContent = ... (not innerHTML)
    expect(listViewJs).toContain('coachBadge.textContent');
    // ensure no innerHTML assignment near coach badge
    expect(listViewJs).not.toMatch(/coachBadge\.innerHTML/);
  });

  it('LV-4: badge has coach-badge CSS class', () => {
    expect(listViewJs).toMatch(/coach-badge-\$\{intensity\}|coach-badge-/);
  });

  it('LV-5: badge icons defined for gentle, moderate, persistent', () => {
    expect(listViewJs).toContain('gentle');
    expect(listViewJs).toContain('moderate');
    expect(listViewJs).toContain('persistent');
  });
});

// ---------------------------------------------------------------------------
// app.js
// ---------------------------------------------------------------------------
describe('coach UI — app.js', () => {
  it('AP-1: declares coachedOnlyFilter boolean', () => {
    expect(appJs).toContain('coachedOnlyFilter');
  });

  it('AP-2: coached-only chip click toggles coachedOnlyFilter', () => {
    expect(appJs).toContain('filter-coached');
    expect(appJs).toContain('coachedOnlyFilter = !coachedOnlyFilter');
  });

  it('AP-3: fetchItems applies client-side coached filter when coachedOnlyFilter is true', () => {
    expect(appJs).toContain("coachedOnlyFilter");
    expect(appJs).toContain("it.coachIntensity");
  });

  it('AP-4: updateFilterChips toggles active class on coached chip', () => {
    expect(appJs).toContain('filter-coached');
    expect(appJs).toContain('coachedOnlyFilter');
  });
});

// ---------------------------------------------------------------------------
// styles.css
// ---------------------------------------------------------------------------
describe('coach UI — styles.css', () => {
  it('CSS-1: has .coach-pill-picker style', () => {
    expect(stylesCSS).toContain('.coach-pill-picker');
  });

  it('CSS-2: has .coach-pill style', () => {
    expect(stylesCSS).toContain('.coach-pill');
  });

  it('CSS-3: has .coach-pill.active style', () => {
    expect(stylesCSS).toContain('.coach-pill.active');
  });

  it('CSS-4: has .coach-badge style', () => {
    expect(stylesCSS).toContain('.coach-badge');
  });

  it('CSS-5: has intensity-specific badge variants', () => {
    expect(stylesCSS).toContain('.coach-badge-gentle');
    expect(stylesCSS).toContain('.coach-badge-moderate');
    expect(stylesCSS).toContain('.coach-badge-persistent');
  });

  it('CSS-6: has .coach-filter-chip.active style', () => {
    expect(stylesCSS).toContain('.coach-filter-chip.active');
  });

  it('CSS-7: has #edit-coach-section style', () => {
    expect(stylesCSS).toContain('#edit-coach-section');
  });
});
