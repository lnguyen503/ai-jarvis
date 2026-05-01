/**
 * Client-side smoke tests for public/webapp/organize/ (v1.14.2).
 *
 * Vitest cannot execute real browser JS, so these tests load the static
 * source files via fs.readFileSync and assert structural/safety properties:
 *  - CSP compliance (no inline script bodies)
 *  - Presence of required data-attributes used by integration tests + a11y tooling
 *  - No innerHTML usage on user content (security invariant, ADR 009 decision 6)
 *  - Required R7 / R10 / R12.4 implementation markers
 *  - v1.14.2 mutation markers (edit form, checkbox, delete confirm, toast)
 *
 * These tests are intentionally fast and do not require a browser or server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const indexHtml = readFileSync(path.join(root, 'public/webapp/organize/index.html'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/webapp/organize/app.js'), 'utf8');
const editFormJs = readFileSync(path.join(root, 'public/webapp/organize/edit-form.js'), 'utf8');
const listViewJs = readFileSync(path.join(root, 'public/webapp/organize/list-view.js'), 'utf8');
const hierarchyJs = readFileSync(path.join(root, 'public/webapp/organize/hierarchy.js'), 'utf8');

describe('webapp organize client — organize/index.html', () => {
  it('has no inline script bodies (CSP-compliant)', () => {
    // Inline scripts: <script ...> ... some content ... </script> (not self-closing)
    // The only <script> tags allowed are void/src-only forms.
    expect(indexHtml).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
  });

  it('loads the Telegram WebApp SDK from the official CDN', () => {
    expect(indexHtml).toContain('<script src="https://telegram.org/js/telegram-web-app.js">');
  });

  it('loads app.js (v1.14.3: as ES module with defer)', () => {
    // v1.14.3 changed from plain <script defer> to <script type="module" defer>
    // to support hierarchy.js import. The type="module" test is in the v1.14.3 section.
    expect(indexHtml).toContain('src="./app.js"');
    expect(indexHtml).toContain('defer');
  });

  it('has type filter chip markers for integration tests and a11y', () => {
    expect(indexHtml).toContain('data-filter-type="all"');
    expect(indexHtml).toContain('data-filter-type="task"');
    expect(indexHtml).toContain('data-filter-type="event"');
    expect(indexHtml).toContain('data-filter-type="goal"');
  });

  it('has status filter chip markers', () => {
    expect(indexHtml).toContain('data-filter-status="active"');
    expect(indexHtml).toContain('data-filter-status="done"');
    expect(indexHtml).toContain('data-filter-status="all"');
  });

  it('has required structural element IDs', () => {
    expect(indexHtml).toContain('id="item-list"');
    expect(indexHtml).toContain('id="loading"');
    expect(indexHtml).toContain('id="empty-state"');
    expect(indexHtml).toContain('id="error-state"');
    expect(indexHtml).toContain('id="retry-btn"');
    expect(indexHtml).toContain('id="detail-panel"');
    expect(indexHtml).toContain('id="detail-back"');
    expect(indexHtml).toContain('id="detail-title"');
    expect(indexHtml).toContain('id="detail-notes"');
    expect(indexHtml).toContain('id="detail-progress"');
  });

  it('has back link to hub (../)', () => {
    expect(indexHtml).toContain('href="../"');
  });

  it('links the external styles.css', () => {
    expect(indexHtml).toContain('<link rel="stylesheet" href="./styles.css">');
  });
});

describe('webapp organize client — organize/app.js (v1.14.0 invariants)', () => {
  it('does not use innerHTML on user content (ADR 009 decision 6)', () => {
    // Allow .innerHTML = '' (safe empty-clear, e.g. itemListEl.innerHTML = '')
    // Disallow .innerHTML = <any non-empty-string-literal> which would be user content
    // Pattern: .innerHTML = followed by non-empty-string-literal characters
    const dangerous = appJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('uses textContent for rendering user content', () => {
    expect(appJs).toContain('textContent');
  });

  it('wires BackButton with offClick before onClick (R7)', () => {
    // R7: offClick(prev) MUST appear before onClick(next) in setBackButtonAction
    const offClickIdx = appJs.indexOf('offClick');
    const onClickIdx = appJs.indexOf('onClick');
    expect(offClickIdx).toBeGreaterThan(-1);
    expect(onClickIdx).toBeGreaterThan(-1);
    // offClick definition appears before onClick in setBackButtonAction function
    expect(offClickIdx).toBeLessThan(onClickIdx);
  });

  it('persists filter state to sessionStorage with correct key (R10)', () => {
    expect(appJs).toContain('sessionStorage');
    expect(appJs).toContain('organize-filter-state-v1');
  });

  it('subscribes to themeChanged event (R12.4)', () => {
    expect(appJs).toContain('themeChanged');
  });

  it('reads data.ok flag for R3 unified envelope', () => {
    expect(appJs).toContain('data.ok === true');
  });

  it('uses item.due (not item.dueDate) — regression for Fix 1 field-name mismatch', () => {
    // Server returns {due: string|null}; client must read item.due, never item.dueDate.
    // v1.17.0: renderDetail extracted to detail-panel.js — check combined sources.
    const detailPanelJs = readFileSync(path.join(root, 'public/webapp/organize/detail-panel.js'), 'utf8');
    const combined = appJs + detailPanelJs;
    expect(combined).toContain('item.due');
    expect(combined).not.toContain('item.dueDate');
  });

  it('uses Authorization: tma header for API calls (R5)', () => {
    expect(appJs).toContain('tma ${initData}');
  });

  it('calls twa.ready() and twa.expand()', () => {
    expect(appJs).toContain('twa.ready()');
    expect(appJs).toContain('twa.expand()');
  });

  it('defines the FILTER_KEY constant', () => {
    expect(appJs).toContain("FILTER_KEY = 'organize-filter-state-v1'");
  });

  it('defines DEFAULT_FILTERS with type, status, tag', () => {
    expect(appJs).toContain('DEFAULT_FILTERS');
    expect(appJs).toContain("type: 'all'");
    expect(appJs).toContain("status: 'active'");
    expect(appJs).toContain('tag: null');
  });
});

// ------------------------------------------------------------------
// v1.14.2 — Mutation feature tests
// ------------------------------------------------------------------

describe('webapp organize client — v1.14.2 index.html structure', () => {
  it('edit form uses <input type="date"> for due field (W6 anti-custom-picker)', () => {
    expect(indexHtml).toContain('type="date"');
    expect(indexHtml).toContain('id="edit-due"');
  });

  it('status pills have data-status markers for active, done, and abandoned', () => {
    expect(indexHtml).toContain('data-status="active"');
    expect(indexHtml).toContain('data-status="done"');
    expect(indexHtml).toContain('data-status="abandoned"');
  });

  it('edit form is initially hidden via hidden attribute', () => {
    // The edit form must have the hidden attribute on initial render
    expect(indexHtml).toMatch(/id="edit-form"\s[^>]*hidden|<form[^>]*hidden[^>]*id="edit-form"/);
  });

  it('edit form has required structure: title input, due input, tags input, save and cancel buttons', () => {
    expect(indexHtml).toContain('id="edit-title"');
    expect(indexHtml).toContain('id="edit-due"');
    expect(indexHtml).toContain('id="edit-tags"');
    expect(indexHtml).toContain('id="edit-save"');
    expect(indexHtml).toContain('id="edit-cancel"');
  });

  it('delete button is present in detail panel', () => {
    expect(indexHtml).toContain('id="delete-btn"');
    expect(indexHtml).toContain('class="delete-btn"');
  });

  it('toast container is present at body level with ARIA live region', () => {
    expect(indexHtml).toContain('id="toast"');
    expect(indexHtml).toContain('role="status"');
    expect(indexHtml).toContain('aria-live="polite"');
  });

  it('edit-error element is present and hidden initially', () => {
    expect(indexHtml).toContain('id="edit-error"');
    // Should have hidden attribute on the error paragraph
    expect(indexHtml).toMatch(/id="edit-error"[^>]*hidden|<p[^>]*hidden[^>]*id="edit-error"/);
  });

  it('edit-spinner element is present and hidden initially', () => {
    expect(indexHtml).toContain('id="edit-spinner"');
    expect(indexHtml).toMatch(/id="edit-spinner"[^>]*hidden|<div[^>]*hidden[^>]*id="edit-spinner"/);
  });
});

describe('webapp organize client — v1.14.2 app.js mutation logic', () => {
  it('submitEdit form handler is defined in edit-form.js (v1.15.0 extracted)', () => {
    expect(editFormJs).toContain('function submitEdit');
  });

  it('toggleComplete function is defined in app.js', () => {
    expect(appJs).toContain('function toggleComplete');
  });

  it('armDelete, disarmDelete, commitDelete functions are defined in app.js', () => {
    expect(appJs).toContain('function armDelete');
    expect(appJs).toContain('function disarmDelete');
    expect(appJs).toContain('function commitDelete');
  });

  it('showToast function is defined and accepts a duration parameter', () => {
    expect(appJs).toContain('function showToast');
    // The function signature must have a durationMs parameter
    expect(appJs).toMatch(/function showToast\s*\(\s*message\s*,\s*durationMs/);
  });

  it('showToast defaults to TOAST_DEFAULT_MS when no duration provided (v1.14.4 RA1)', () => {
    // v1.14.4 RA1: inline literal 3000 replaced with TOAST_DEFAULT_MS constant
    expect(appJs).toContain('TOAST_DEFAULT_MS');
  });

  it('sets input values via DOM property .value — never setAttribute (D15 + RA1)', () => {
    // Must NOT use setAttribute to set form input values (check both files)
    expect(appJs).not.toMatch(/setAttribute\s*\(\s*['"]value['"]/);
    expect(editFormJs).not.toMatch(/setAttribute\s*\(\s*['"]value['"]/);
    // Must use .value assignment for inputs (v1.15.0: these live in edit-form.js)
    expect(editFormJs).toContain('_editTitleEl.value =');
    expect(editFormJs).toContain('_editDueEl.value =');
    expect(editFormJs).toContain('_editTagsEl.value =');
  });

  it('complete checkbox click handler uses event.stopPropagation() (R13 tap-target separation)', () => {
    // stopPropagation must be called in the check-btn click handler (v1.15.0: lives in list-view.js)
    expect(listViewJs).toContain('e.stopPropagation()');
  });

  it('delete confirm does NOT use native confirm() — inline pattern only', () => {
    // window.confirm() must not appear in app.js
    expect(appJs).not.toMatch(/window\.confirm\s*\(/);
    // The native confirm() function call (as a direct call, no preceding identifier chars)
    // Pattern: confirm( directly preceded by whitespace, newline, semicolon, or open paren
    // We look for confirm( at the start of an expression: [\s;(=]confirm(
    expect(appJs).not.toMatch(/[;\s(=]confirm\(/);
  });

  it('PATCH request sends only changed fields (partial update — R10, RA2)', () => {
    // The patch object is built by diffing against currentDetailItem (v1.15.0: submitEdit in edit-form.js)
    expect(editFormJs).toContain('currentDetailItem');
    // The submitEdit function should check if title/due/status/tags changed before adding to patch
    expect(editFormJs).toContain('patch.title =');
    expect(editFormJs).toContain('patch.due =');
    expect(editFormJs).toContain('patch.status =');
    expect(editFormJs).toContain('patch.tags =');
  });

  it('tag handling: client does NOT normalize tag content — no strip-chars regex, no toLowerCase (F1/RA1)', () => {
    // Client must NOT apply [^a-z0-9-] strip or toLowerCase to tags.
    // Tags are sent verbatim (split + trim only); the server's TAG_RE is the sole validator.
    // This is a regression guard — if these patterns reappear inside the tag path, fix them.
    expect(appJs).not.toMatch(/\[.*\^a-z0-9-.*\]/);
    // Verify no toLowerCase call appears within the tag normalizer comment block
    // (the only safe toLowerCase calls would be outside the tag path entirely)
    // Verify the canonical verbatim-send pattern is present
    expect(appJs).toContain(".split(',').map((t) => t.trim()).filter((t) => t.length > 0)");
  });

  it('toast message uses textContent — no innerHTML on toast (Decision 6)', () => {
    // In showToast, the toast message must be set via textContent, never innerHTML
    // Check that toastEl.textContent assignment appears and toastEl.innerHTML does not
    expect(appJs).toContain('toastEl.textContent = message');
    // toastEl.innerHTML must not appear in a value-setting context
    expect(appJs).not.toMatch(/toastEl\.innerHTML\s*=/);
  });

  it('abandoned items do NOT render a complete checkbox (R14)', () => {
    // The checkbox rendering is guarded by a status !== abandoned check (v1.15.0: in list-view.js)
    expect(listViewJs).toContain("item.status !== 'abandoned'");
  });

  it('toggleComplete covers 4xx, 5xx, and network error branches (W4)', () => {
    // All three rollback branches must be present in toggleComplete
    expect(appJs).toContain('res.ok');
    // Network error catch clause is present (the .catch at the end of toggleComplete)
    expect(appJs).toMatch(/\.catch\s*\(\s*\(err\)\s*=>/);
    // 5xx rollback — !res.ok covers both 4xx and 5xx; verify both handled
    expect(appJs).toContain("showToast(`Network error: ${err.message}`");
  });

  // v1.14.4 D6 sunset: capturedMtime and X-Captured-Mtime are REMOVED.
  // These tests are replaced by the v1.14.4 sunset assertions in the section below.
  it('v1.14.4 D6: capturedMtime state is removed (R2 sunset)', () => {
    // Sunsetted in v1.14.4 — capturedMtime must NOT be present
    expect(appJs).not.toContain('capturedMtime');
  });

  it('v1.14.4 D6: staleWarning toast is removed (D6 sunset)', () => {
    // v1.14.2 stale-warning toast is sunsetted; 412 conflict UI replaces it
    expect(appJs).not.toContain('staleWarning');
  });

  it('delete success toast includes restore-via-chat hint (R16)', () => {
    expect(appJs).toContain('/organize restore');
  });

  it('delete confirm uses 6-second timer (R5)', () => {
    expect(appJs).toContain('6000');
    expect(appJs).toContain('remaining');
  });
});

// ------------------------------------------------------------------
// v1.14.3 — Notes/Progress + Hierarchy client tests
// ------------------------------------------------------------------

describe('webapp organize client — v1.14.3 index.html textarea structure', () => {
  it('edit form has notes textarea with maxlength="10240" (R1)', () => {
    expect(indexHtml).toContain('id="edit-notes"');
    expect(indexHtml).toContain('maxlength="10240"');
  });

  it('edit form has progress textarea with maxlength="20480" (R1)', () => {
    expect(indexHtml).toContain('id="edit-progress"');
    expect(indexHtml).toContain('maxlength="20480"');
  });

  it('notes textarea has autocorrect="off" autocapitalize="sentences" spellcheck="true" (R9)', () => {
    // R9: user spec — autocorrect=off, autocapitalize=sentences, spellcheck=true for prose
    expect(indexHtml).toContain('autocorrect="off"');
    expect(indexHtml).toContain('autocapitalize="sentences"');
    expect(indexHtml).toContain('spellcheck="true"');
  });

  it('edit form has #notes-counter and #progress-counter char counter elements (R1)', () => {
    expect(indexHtml).toContain('id="notes-counter"');
    expect(indexHtml).toContain('id="progress-counter"');
  });

  it('app.js script tag uses type="module" (ES module for hierarchy.js import)', () => {
    expect(indexHtml).toContain('<script type="module" src="./app.js" defer>');
  });
});

describe('webapp organize client — v1.14.3 app.js hierarchy + constants', () => {
  it('app.js imports groupByParent from ./hierarchy.js', () => {
    expect(appJs).toContain("from './hierarchy.js'");
    expect(appJs).toContain('groupByParent');
  });

  it('app.js defines CHAR_COUNTER_WARN_THRESHOLD constant', () => {
    expect(appJs).toContain('CHAR_COUNTER_WARN_THRESHOLD');
    expect(appJs).toContain('0.8');
  });

  it('app.js defines COLLAPSE_STATE_KEY constant (or references it)', () => {
    expect(appJs).toContain('COLLAPSE_STATE_KEY');
    expect(appJs).toContain('organize-collapse-state-v1');
  });

  it('app.js defines NOTES_MAX = 10240', () => {
    expect(appJs).toContain('NOTES_MAX');
    expect(appJs).toContain('10240');
  });

  it('app.js defines PROGRESS_MAX = 20480', () => {
    expect(appJs).toContain('PROGRESS_MAX');
    expect(appJs).toContain('20480');
  });

  it('app.js defines DIFF_WARN_THRESHOLD_LINES constant', () => {
    expect(appJs).toContain('DIFF_WARN_THRESHOLD_LINES');
  });

  it('app.js defines updateCounter function', () => {
    expect(appJs).toContain('function updateCounter');
  });

  it('hierarchy.js defines toggleCollapsed function (v1.15.0: was toggleCollapse in app.js; renamed/relocated)', () => {
    expect(hierarchyJs).toContain('function toggleCollapsed');
  });

  it('app.js imports groupByParent (regression: still imported from hierarchy.js)', () => {
    // Regression guard — ensure import was not accidentally removed
    expect(appJs).toMatch(/import\s*\{[^}]*groupByParent[^}]*\}\s*from\s*['"]\.\/hierarchy\.js['"]/);
  });

  it('app.js does NOT use native confirm() — inline pattern only (R3)', () => {
    // R3 uses the "Tap again to confirm" text pattern, not window.confirm() or bare confirm().
    // We check for the function-call pattern: confirm( preceded by non-identifier chars
    // (start of statement, or after = ( ; newline). The word "confirm" in variable names
    // like progressSaveConfirmPending is fine; only the *call* form is banned.
    expect(appJs).not.toMatch(/window\.confirm\s*\(/);
    // Strict check: confirm( as an expression start (preceded by = or open-paren or semicolon)
    // but NOT as part of a word (confirmPending, confirmTimer, etc.)
    // Pattern: non-word-char followed by confirm( — excludes identifiers like confirmPending
    expect(appJs).not.toMatch(/(?<![a-zA-Z_$])confirm\s*\(\s*['"]/);
  });

  it('submitEdit includes patch.notes and patch.progress (v1.14.3)', () => {
    // v1.15.0: submitEdit lives in edit-form.js
    expect(editFormJs).toContain('patch.notes =');
    expect(editFormJs).toContain('patch.progress =');
  });

  it('enterEditMode populates editNotesEl.value and editProgressEl.value', () => {
    // DOM property .value — never setAttribute (D15/RA1) (v1.15.0: in edit-form.js)
    expect(editFormJs).toContain('_editNotesEl.value =');
    expect(editFormJs).toContain('_editProgressEl.value =');
  });

  it('styles.css has .chevron-btn, .goal-children, and .char-counter rules', () => {
    const stylesCss = readFileSync(
      path.join(root, 'public/webapp/organize/styles.css'),
      'utf8',
    );
    expect(stylesCss).toContain('.chevron-btn');
    expect(stylesCss).toContain('.goal-children');
    expect(stylesCss).toContain('.char-counter');
  });
});

describe('webapp hub client — public/webapp/index.html', () => {
  const hubHtml = readFileSync(path.join(root, 'public/webapp/index.html'), 'utf8');
  const hubJs = readFileSync(path.join(root, 'public/webapp/app.js'), 'utf8');

  it('hub HTML has no inline script bodies', () => {
    expect(hubHtml).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
  });

  it('hub links to the organize feature page', () => {
    expect(hubHtml).toContain('href="./organize/"');
  });

  it('hub has greeting and user-id spans', () => {
    expect(hubHtml).toContain('id="greeting"');
    expect(hubHtml).toContain('id="user-id"');
  });

  it('hub app.js has no ping handler (R12.3)', () => {
    // Check for functional ping code, not comment text.
    // The comment block may mention "sendData" as context; what must not exist
    // is the functional call: twa.sendData(...) or Telegram.WebApp.sendData(...)
    expect(hubJs).not.toMatch(/twa\.sendData\s*\(/);
    expect(hubJs).not.toMatch(/WebApp\.sendData\s*\(/);
    expect(hubJs).not.toContain('ping-btn');
    expect(hubJs).not.toContain('pingBtn');
  });

  it('hub app.js subscribes to themeChanged (R12.4)', () => {
    expect(hubJs).toContain('themeChanged');
  });
});

// ------------------------------------------------------------------
// v1.14.4 — ETag / If-Match / Conflict UI client tests (RA1 + RA2 sunset)
// ------------------------------------------------------------------

describe('webapp organize client — v1.14.4 RA1: wire-protocol constants', () => {
  it('app.js defines ETAG_HEADER constant', () => {
    expect(appJs).toContain("ETAG_HEADER = 'ETag'");
  });

  it('app.js defines IF_MATCH_HEADER constant', () => {
    expect(appJs).toContain("IF_MATCH_HEADER = 'If-Match'");
  });

  it('app.js defines FORCE_OVERRIDE_HEADER constant', () => {
    expect(appJs).toContain("FORCE_OVERRIDE_HEADER = 'X-Force-Override'");
  });

  it('app.js defines FORCE_OVERRIDE_VALUE constant', () => {
    expect(appJs).toContain("FORCE_OVERRIDE_VALUE = '1'");
  });

  it('app.js defines TOAST_DEFAULT_MS constant (closes v1.14.3 F2)', () => {
    expect(appJs).toContain('TOAST_DEFAULT_MS = 3000');
  });

  it('app.js defines TOAST_LONG_MS constant (closes v1.14.3 F2)', () => {
    expect(appJs).toContain('TOAST_LONG_MS = 5000');
  });

  it('app.js defines TOAST_RESTORE_MS constant (closes v1.14.3 F2)', () => {
    expect(appJs).toContain('TOAST_RESTORE_MS = 8000');
  });

  it('app.js defines TOAST_OVERRIDE_MS constant (closes v1.14.3 F2)', () => {
    expect(appJs).toContain('TOAST_OVERRIDE_MS = 4000');
  });

  it('app.js has no inline ms numeric literals in showToast calls (RA1 grep enforcement)', () => {
    // showToast(msg, <number>) should have zero inline literals — all replaced with constants.
    // We look for showToast( followed by any args ending with a bare integer like ,3000) or ,5000)
    const matches = appJs.match(/showToast\s*\([^)]+,\s*\d{4,5}\s*\)/g);
    expect(matches).toBeNull();
  });
});

describe('webapp organize client — v1.14.4 ETag state + D6 R2-mtime sunset', () => {
  it('app.js defines currentDetailEtag (replaces capturedMtime)', () => {
    expect(appJs).toContain('currentDetailEtag');
  });

  it('app.js does NOT define capturedMtime (R2 sunset)', () => {
    // capturedMtime must be removed; any re-introduction is a regression
    expect(appJs).not.toContain('capturedMtime');
  });

  it('app.js does NOT send X-Captured-Mtime header (R2 sunset)', () => {
    expect(appJs).not.toMatch(/X-Captured-Mtime/i);
  });

  it('app.js does NOT reference staleWarning (D6 sunset)', () => {
    expect(appJs).not.toContain('staleWarning');
  });

  it('app.js sends If-Match header on PATCH (D3)', () => {
    // IF_MATCH_HEADER constant used in bracket-assignment or computed property key
    expect(appJs).toMatch(/IF_MATCH_HEADER/);
    // The assignment pattern: headers[IF_MATCH_HEADER] = ...
    expect(appJs).toMatch(/headers\s*\[\s*IF_MATCH_HEADER\s*\]/);
  });

  it('edit-form.js sends X-Force-Override header on Save Anyway path (D5 RA1 — v1.15.0 extracted)', () => {
    // FORCE_OVERRIDE_HEADER used as a computed property key in headers object literal
    expect(editFormJs).toMatch(/\[FORCE_OVERRIDE_HEADER\]\s*:/);
    expect(editFormJs).toContain('FORCE_OVERRIDE_VALUE');
  });
});

describe('webapp organize client — v1.14.4 conflict UI functions', () => {
  it('showConflictUI function is defined in edit-form.js (v1.15.0 extracted)', () => {
    expect(editFormJs).toContain('function showConflictUI');
  });

  it('handleSaveAnyway function is defined in edit-form.js (v1.15.0 extracted)', () => {
    expect(editFormJs).toContain('function handleSaveAnyway');
  });

  it('handleDeleteAnyway function is defined in edit-form.js (v1.15.0 extracted)', () => {
    expect(editFormJs).toContain('function handleDeleteAnyway');
  });

  it('412 response handling reads currentEtag + currentItem from body', () => {
    // v1.15.0: submitEdit (and 412 handling) lives in edit-form.js
    expect(editFormJs).toContain('data.currentEtag');
    expect(editFormJs).toContain('data.currentItem');
    expect(editFormJs).toContain("data.code === 'PRECONDITION_FAILED'");
  });

  it('DELETE conflict UI uses Cancel + Delete Anyway (no Reload shown for delete)', () => {
    // R9: showConflictUI('delete', ...) hides Reload and shows Delete Anyway
    // The kind check for 'delete' must hide conflict-reload (v1.15.0: in edit-form.js)
    expect(editFormJs).toContain("kind !== 'patch'");   // hides Reload when kind=delete
    expect(editFormJs).toContain("kind !== 'delete'");  // hides Delete Anyway when kind=patch
  });

  it('conflict panel title uses textContent (no innerHTML on user content)', () => {
    // The conflict message must use textContent — conflict panel shows item title from API
    // v1.15.0: _conflictMessageEl lives in edit-form.js
    expect(editFormJs).toMatch(/_conflictMessageEl\.textContent/);
  });
});

describe('webapp organize client — v1.14.4 index.html conflict panel structure', () => {
  it('index.html has #conflict-panel section (hidden initially)', () => {
    expect(indexHtml).toContain('id="conflict-panel"');
    // Must have the hidden attribute on initial render
    expect(indexHtml).toMatch(/id="conflict-panel"[^>]*hidden|<section[^>]*hidden[^>]*id="conflict-panel"/);
  });

  it('index.html has #conflict-reload button (hidden initially)', () => {
    expect(indexHtml).toContain('id="conflict-reload"');
    expect(indexHtml).toMatch(/id="conflict-reload"[^>]*hidden/);
  });

  it('index.html has #conflict-save-anyway button (hidden initially)', () => {
    expect(indexHtml).toContain('id="conflict-save-anyway"');
    expect(indexHtml).toMatch(/id="conflict-save-anyway"[^>]*hidden/);
  });

  it('index.html has #conflict-delete-anyway button (hidden initially)', () => {
    expect(indexHtml).toContain('id="conflict-delete-anyway"');
    expect(indexHtml).toMatch(/id="conflict-delete-anyway"[^>]*hidden/);
  });

  it('index.html has #conflict-cancel button', () => {
    expect(indexHtml).toContain('id="conflict-cancel"');
  });

  it('conflict-panel has role="alertdialog" (accessibility)', () => {
    expect(indexHtml).toContain('role="alertdialog"');
  });
});

// ------------------------------------------------------------------
// v1.14.5 — BroadcastChannel + Parent picker client tests
// ------------------------------------------------------------------

describe('webapp organize client — v1.14.5 RA1: wire-constants (BroadcastChannel)', () => {
  it('app.js defines ORGANIZE_MUTATIONS_CHANNEL constant (R7 — v1.15.0: derived from BROADCAST_CHANNEL_FALLBACK)', () => {
    // v1.14.5: was a direct string literal.
    // v1.15.0: aliased to BROADCAST_CHANNEL_FALLBACK so the value is still 'organize-mutations-jarvis'
    // but defined via the fallback constant (D9 refactor). Both forms are valid.
    expect(appJs).toMatch(/ORGANIZE_MUTATIONS_CHANNEL\s*=/);
    // Verify the channel value is still reachable via BROADCAST_CHANNEL_FALLBACK
    expect(appJs).toContain("BROADCAST_CHANNEL_FALLBACK = 'organize-mutations-jarvis'");
  });

  it('app.js defines BC_BANNER_ID constant (W1)', () => {
    expect(appJs).toContain("BC_BANNER_ID = 'bc-banner'");
  });

  it('app.js defines BC_RELOAD_BTN_ID constant (W1)', () => {
    expect(appJs).toContain("BC_RELOAD_BTN_ID = 'bc-reload'");
  });

  it('app.js defines BC_DISMISS_BTN_ID constant (W1)', () => {
    expect(appJs).toContain("BC_DISMISS_BTN_ID = 'bc-dismiss'");
  });
});

describe('webapp organize client — v1.14.5 BroadcastChannel functions', () => {
  it('app.js has initBroadcastChannel function', () => {
    expect(appJs).toContain('function initBroadcastChannel');
  });

  it('app.js has broadcastMutation function', () => {
    expect(appJs).toContain('function broadcastMutation');
  });

  it('app.js has handleBroadcastMessage function', () => {
    expect(appJs).toContain('function handleBroadcastMessage');
  });

  it('app.js feature-detects BroadcastChannel via typeof check (D10)', () => {
    // The guard may use === 'undefined' (early-return) or !== 'undefined' (guard-enter);
    // either is a correct feature-detect. We assert the typeof check is present.
    expect(appJs).toMatch(/typeof BroadcastChannel [!=]== ['"]undefined['"]/);
  });

  it('app.js wraps postMessage in try/catch (R4 — iOS Telegram WebApp partial-support)', () => {
    // The try/catch around bcChannel.postMessage must be present
    expect(appJs).toMatch(/try\s*\{[^}]*bcChannel\.postMessage/s);
  });

  it('app.js broadcastMutation is NOT called in 412 response branches (W4)', () => {
    // Extract the 412 / PRECONDITION_FAILED branch and verify broadcastMutation is absent
    // We check for the pattern: 412 && PRECONDITION_FAILED ... showConflictUI (no broadcastMutation before showConflictUI)
    const preconditionIdx = appJs.indexOf("'PRECONDITION_FAILED'");
    expect(preconditionIdx).toBeGreaterThan(-1);
    // Find the substring around the 412 handler — it should not call broadcastMutation
    // (The function is only called in the status === 200 branch)
    const sliceAround412 = appJs.slice(preconditionIdx - 50, preconditionIdx + 200);
    expect(sliceAround412).not.toContain('broadcastMutation');
  });

  it('app.js broadcastMutation is NOT called in catch (network error) branches (W4)', () => {
    // The catch clauses in submitEdit and commitDelete must not call broadcastMutation
    // We verify by checking comment documentation is present (W4 guard comments)
    expect(appJs).toContain('W4: do NOT broadcast on network error');
  });

  it('app.js has asymmetric BC dispatch: banner when edit form open, silent refetch when not (R8)', () => {
    // handleBroadcastMessage must check editFormEl.hidden to decide between banner and refetch
    expect(appJs).toContain('editFormEl.hidden');
    expect(appJs).toContain('function showBcBanner');
    expect(appJs).toContain('function hideBcBanner');
  });
});

describe('webapp organize client — v1.14.5 parent picker', () => {
  it('renderParentPicker uses textContent for goal.title (NOT innerHTML — XSS guard)', () => {
    // The option's title must use textContent (v1.15.0: renderParentPicker in edit-form.js)
    expect(editFormJs).toContain('opt.textContent = goal.title');
    // And must NOT use innerHTML for goal content
    expect(editFormJs).not.toMatch(/opt\.innerHTML\s*=\s*goal/);
  });

  it('renderParentPicker filters currentDetailItem.id from picker (R2 self-id guard)', () => {
    // Must skip the current item (v1.15.0: renderParentPicker in edit-form.js)
    expect(editFormJs).toContain('goal.id === currentDetailItem.id');
  });

  it('fetchGoalsForPicker caches result in _goalsForPicker (avoids repeated fetches)', () => {
    // The _goalsForPicker variable is checked before fetching (v1.15.0: private in edit-form.js)
    expect(editFormJs).toContain('_goalsForPicker !== null');
    expect(editFormJs).toContain('_goalsForPicker = null'); // clearPickerCache() sets this
  });
});

describe('webapp organize client — v1.14.5 index.html parent picker + bc-banner', () => {
  it('index.html has <select id="edit-parent"> with "(none)" option baked in', () => {
    expect(indexHtml).toContain('id="edit-parent"');
    expect(indexHtml).toContain('<option value="">(none)</option>');
  });

  it('index.html has #bc-banner with data-bc-reload and data-bc-dismiss buttons (W1)', () => {
    expect(indexHtml).toContain('id="bc-banner"');
    expect(indexHtml).toContain('data-bc-reload');
    expect(indexHtml).toContain('data-bc-dismiss');
  });

  it('index.html bc-banner is initially hidden via hidden attribute (W1)', () => {
    expect(indexHtml).toMatch(/id="bc-banner"[^>]*hidden|<div[^>]*hidden[^>]*id="bc-banner"/);
  });

  it('index.html bc-banner has aria-live="polite" (W1 accessibility contract)', () => {
    // The bc-banner element must have role="status" and aria-live="polite"
    const bannerMatch = indexHtml.match(/id="bc-banner"[^>]*/);
    expect(bannerMatch).not.toBeNull();
    // Check that both role and aria-live appear in the same element or document
    const bannerIdx = indexHtml.indexOf('id="bc-banner"');
    const bannerTag = indexHtml.slice(bannerIdx - 5, bannerIdx + 80);
    expect(bannerTag).toContain('aria-live="polite"');
  });
});

// ------------------------------------------------------------------
// v1.14.6 — Multi-select + bulk actions + create form client tests
// ------------------------------------------------------------------

describe('webapp organize client — v1.14.6 RA1: wire-constants', () => {
  it('app.js defines MAX_BULK_INFLIGHT = 10 (D3 concurrency limiter)', () => {
    expect(appJs).toContain('MAX_BULK_INFLIGHT = 10');
  });

  it('app.js defines BC_DEDUP_WINDOW_MS = 1000 (D16/R8 always-reset dedup)', () => {
    expect(appJs).toContain('BC_DEDUP_WINDOW_MS = 1000');
  });

  it('app.js defines BULK_DELETE_TYPED_CONFIRM_THRESHOLD = 50 (R2 HIGH)', () => {
    expect(appJs).toContain('BULK_DELETE_TYPED_CONFIRM_THRESHOLD = 50');
  });

  it('app.js defines CREATE_SUBMIT_TIMEOUT_MS = 30000 (R6 AbortController timeout)', () => {
    expect(appJs).toContain('CREATE_SUBMIT_TIMEOUT_MS = 30000');
  });

  it('app.js defines WEBAPP_ITEM_CREATE_CATEGORY constant', () => {
    expect(appJs).toContain("WEBAPP_ITEM_CREATE_CATEGORY = 'webapp.item_create'");
  });

  it('app.js defines SELECT_TOGGLE_BTN_ID constant (RA1 wire-constant discipline)', () => {
    expect(appJs).toContain("SELECT_TOGGLE_BTN_ID = 'select-toggle'");
  });

  it('app.js defines SELECT_BAR_ID constant', () => {
    expect(appJs).toContain("SELECT_BAR_ID = 'select-bar'");
  });

  it('app.js defines NEW_ITEM_BTN_ID constant', () => {
    expect(appJs).toContain("NEW_ITEM_BTN_ID = 'new-item-btn'");
  });

  it('app.js defines CREATE_FORM_ID constant', () => {
    expect(appJs).toContain("CREATE_FORM_ID = 'create-form'");
  });
});

describe('webapp organize client — v1.14.6 multi-select state', () => {
  it('app.js declares multiSelectMode variable', () => {
    expect(appJs).toContain('multiSelectMode = false');
  });

  it('app.js declares selectedIds as a Set', () => {
    expect(appJs).toContain('const selectedIds = new Set()');
  });

  it('app.js defines enterSelectMode function', () => {
    expect(appJs).toContain('function enterSelectMode');
  });

  it('app.js defines exitSelectMode function', () => {
    expect(appJs).toContain('function exitSelectMode');
  });

  it('app.js defines toggleItemSelection function', () => {
    expect(appJs).toContain('function toggleItemSelection');
  });

  it('app.js defines renderActionBar / updateSelectCount function', () => {
    expect(appJs).toContain('function updateSelectCount');
  });
});

describe('webapp organize client — v1.14.6 bulk action functions', () => {
  it('app.js defines handleBulkComplete function', () => {
    expect(appJs).toContain('function handleBulkComplete');
  });

  it('app.js defines handleBulkDelete function', () => {
    expect(appJs).toContain('function handleBulkDelete');
  });

  it('app.js defines handleBulkReParent function', () => {
    expect(appJs).toContain('function handleBulkReParent');
  });

  it('app.js defines bulkPromisePool function (D3 concurrency limiter)', () => {
    expect(appJs).toContain('function bulkPromisePool');
  });

  it('app.js defines dispatchBulkDelete function', () => {
    expect(appJs).toContain('function dispatchBulkDelete');
  });

  it('app.js defines dispatchBulkReParent function', () => {
    expect(appJs).toContain('function dispatchBulkReParent');
  });

  it('app.js defines showBulkResultsToast function (D4 partial-failure UX)', () => {
    expect(appJs).toContain('function showBulkResultsToast');
  });
});

describe('webapp organize client — v1.14.6 R1: verb-asymmetric If-Match on bulk', () => {
  it('dispatchBulkReParent sends If-Match header (PATCH MUST send per-item ETag)', () => {
    // R1 BLOCKING: bulk PATCH must include IF_MATCH_HEADER in headers
    const reParentFnStart = appJs.indexOf('async function dispatchBulkReParent');
    expect(reParentFnStart).toBeGreaterThan(-1);
    // Find the function body up to the next top-level function
    const nextFnIdx = appJs.indexOf('\nasync function ', reParentFnStart + 1);
    const fnBody = appJs.slice(reParentFnStart, nextFnIdx > reParentFnStart ? nextFnIdx : reParentFnStart + 3000);
    expect(fnBody).toContain('IF_MATCH_HEADER');
  });

  it('dispatchBulkDelete does NOT send If-Match (DELETE MAY omit per R1)', () => {
    // R1: bulk DELETE omits If-Match (intent-clear; absolute-write)
    const deleteFnStart = appJs.indexOf('async function dispatchBulkDelete');
    expect(deleteFnStart).toBeGreaterThan(-1);
    const nextFnIdx = appJs.indexOf('\nasync function ', deleteFnStart + 1);
    const fnBody = appJs.slice(deleteFnStart, nextFnIdx > deleteFnStart ? nextFnIdx : deleteFnStart + 2000);
    // Should NOT have If-Match in the headers object for the DELETE request
    expect(fnBody).not.toMatch(/headers\s*\[\s*IF_MATCH_HEADER\s*\]/);
  });

  it('handleBulkComplete does NOT send If-Match (POST /complete MAY omit per R1)', () => {
    const completeFnStart = appJs.indexOf('async function handleBulkComplete');
    expect(completeFnStart).toBeGreaterThan(-1);
    const nextFnIdx = appJs.indexOf('\nfunction ', completeFnStart + 1);
    const fnBody = appJs.slice(completeFnStart, nextFnIdx > completeFnStart ? nextFnIdx : completeFnStart + 2000);
    expect(fnBody).not.toMatch(/headers\s*\[\s*IF_MATCH_HEADER\s*\]/);
  });
});

describe('webapp organize client — v1.14.6 R2: typed-confirm for >50 bulk delete', () => {
  it('app.js defines showBulkDeleteTypedConfirm function', () => {
    expect(appJs).toContain('function showBulkDeleteTypedConfirm');
  });

  it('handleBulkDelete branches on BULK_DELETE_TYPED_CONFIRM_THRESHOLD', () => {
    expect(appJs).toContain('BULK_DELETE_TYPED_CONFIRM_THRESHOLD');
    // The branch should call showBulkDeleteTypedConfirm for large batches
    expect(appJs).toContain('showBulkDeleteTypedConfirm');
  });

  it('bulk delete typed-confirm checks for exact "DELETE" string match', () => {
    expect(appJs).toContain("=== 'DELETE'");
  });

  it('no native confirm() used in bulk delete path (inline typed-confirm UI instead)', () => {
    expect(appJs).not.toMatch(/window\.confirm\s*\(/);
    expect(appJs).not.toMatch(/(?<![a-zA-Z_$])confirm\s*\(\s*['"]/);
  });
});

describe('webapp organize client — v1.14.6 R6: AbortController + 30s timeout on create', () => {
  it('handleCreateSubmit uses AbortController (R6 closes iOS-backgrounded-fetch issue)', () => {
    expect(appJs).toContain('new AbortController()');
  });

  it('handleCreateSubmit uses CREATE_SUBMIT_TIMEOUT_MS in setTimeout (R6)', () => {
    const createFnIdx = appJs.indexOf('async function handleCreateSubmit');
    expect(createFnIdx).toBeGreaterThan(-1);
    const fnSnippet = appJs.slice(createFnIdx, createFnIdx + 2000);
    expect(fnSnippet).toContain('CREATE_SUBMIT_TIMEOUT_MS');
    expect(fnSnippet).toContain('abortController.abort');
  });

  it('handleCreateSubmit checks _createSubmitInFlight flag (D15 double-submit guard)', () => {
    const createFnIdx = appJs.indexOf('async function handleCreateSubmit');
    const fnSnippet = appJs.slice(createFnIdx, createFnIdx + 500);
    expect(fnSnippet).toContain('_createSubmitInFlight');
    expect(fnSnippet).toContain('return');
  });

  it('handleCreateSubmit re-enables button + clears inflight flag in finally (D15)', () => {
    const createFnIdx = appJs.indexOf('async function handleCreateSubmit');
    const fnSnippet = appJs.slice(createFnIdx, createFnIdx + 3000);
    expect(fnSnippet).toContain('_createSubmitInFlight = false');
    expect(fnSnippet).toContain('finally');
  });

  it('bulk dispatchers (dispatchBulkDelete, dispatchBulkReParent) also use AbortController', () => {
    // R6 applies to bulk submissions too
    const occurrences = (appJs.match(/new AbortController\(\)/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3); // create + 2+ bulk
  });
});

// T-79a — visibility-change race for create submission (Anti-Slop F5 / ADR 014 W5 binding)
//
// The design is correct-by-construction: _createSubmitInFlight is set BEFORE the first
// await; the finally block always clears it (not just on success/error); the AbortController
// signal is plumbed into the fetch; and the 30s timeout uses the named constant. A
// visibilitychange event has NO listener in app.js that touches these variables, so the
// state is unchanged across background transitions by construction.
//
// This block binds the four source-structure invariants that defend the race — per W5.
describe('webapp organize client — T-79a: visibility-change race defense for create submission (W5)', () => {
  it('T-79a-1: _createSubmitInFlight is set before the first await in handleCreateSubmit', () => {
    const createFnIdx = appJs.indexOf('async function handleCreateSubmit');
    expect(createFnIdx).toBeGreaterThan(-1);
    // The in-flight flag must appear before any await/fetch in the function body.
    // We verify by checking that _createSubmitInFlight = true appears within 300 chars
    // of the function open (before any network call can start).
    const fnPreamble = appJs.slice(createFnIdx, createFnIdx + 300);
    expect(fnPreamble).toContain('_createSubmitInFlight = true');
  });

  it('T-79a-2: _createSubmitInFlight is reset in a finally block (not only in catch)', () => {
    const createFnIdx = appJs.indexOf('async function handleCreateSubmit');
    const fnSnippet = appJs.slice(createFnIdx, createFnIdx + 3000);
    // finally must appear in the function
    expect(fnSnippet).toContain('finally');
    // The reset must be inside or after the finally keyword (source order)
    const finallyIdx = fnSnippet.indexOf('finally');
    const resetIdx = fnSnippet.lastIndexOf('_createSubmitInFlight = false');
    expect(resetIdx).toBeGreaterThan(finallyIdx);
  });

  it('T-79a-3: AbortController signal is plumbed into the fetch call in handleCreateSubmit', () => {
    const createFnIdx = appJs.indexOf('async function handleCreateSubmit');
    const fnSnippet = appJs.slice(createFnIdx, createFnIdx + 3000);
    // The signal must be passed to fetch (via options object containing signal property)
    expect(fnSnippet).toContain('abortController.signal');
    // And the fetch call must be present
    expect(fnSnippet).toContain('fetch(');
  });

  it('T-79a-4: 30-second timeout in handleCreateSubmit uses CREATE_SUBMIT_TIMEOUT_MS constant', () => {
    const createFnIdx = appJs.indexOf('async function handleCreateSubmit');
    const fnSnippet = appJs.slice(createFnIdx, createFnIdx + 3000);
    // Must reference the constant — not a magic 30000 literal
    expect(fnSnippet).toContain('CREATE_SUBMIT_TIMEOUT_MS');
    // And the constant itself must be defined at the top of app.js
    expect(appJs).toMatch(/CREATE_SUBMIT_TIMEOUT_MS\s*=\s*30000/);
  });
});

describe('webapp organize client — v1.14.6 R8: always-reset BC dedup', () => {
  it('app.js defines _bcDedupTimer variable (always-reset dedup state)', () => {
    expect(appJs).toContain('_bcDedupTimer = null');
  });

  it('handleBroadcastMessage uses always-reset pattern: clearTimeout + setTimeout on every message', () => {
    const bcFnIdx = appJs.indexOf('function handleBroadcastMessage');
    expect(bcFnIdx).toBeGreaterThan(-1);
    const fnSnippet = appJs.slice(bcFnIdx, bcFnIdx + 2000);
    // Must contain clearTimeout(_bcDedupTimer) pattern
    expect(fnSnippet).toContain('clearTimeout(_bcDedupTimer)');
    expect(fnSnippet).toContain('_bcDedupTimer = setTimeout');
    expect(fnSnippet).toContain('BC_DEDUP_WINDOW_MS');
  });

  it('_lastBcRefetchKind tracks the latest refetch kind for the dedup window', () => {
    expect(appJs).toContain('_lastBcRefetchKind');
  });
});

describe('webapp organize client — v1.14.6 R9: mutual exclusion select mode vs create form', () => {
  it('enterSelectMode hides/disables newItemBtnEl (R9)', () => {
    const fnIdx = appJs.indexOf('function enterSelectMode');
    const fnSnippet = appJs.slice(fnIdx, fnIdx + 1000);
    expect(fnSnippet).toContain('newItemBtnEl.hidden = true');
    expect(fnSnippet).toContain('newItemBtnEl.disabled = true');
  });

  it('exitSelectMode restores newItemBtnEl (R9)', () => {
    const fnIdx = appJs.indexOf('function exitSelectMode');
    const fnSnippet = appJs.slice(fnIdx, fnIdx + 1500);
    expect(fnSnippet).toContain('newItemBtnEl.hidden = false');
    expect(fnSnippet).toContain('newItemBtnEl.disabled = false');
  });

  it('enterCreateForm hides/disables selectToggleBtnEl (R9)', () => {
    const fnIdx = appJs.indexOf('function enterCreateForm');
    const fnSnippet = appJs.slice(fnIdx, fnIdx + 1000);
    expect(fnSnippet).toContain('selectToggleBtnEl.hidden = true');
    expect(fnSnippet).toContain('selectToggleBtnEl.disabled = true');
  });

  it('exitCreateForm restores selectToggleBtnEl (R9)', () => {
    const fnIdx = appJs.indexOf('function exitCreateForm');
    const fnSnippet = appJs.slice(fnIdx, fnIdx + 500);
    expect(fnSnippet).toContain('selectToggleBtnEl.hidden = false');
    expect(fnSnippet).toContain('selectToggleBtnEl.disabled = false');
  });
});

describe('webapp organize client — v1.14.6 index.html structure: select + action bar', () => {
  it('index.html has #select-toggle button', () => {
    expect(indexHtml).toContain('id="select-toggle"');
  });

  it('index.html has #new-item-btn button', () => {
    expect(indexHtml).toContain('id="new-item-btn"');
  });

  it('index.html has #select-bar with role="toolbar" (initially hidden)', () => {
    expect(indexHtml).toContain('id="select-bar"');
    expect(indexHtml).toContain('role="toolbar"');
    expect(indexHtml).toMatch(/id="select-bar"[^>]*hidden|<section[^>]*hidden[^>]*id="select-bar"/);
  });

  it('index.html has #select-count span inside select-bar', () => {
    expect(indexHtml).toContain('id="select-count"');
  });

  it('index.html has #bulk-complete button', () => {
    expect(indexHtml).toContain('id="bulk-complete"');
  });

  it('index.html has #bulk-delete button', () => {
    expect(indexHtml).toContain('id="bulk-delete"');
  });

  it('index.html has #bulk-reparent button', () => {
    expect(indexHtml).toContain('id="bulk-reparent"');
  });

  it('index.html has #bulk-cancel button', () => {
    expect(indexHtml).toContain('id="bulk-cancel"');
  });
});

describe('webapp organize client — v1.14.6 index.html structure: typed-confirm', () => {
  it('index.html has #bulk-delete-typed-confirm div (initially hidden)', () => {
    expect(indexHtml).toContain('id="bulk-delete-typed-confirm"');
    expect(indexHtml).toMatch(/id="bulk-delete-typed-confirm"[^>]*hidden|<div[^>]*hidden[^>]*id="bulk-delete-typed-confirm"/);
  });

  it('index.html has #bulk-delete-typed-input text field', () => {
    expect(indexHtml).toContain('id="bulk-delete-typed-input"');
  });

  it('index.html has #bulk-delete-typed-confirm-btn button', () => {
    expect(indexHtml).toContain('id="bulk-delete-typed-confirm-btn"');
  });
});

describe('webapp organize client — v1.14.6 index.html structure: create form', () => {
  it('index.html has #create-form (initially hidden)', () => {
    expect(indexHtml).toContain('id="create-form"');
    expect(indexHtml).toMatch(/id="create-form"[^>]*hidden|<form[^>]*hidden[^>]*id="create-form"/);
  });

  it('index.html has #create-title input', () => {
    expect(indexHtml).toContain('id="create-title"');
  });

  it('index.html has #create-due date input', () => {
    expect(indexHtml).toContain('id="create-due"');
  });

  it('index.html has #create-tags input', () => {
    expect(indexHtml).toContain('id="create-tags"');
  });

  it('index.html has #create-parent select with "(none)" option', () => {
    expect(indexHtml).toContain('id="create-parent"');
  });

  it('index.html has #create-parent-label (hidden when type=goal)', () => {
    expect(indexHtml).toContain('id="create-parent-label"');
  });

  it('index.html has #create-notes textarea with maxlength="10240"', () => {
    expect(indexHtml).toContain('id="create-notes"');
    // maxlength 10240 is already in the edit form; verify it appears for create-notes too
    const createNotesIdx = indexHtml.indexOf('id="create-notes"');
    expect(createNotesIdx).toBeGreaterThan(-1);
  });

  it('index.html has #create-progress textarea with maxlength="20480"', () => {
    expect(indexHtml).toContain('id="create-progress"');
  });

  it('index.html has #create-submit button', () => {
    expect(indexHtml).toContain('id="create-submit"');
  });

  it('index.html has #create-cancel button', () => {
    expect(indexHtml).toContain('id="create-cancel"');
  });

  it('index.html has #create-error error message element (initially hidden)', () => {
    expect(indexHtml).toContain('id="create-error"');
    expect(indexHtml).toMatch(/id="create-error"[^>]*hidden|<p[^>]*hidden[^>]*id="create-error"/);
  });

  it('index.html has type pill buttons with data-create-type attributes', () => {
    expect(indexHtml).toContain('data-create-type="task"');
    expect(indexHtml).toContain('data-create-type="event"');
    expect(indexHtml).toContain('data-create-type="goal"');
  });
});

describe('webapp organize client — v1.14.6 create form invariants', () => {
  it('app.js defines enterCreateForm function', () => {
    expect(appJs).toContain('function enterCreateForm');
  });

  it('app.js defines exitCreateForm function', () => {
    expect(appJs).toContain('function exitCreateForm');
  });

  it('app.js form fields populated via .value DOM property (never setAttribute)', () => {
    expect(appJs).not.toMatch(/setAttribute\s*\(\s*['"]value['"]/);
    // Create form inputs use .value
    expect(appJs).toContain('createTitleEl.value =');
    expect(appJs).toContain('createDueEl.value =');
    expect(appJs).toContain('createTagsEl.value =');
    expect(appJs).toContain('createParentEl.value =');
  });

  it('app.js updateCreateParentVisibility hides parent picker when type=goal', () => {
    expect(appJs).toContain('function updateCreateParentVisibility');
    const fnIdx = appJs.indexOf('function updateCreateParentVisibility');
    const fnSnippet = appJs.slice(fnIdx, fnIdx + 400);
    // When isGoal is true, both createParentEl and createParentLabelEl get hidden = true
    expect(fnSnippet).toContain('createParentEl.hidden = isGoal');
    expect(fnSnippet).toContain('createParentLabelEl.hidden = isGoal');
  });

  it('app.js handleCreateSubmit response handles 201 Created status', () => {
    const fnIdx = appJs.indexOf('async function handleCreateSubmit');
    const fnSnippet = appJs.slice(fnIdx, fnIdx + 3000);
    expect(fnSnippet).toContain('201');
    expect(fnSnippet).toContain('exitCreateForm');
    expect(fnSnippet).toContain('fetchItems');
  });
});

describe('webapp organize client — v1.14.6 styles.css', () => {
  it('styles.css has #select-toggle and #new-item-btn rules', () => {
    const stylesCss = readFileSync(
      path.join(root, 'public/webapp/organize/styles.css'),
      'utf8',
    );
    expect(stylesCss).toContain('#select-toggle');
    expect(stylesCss).toContain('#new-item-btn');
  });

  it('styles.css has #select-bar rule', () => {
    const stylesCss = readFileSync(
      path.join(root, 'public/webapp/organize/styles.css'),
      'utf8',
    );
    expect(stylesCss).toContain('#select-bar');
  });

  it('styles.css has .select-checkbox rule (D11 square checkbox)', () => {
    const stylesCss = readFileSync(
      path.join(root, 'public/webapp/organize/styles.css'),
      'utf8',
    );
    expect(stylesCss).toContain('.select-checkbox');
  });

  it('styles.css has #create-form rule', () => {
    const stylesCss = readFileSync(
      path.join(root, 'public/webapp/organize/styles.css'),
      'utf8',
    );
    expect(stylesCss).toContain('#create-form');
  });

  it('styles.css has #bulk-delete-typed-confirm rule (R2)', () => {
    const stylesCss = readFileSync(
      path.join(root, 'public/webapp/organize/styles.css'),
      'utf8',
    );
    expect(stylesCss).toContain('#bulk-delete-typed-confirm');
  });
});

/**
 * Regression: v1.14.1 [hidden] specificity fix.
 *
 * Stylesheets define `#detail-panel { display: flex }` and
 * `.features { display: flex }` on elements that are INITIALLY rendered with
 * the `hidden` HTML attribute. Without an explicit `[hidden] { display: none
 * !important }` rule, the author CSS wins by specificity and the supposedly
 * hidden elements show on first paint — which is how a v1.14.0 user saw the
 * empty detail panel ("Notes" + "Progress" headers) before tapping any item.
 *
 * These tests assert the override is present in BOTH stylesheets so a future
 * rewrite cannot reintroduce the bug without tripping CI.
 */
describe('webapp [hidden] specificity guard — v1.14.1 regression', () => {
  const organizeCss = readFileSync(path.join(root, 'public/webapp/organize/styles.css'), 'utf8');
  const hubCss = readFileSync(path.join(root, 'public/webapp/styles.css'), 'utf8');

  // Tolerant of whitespace + lowercase/uppercase variations of !important
  const HIDDEN_OVERRIDE_RE = /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/i;

  it('organize/styles.css has [hidden] { display: none !important }', () => {
    expect(organizeCss).toMatch(HIDDEN_OVERRIDE_RE);
  });

  it('webapp/styles.css has [hidden] { display: none !important }', () => {
    expect(hubCss).toMatch(HIDDEN_OVERRIDE_RE);
  });

  it('organize/styles.css still applies display:flex to #detail-panel (override is needed)', () => {
    // Sanity: if a refactor removes the conflicting rule, the override is no
    // longer load-bearing — but until then this test documents WHY it exists.
    expect(organizeCss).toMatch(/#detail-panel\s*\{[^}]*display\s*:\s*flex/);
  });

  it('webapp/styles.css still applies display:flex to .features (override is needed)', () => {
    expect(hubCss).toMatch(/\.features\s*\{[^}]*display\s*:\s*flex/);
  });
});

// ==================================================================
// v1.15.0 — Kanban + Calendar + View-switcher tests (Commit 7)
// ==================================================================

// ------------------------------------------------------------------
// v1.15.0 — View switcher: HTML structure
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 index.html view-switcher structure', () => {
  it('index.html has #view-list button', () => {
    expect(indexHtml).toContain('id="view-list"');
  });

  it('index.html has #view-kanban button', () => {
    expect(indexHtml).toContain('id="view-kanban"');
  });

  it('index.html has #view-calendar button', () => {
    expect(indexHtml).toContain('id="view-calendar"');
  });

  it('view switcher nav has aria-label="View"', () => {
    expect(indexHtml).toContain('aria-label="View"');
  });

  it('view-list button is initially active', () => {
    // The list button must carry class="view-btn active" on initial render
    expect(indexHtml).toMatch(/id="view-list"[^>]*class="view-btn active"|class="view-btn active"[^>]*id="view-list"/);
  });

  it('view-kanban and view-calendar buttons are NOT initially active', () => {
    // Only view-list must be active on initial render; kanban and calendar should not have active class
    const kanbanMatch = indexHtml.match(/id="view-kanban"[^>]*/);
    expect(kanbanMatch).not.toBeNull();
    expect(kanbanMatch![0]).not.toContain('active');
    const calMatch = indexHtml.match(/id="view-calendar"[^>]*/);
    expect(calMatch).not.toBeNull();
    expect(calMatch![0]).not.toContain('active');
  });

  it('index.html has #kanban-view section (initially hidden)', () => {
    expect(indexHtml).toContain('id="kanban-view"');
    expect(indexHtml).toMatch(/id="kanban-view"[^>]*hidden|<section[^>]*hidden[^>]*id="kanban-view"/);
  });

  it('#kanban-view has aria-label="Kanban board"', () => {
    expect(indexHtml).toContain('aria-label="Kanban board"');
  });

  it('index.html has #calendar-view section (initially hidden)', () => {
    expect(indexHtml).toContain('id="calendar-view"');
    expect(indexHtml).toMatch(/id="calendar-view"[^>]*hidden|<section[^>]*hidden[^>]*id="calendar-view"/);
  });

  it('#calendar-view has aria-label="Calendar"', () => {
    expect(indexHtml).toContain('aria-label="Calendar"');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — View switcher: calendar sub-structure
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 index.html calendar structure', () => {
  it('calendar header has #cal-prev button', () => {
    expect(indexHtml).toContain('id="cal-prev"');
  });

  it('calendar header has #cal-next button', () => {
    expect(indexHtml).toContain('id="cal-next"');
  });

  it('calendar header has #cal-today button', () => {
    expect(indexHtml).toContain('id="cal-today"');
  });

  it('calendar has .calendar-month-label span', () => {
    expect(indexHtml).toContain('class="calendar-month-label"');
  });

  it('calendar has .calendar-board div', () => {
    expect(indexHtml).toContain('class="calendar-board"');
  });

  it('calendar has subview chips: month, week, day', () => {
    expect(indexHtml).toContain('data-calendar-subview="month"');
    expect(indexHtml).toContain('data-calendar-subview="week"');
    expect(indexHtml).toContain('data-calendar-subview="day"');
  });

  it('calendar month chip is initially active', () => {
    // The month chip must carry the "active" class on initial render
    const monthChipMatch = indexHtml.match(/data-calendar-subview="month"[^>]*/);
    expect(monthChipMatch).not.toBeNull();
    expect(monthChipMatch![0]).toContain('active');
  });

  it('index.html has #calendar-conflict-banner (initially hidden)', () => {
    expect(indexHtml).toContain('id="calendar-conflict-banner"');
    expect(indexHtml).toMatch(/id="calendar-conflict-banner"[^>]*hidden|<div[^>]*hidden[^>]*id="calendar-conflict-banner"/);
  });

  it('#calendar-conflict-banner has role="alertdialog" and aria-live="polite"', () => {
    const bannerIdx = indexHtml.indexOf('id="calendar-conflict-banner"');
    expect(bannerIdx).toBeGreaterThan(-1);
    // Check the surrounding region (within 200 chars) contains both attributes
    const region = indexHtml.slice(bannerIdx - 10, bannerIdx + 200);
    expect(region).toContain('role="alertdialog"');
    expect(region).toContain('aria-live="polite"');
  });

  it('#calendar-conflict-banner has .calendar-conflict-view button', () => {
    expect(indexHtml).toContain('class="calendar-conflict-view"');
  });

  it('#calendar-conflict-banner has .calendar-conflict-dismiss button', () => {
    expect(indexHtml).toContain('class="calendar-conflict-dismiss"');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — View switcher: app.js constants + functions
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 app.js view switcher constants', () => {
  it('app.js defines ORGANIZE_VIEW_KEY constant', () => {
    expect(appJs).toContain("ORGANIZE_VIEW_KEY = 'organize-view-state-v1'");
  });

  it('app.js defines BROADCAST_CHANNEL_FALLBACK constant', () => {
    expect(appJs).toContain("BROADCAST_CHANNEL_FALLBACK = 'organize-mutations-jarvis'");
  });

  it('app.js defines _resolvedChannelName variable, initialised to BROADCAST_CHANNEL_FALLBACK', () => {
    expect(appJs).toContain('_resolvedChannelName = BROADCAST_CHANNEL_FALLBACK');
  });

  it('app.js declares currentViewMode variable', () => {
    expect(appJs).toContain("currentViewMode = 'list'");
  });

  it('app.js defines loadView function', () => {
    expect(appJs).toContain('function loadView');
  });

  it('app.js defines saveView function', () => {
    expect(appJs).toContain('function saveView');
  });

  it('app.js defines switchView function', () => {
    expect(appJs).toContain('function switchView');
  });

  it('app.js defines fetchWebappConfig function', () => {
    expect(appJs).toContain('async function fetchWebappConfig');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — R7 strict-equal whitelist injection probes (ADR 015 R7)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 R7: loadView strict-equal whitelist', () => {
  it('loadView uses strict-equal triple-OR — not Array.includes (R7 injection-probe defense)', () => {
    // R7: no Array.includes on the view whitelist — use === comparisons only
    const fnIdx = appJs.indexOf('function loadView');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    // The strict-equal triple-OR pattern must be present
    expect(fnBody).toContain("raw === 'list'");
    expect(fnBody).toContain("raw === 'kanban'");
    expect(fnBody).toContain("raw === 'calendar'");
    // Array.includes must NOT be used for whitelist comparison
    expect(fnBody).not.toContain('.includes(');
  });

  it('loadView rejects __proto__ — returns list (R7 injection probe)', () => {
    // The loadView logic: anything that is not strictly 'list', 'kanban', or 'calendar'
    // must be rejected. We assert by checking the source structure: only strict-equal passes.
    const fnIdx = appJs.indexOf('function loadView');
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    // The fallback must return 'list' when no valid value is found
    expect(fnBody).toContain("return 'list'");
    // And the only passing condition is strict-equal (no fuzzy match)
    expect(fnBody).not.toMatch(/\.toLowerCase\s*\(\s*\)/);
    expect(fnBody).not.toMatch(/\.trim\s*\(\s*\)/);
  });

  it('loadView rejects "LIST" (capitalised) — falls through to default list (R7)', () => {
    // The strict-equal === ensures case-sensitive comparison; 'LIST' !== 'list'
    const fnIdx = appJs.indexOf('function loadView');
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    // Confirm no case-insensitive flag or toLowerCase (which would accept "LIST")
    expect(fnBody).not.toContain('.toLowerCase');
    // The pattern: raw === 'list' (NOT raw.toLowerCase() === 'list')
    expect(fnBody).toMatch(/raw\s*===\s*'list'/);
  });

  it('loadView rejects "Kanban" (mixed case) — falls through to default list (R7)', () => {
    const fnIdx = appJs.indexOf('function loadView');
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    // Must use raw === 'kanban' (exact), not case-insensitive match
    expect(fnBody).toMatch(/raw\s*===\s*'kanban'/);
    expect(fnBody).not.toContain('toLowerCase');
  });

  it('saveView has symmetrical strict-equal guard (defensive against injection)', () => {
    const fnIdx = appJs.indexOf('function saveView');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = appJs.slice(fnIdx, fnIdx + 300);
    // saveView must reject any non-whitelisted value before writing to sessionStorage
    expect(fnBody).toContain("view !== 'list'");
    expect(fnBody).toContain("view !== 'kanban'");
    expect(fnBody).toContain("view !== 'calendar'");
    // And it must return early (not write) for invalid input
    expect(fnBody).toContain('return');
  });

  it('switchView has strict-equal guard mirroring loadView (R7 defense-in-depth)', () => {
    const fnIdx = appJs.indexOf('function switchView');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    // switchView must also validate the incoming argument with strict equality
    expect(fnBody).toContain("targetView !== 'list'");
    expect(fnBody).toContain("targetView !== 'kanban'");
    expect(fnBody).toContain("targetView !== 'calendar'");
  });
});

// ------------------------------------------------------------------
// v1.15.0 — View switcher: mode-exit multi-select (D8)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 D8: switchView exits multi-select', () => {
  it('switchView calls exitSelectMode when multiSelectMode is true (D8)', () => {
    const fnIdx = appJs.indexOf('function switchView');
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    // Must check multiSelectMode and call exitSelectMode on view switch
    expect(fnBody).toContain('multiSelectMode');
    expect(fnBody).toContain('exitSelectMode()');
  });

  it('switchView calls exitKanbanView when leaving kanban', () => {
    const fnIdx = appJs.indexOf('function switchView');
    const fnBody = appJs.slice(fnIdx, fnIdx + 800);
    expect(fnBody).toContain('exitKanbanView');
  });

  it('switchView calls exitCalendarView when leaving calendar', () => {
    const fnIdx = appJs.indexOf('function switchView');
    const fnBody = appJs.slice(fnIdx, fnIdx + 800);
    expect(fnBody).toContain('exitCalendarView');
  });

  it('switchView calls cancelPendingRollback when leaving kanban (R3 D8)', () => {
    const fnIdx = appJs.indexOf('function switchView');
    const fnBody = appJs.slice(fnIdx, fnIdx + 800);
    expect(fnBody).toContain('cancelPendingRollback');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — R2 HIGH: Kanban tutorial toast contract
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 R2: kanban tutorial toast contract (kanban-view.js)', () => {
  const kanbanJs = readFileSync(
    path.join(root, 'public/webapp/organize/kanban-view.js'),
    'utf8',
  );

  it('kanban-view.js exports KANBAN_TUTORIAL_KEY constant', () => {
    expect(kanbanJs).toContain("KANBAN_TUTORIAL_KEY = 'organize-kanban-tutorial-seen'");
  });

  it('kanban-view.js exports KANBAN_TUTORIAL_TOAST_MS = 8000 (R2 timer binding)', () => {
    expect(kanbanJs).toContain('KANBAN_TUTORIAL_TOAST_MS = 8000');
  });

  it('kanban-view.js exports KANBAN_TUTORIAL_TEXT with exact literal (R2 text binding)', () => {
    expect(kanbanJs).toContain(
      "KANBAN_TUTORIAL_TEXT = 'Tap a task card to pick it up, then tap a goal column to drop it.'",
    );
  });

  it('tutorial toast checks sessionStorage before showing (R2: show on first entry only)', () => {
    // The toast is shown only when the key is NOT present in sessionStorage
    expect(kanbanJs).toContain('sessionStorage.getItem(KANBAN_TUTORIAL_KEY)');
    // After showing, the key is written so subsequent entries skip the toast
    expect(kanbanJs).toContain("sessionStorage.setItem(KANBAN_TUTORIAL_KEY, '1')");
  });

  it('tutorial toast uses KANBAN_TUTORIAL_TOAST_MS duration constant (not inline literal)', () => {
    // The showToast call must reference the named constant, not a bare 8000 literal
    // Both KANBAN_TUTORIAL_TEXT and KANBAN_TUTORIAL_TOAST_MS must appear in the tutorial block
    expect(kanbanJs).toContain('KANBAN_TUTORIAL_TOAST_MS');
    // And there must be NO bare 8000 literal in a showToast call (regression guard)
    expect(kanbanJs).not.toMatch(/_showToast\s*\([^)]+,\s*8000\s*\)/);
  });

  it('tutorial toast does NOT use innerHTML on user content (textContent enforcement)', () => {
    // kanban-view.js delegates toast display to app.js _showToast; it must not set innerHTML
    // on user content — only safe empty-clears (innerHTML = '') are permitted
    const dangerous = kanbanJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });
});

// ------------------------------------------------------------------
// v1.15.0 — R3 HIGH: active-drag rollback cancellation (kanban-view.js)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 R3: cancelPendingRollback contract (kanban-view.js)', () => {
  const kanbanJs = readFileSync(
    path.join(root, 'public/webapp/organize/kanban-view.js'),
    'utf8',
  );

  it('cancelPendingRollback is exported from kanban-view.js', () => {
    expect(kanbanJs).toContain('export function cancelPendingRollback');
  });

  it('cancelPendingRollback removes rollback-animating class from card element', () => {
    const fnIdx = kanbanJs.indexOf('export function cancelPendingRollback');
    const fnBody = kanbanJs.slice(fnIdx, fnIdx + 400);
    expect(fnBody).toContain('rollback-animating');
    expect(fnBody).toContain('classList.remove');
  });

  it('cancelPendingRollback cancels requestAnimationFrame + clearTimeout (R3)', () => {
    const fnIdx = kanbanJs.indexOf('export function cancelPendingRollback');
    const fnBody = kanbanJs.slice(fnIdx, fnIdx + 700);
    // Both the rAF cancellation and timer cancellation must be present
    expect(fnBody).toMatch(/cancelAnimationFrame|clearTimeout/);
    expect(fnBody).toContain('_pendingRollback = null');
  });

  it('handleCardTap calls cancelPendingRollback FIRST before any pickup state change (R3)', () => {
    // R3: a new tap must cancel any in-flight rollback before establishing new pickup state
    const fnIdx = kanbanJs.indexOf('export function handleCardTap');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = kanbanJs.slice(fnIdx, fnIdx + 200);
    // cancelPendingRollback must be the very first meaningful call in the function
    const cancelIdx = fnBody.indexOf('cancelPendingRollback()');
    const pickupStateIdx = fnBody.indexOf('_pickedItem');
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeLessThan(pickupStateIdx);
  });

  it('enterKanbanView calls cancelPendingRollback (R3: clears state on view entry)', () => {
    const fnIdx = kanbanJs.indexOf('export function enterKanbanView');
    const fnBody = kanbanJs.slice(fnIdx, fnIdx + 200);
    expect(fnBody).toContain('cancelPendingRollback');
  });

  it('exitKanbanView calls cancelPendingRollback (R3: clears in-flight rollback on exit)', () => {
    const fnIdx = kanbanJs.indexOf('export function exitKanbanView');
    const fnBody = kanbanJs.slice(fnIdx, fnIdx + 200);
    expect(fnBody).toContain('cancelPendingRollback');
  });

  it('kanban-view.js is imported into app.js with cancelPendingRollback named import', () => {
    // app.js must import cancelPendingRollback to wire it through switchView (D8/R3)
    expect(appJs).toContain('cancelPendingRollback');
    expect(appJs).toMatch(/import\s*\{[^}]*cancelPendingRollback[^}]*\}\s*from\s*['"]\.\/kanban-view\.js['"]/);
  });
});

// ------------------------------------------------------------------
// v1.15.0 — R8 MEDIUM: full re-render from renderedItems on rollback
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 R8: full re-render contract', () => {
  const kanbanJs = readFileSync(
    path.join(root, 'public/webapp/organize/kanban-view.js'),
    'utf8',
  );

  it('kanban onPatchSuccess callback triggers renderKanban(renderedItems) in app.js (R8)', () => {
    // R8: after any DnD PATCH (success or rollback), a full re-render must happen
    // We check that the onPatchSuccess callback in the initKanbanView call includes renderKanban
    const initIdx = appJs.indexOf('initKanbanView(');
    expect(initIdx).toBeGreaterThan(-1);
    const cbRegion = appJs.slice(initIdx, initIdx + 1500);
    expect(cbRegion).toContain('renderKanban(renderedItems)');
  });

  it('kanban onPatchSuccess in app.js updates renderedItems before re-render (R8 ordering)', () => {
    // renderedItems must be updated BEFORE renderKanban is called
    const initIdx = appJs.indexOf('initKanbanView(');
    const cbRegion = appJs.slice(initIdx, initIdx + 1500);
    const updateIdx = cbRegion.indexOf('renderedItems[idx]');
    const renderIdx = cbRegion.indexOf('renderKanban(renderedItems)');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeLessThan(renderIdx);
  });

  it('kanban-view.js does NOT do surgical DOM patching on rollback (no querySelector in rollback path)', () => {
    // The rollback path must call _onPatchSuccess (which triggers full re-render in app.js)
    // and must NOT surgically patch individual DOM nodes after rollback
    // The rollback branches call _onPatchSuccess with { optimistic: false, rollback: true }
    expect(kanbanJs).toContain("rollback: true");
    expect(kanbanJs).toContain('_onPatchSuccess');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — Kanban view structure (kanban-view.js)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 kanban-view.js structure', () => {
  const kanbanJs = readFileSync(
    path.join(root, 'public/webapp/organize/kanban-view.js'),
    'utf8',
  );

  it('kanban-view.js exports renderKanban function', () => {
    expect(kanbanJs).toContain('export function renderKanban');
  });

  it('kanban-view.js exports initKanbanView function', () => {
    expect(kanbanJs).toContain('export function initKanbanView');
  });

  it('kanban-view.js exports enterKanbanView and exitKanbanView', () => {
    expect(kanbanJs).toContain('export function enterKanbanView');
    expect(kanbanJs).toContain('export function exitKanbanView');
  });

  it('kanban-view.js cards are draggable (li.draggable = true for HTML5 DnD coexistence)', () => {
    expect(kanbanJs).toContain('draggable = true');
  });

  it('kanban-view.js uses card-pickup-selected class for visual pickup state (D1)', () => {
    expect(kanbanJs).toContain('card-pickup-selected');
  });

  it('kanban-view.js uses rollback-animating class for rollback animation (R3)', () => {
    expect(kanbanJs).toContain('rollback-animating');
  });

  it('kanban-view.js uses card-done class for completed items', () => {
    expect(kanbanJs).toContain('card-done');
  });

  it('kanban-view.js does NOT use innerHTML on user content (ADR 009 decision 6)', () => {
    const dangerous = kanbanJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('kanban-view.js uses textContent for item titles', () => {
    expect(kanbanJs).toContain('textContent');
  });

  it('kanban-view.js sends PATCH with If-Match on drop (ETag concurrency)', () => {
    expect(kanbanJs).toContain('If-Match');
  });

  it('kanban-view.js uses Authorization: tma header for PATCH calls', () => {
    expect(kanbanJs).toContain('tma ${');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — styles.css: view switcher, kanban, calendar rules
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 styles.css view-switcher and kanban rules', () => {
  const stylesCss = readFileSync(
    path.join(root, 'public/webapp/organize/styles.css'),
    'utf8',
  );

  it('styles.css has .view-switcher rule', () => {
    expect(stylesCss).toContain('.view-switcher');
  });

  it('styles.css has .view-btn rule', () => {
    expect(stylesCss).toContain('.view-btn');
  });

  it('styles.css has .view-btn.active rule', () => {
    expect(stylesCss).toContain('.view-btn.active');
  });

  it('styles.css has .kanban-board rule', () => {
    expect(stylesCss).toContain('.kanban-board');
  });

  it('styles.css has .kanban-column rule', () => {
    expect(stylesCss).toContain('.kanban-column');
  });

  it('styles.css has .kanban-card rule', () => {
    expect(stylesCss).toContain('.kanban-card');
  });

  it('styles.css has .card-pickup-selected rule (D1 visual pick affordance)', () => {
    expect(stylesCss).toContain('.card-pickup-selected');
  });

  it('styles.css has .rollback-animating rule (R3 transition)', () => {
    expect(stylesCss).toContain('.rollback-animating');
  });

  it('styles.css has .card-done rule (done item visual distinction)', () => {
    expect(stylesCss).toContain('.card-done');
  });

  it('styles.css has .calendar-header rule', () => {
    expect(stylesCss).toContain('.calendar-header');
  });

  it('styles.css has .calendar-month-grid rule (7-column grid)', () => {
    expect(stylesCss).toContain('.calendar-month-grid');
  });

  it('styles.css has .calendar-day-cell rule', () => {
    expect(stylesCss).toContain('.calendar-day-cell');
  });

  it('styles.css has .cell-today rule', () => {
    expect(stylesCss).toContain('.cell-today');
  });

  it('styles.css has .cell-other-month rule', () => {
    expect(stylesCss).toContain('.cell-other-month');
  });

  it('styles.css has .cell-drop-target rule (DnD visual feedback)', () => {
    expect(stylesCss).toContain('.cell-drop-target');
  });

  it('styles.css has .cell-highlight-pulse rule (R6 cross-month 412 banner flash)', () => {
    expect(stylesCss).toContain('.cell-highlight-pulse');
  });

  it('styles.css has #calendar-conflict-banner rule', () => {
    expect(stylesCss).toContain('#calendar-conflict-banner');
  });

  it('styles.css has .calendar-item-pill rule', () => {
    expect(stylesCss).toContain('.calendar-item-pill');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — Calendar view (calendar-view.js)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 calendar-view.js structure', () => {
  const calendarJs = readFileSync(
    path.join(root, 'public/webapp/organize/calendar-view.js'),
    'utf8',
  );

  it('calendar-view.js exports renderCalendar function', () => {
    expect(calendarJs).toContain('export function renderCalendar');
  });

  it('calendar-view.js exports initCalendarView function', () => {
    expect(calendarJs).toContain('export function initCalendarView');
  });

  it('calendar-view.js exports enterCalendarView and exitCalendarView', () => {
    expect(calendarJs).toContain('export function enterCalendarView');
    expect(calendarJs).toContain('export function exitCalendarView');
  });

  it('calendar-view.js exports handleCalendarDnD (PATCH on reschedule)', () => {
    expect(calendarJs).toContain('export async function handleCalendarDnD');
  });

  it('calendar-view.js exports showCalendarConflictBanner (R6)', () => {
    expect(calendarJs).toContain('export function showCalendarConflictBanner');
  });

  it('calendar-view.js defines CALENDAR_SUBVIEW_KEY constant', () => {
    expect(calendarJs).toContain("CALENDAR_SUBVIEW_KEY = 'organize-calendar-subview-v1'");
  });

  it('calendar-view.js defines FIRST_DAY_OF_WEEK = 1 (Monday per D5.a)', () => {
    expect(calendarJs).toContain('FIRST_DAY_OF_WEEK = 1');
  });

  it('calendar-view.js initialises _currentSubview to "month"', () => {
    expect(calendarJs).toContain("_currentSubview = 'month'");
  });

  it('calendar-view.js does NOT use innerHTML on user content (ADR 009 decision 6)', () => {
    const dangerous = calendarJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('calendar-view.js uses textContent for item titles', () => {
    expect(calendarJs).toContain('textContent');
  });

  it('calendar-view.js imports from dates.js (parseISO, formatISO, monthGrid)', () => {
    expect(calendarJs).toMatch(/from\s*['"]\.\/dates\.js['"]/);
    expect(calendarJs).toContain('parseISO');
    expect(calendarJs).toContain('formatISO');
    expect(calendarJs).toContain('monthGrid');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — R6 MEDIUM: cross-month 412 conflict banner (calendar-view.js)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 R6: calendar cross-month 412 conflict banner', () => {
  const calendarJs = readFileSync(
    path.join(root, 'public/webapp/organize/calendar-view.js'),
    'utf8',
  );

  it('showCalendarConflictBanner uses textContent for item title (not innerHTML)', () => {
    const fnIdx = calendarJs.indexOf('export function showCalendarConflictBanner');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 600);
    // Item title must be set via textContent
    expect(fnBody).toContain('textContent');
    // Must NOT use innerHTML for user content
    expect(fnBody).not.toMatch(/\.innerHTML\s*=\s*[^'"]/);
  });

  it('showCalendarConflictBanner adds cell-highlight-pulse class (R6 flash)', () => {
    const fnIdx = calendarJs.indexOf('export function showCalendarConflictBanner');
    // Function is long (~60 lines); use 2500 chars to capture all logic
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 2500);
    expect(fnBody).toContain('cell-highlight-pulse');
    expect(fnBody).toContain('classList.add');
  });

  it('showCalendarConflictBanner removes cell-highlight-pulse after timeout (R6)', () => {
    const fnIdx = calendarJs.indexOf('export function showCalendarConflictBanner');
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 2500);
    expect(fnBody).toContain('classList.remove');
    // The removal must happen via setTimeout
    expect(fnBody).toContain('setTimeout');
  });

  it('calendar-view.js calls showCalendarConflictBanner on 412 response in handleCalendarDnD (R6)', () => {
    const dndIdx = calendarJs.indexOf('export async function handleCalendarDnD');
    expect(dndIdx).toBeGreaterThan(-1);
    // Function is ~50 lines; use 2000 chars
    const fnBody = calendarJs.slice(dndIdx, dndIdx + 2000);
    expect(fnBody).toContain('showCalendarConflictBanner');
    // 412 is PRECONDITION_FAILED — the status check must be present
    expect(fnBody).toContain('412');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — Calendar DnD: PATCH with If-Match (calendar-view.js)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 calendar DnD fires PATCH with If-Match', () => {
  const calendarJs = readFileSync(
    path.join(root, 'public/webapp/organize/calendar-view.js'),
    'utf8',
  );

  it('handleCalendarDnD fires PATCH request (not GET/POST/DELETE)', () => {
    const fnIdx = calendarJs.indexOf('export async function handleCalendarDnD');
    // Function is ~50 lines; use 2000 chars
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 2000);
    expect(fnBody).toContain("method: 'PATCH'");
  });

  it('handleCalendarDnD sends If-Match header when ETag is available', () => {
    const fnIdx = calendarJs.indexOf('export async function handleCalendarDnD');
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 2000);
    // The function uses the IF_MATCH_HEADER constant (defined at top of file as 'If-Match')
    expect(fnBody).toContain('IF_MATCH_HEADER');
    // The constant itself must be defined as 'If-Match' at module level
    expect(calendarJs).toContain("IF_MATCH_HEADER = 'If-Match'");
  });

  it('handleCalendarDnD sends { due: formatISO(newDate) } in PATCH body (D3 calendar-date semantics)', () => {
    const fnIdx = calendarJs.indexOf('export async function handleCalendarDnD');
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 2000);
    expect(fnBody).toContain('formatISO');
    expect(fnBody).toContain('due');
  });

  it('handleCalendarDnD is a no-op when same-day drop (D6 guard)', () => {
    // Same-day drop must return early without firing PATCH
    // The guard compares ISO strings: newIso === oldIso (same-day means same YYYY-MM-DD)
    const fnIdx = calendarJs.indexOf('export async function handleCalendarDnD');
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 2000);
    // The same-day guard: newIso === oldIso (or isSameDay — either is valid)
    expect(fnBody).toMatch(/newIso\s*===\s*oldIso|isSameDay/);
    // The early return for same day
    expect(fnBody).toContain('return');
  });

  it('handleCalendarDnD uses Authorization: tma header', () => {
    const fnIdx = calendarJs.indexOf('export async function handleCalendarDnD');
    const fnBody = calendarJs.slice(fnIdx, fnIdx + 2000);
    expect(fnBody).toContain('tma ${');
  });

  it('calendar subview key whitelist uses strict-equal (R7 injection-probe defense)', () => {
    // The subview restoration from sessionStorage must use strict-equal whitelist
    const loadSubviewIdx = calendarJs.indexOf('sessionStorage.getItem(CALENDAR_SUBVIEW_KEY)');
    expect(loadSubviewIdx).toBeGreaterThan(-1);
    // After the getItem call, only 'month', 'week', 'day' should be accepted
    const region = calendarJs.slice(loadSubviewIdx, loadSubviewIdx + 300);
    expect(region).toMatch(/===\s*'month'|===\s*'week'|===\s*'day'/);
  });
});

// ------------------------------------------------------------------
// v1.15.0 — Calendar timezone: UTC-only, no timezone conversion (W3)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 W3: calendar UTC-only / no timezone conversion', () => {
  const calendarJs = readFileSync(
    path.join(root, 'public/webapp/organize/calendar-view.js'),
    'utf8',
  );

  it('calendar-view.js uses UTC Date methods only — no getFullYear/getMonth/getDate without UTC (W3)', () => {
    // All calendar date operations must use UTC methods to avoid DST shifts
    // Check that local-time getters that could cause off-by-one don't appear in cell placement
    // We look specifically for standalone (non-UTC) getFullYear/getMonth/getDate calls
    // which would be a regression introducing timezone conversion
    const nonUtcDateGetters = calendarJs.match(/\bdate\.(getFullYear|getMonth|getDate|getDay)\s*\(/g);
    expect(nonUtcDateGetters).toBeNull();
  });

  it('calendar-view.js does not call new Date(iso_string) for cell placement (DST regression guard)', () => {
    // Using new Date('YYYY-MM-DD') would produce midnight LOCAL time, causing off-by-one around DST
    // All calendar cell dates must come through parseISO or today() from dates.js
    // (which produce UTC midnight dates safely)
    // We check that parseISO is used for item due-date parsing (not raw new Date(item.due))
    const rawDateCallsOnDue = calendarJs.match(/new\s+Date\s*\(\s*item\.due/g);
    expect(rawDateCallsOnDue).toBeNull();
  });

  it('dates.js has top-of-file JSDoc rationale block (W3)', () => {
    const datesJs = readFileSync(path.join(root, 'public/webapp/organize/dates.js'), 'utf8');
    // W3: the JSDoc block must contain the "DO NOT introduce timezone conversion" warning
    expect(datesJs).toContain('DO NOT introduce timezone conversion');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — D9: fetchWebappConfig → dynamic BroadcastChannel name
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 D9: fetchWebappConfig dynamic channel name', () => {
  it('app.js defines fetchWebappConfig async function', () => {
    expect(appJs).toContain('async function fetchWebappConfig');
  });

  it('fetchWebappConfig fetches /api/webapp/config with tma auth header', () => {
    const fnIdx = appJs.indexOf('async function fetchWebappConfig');
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    expect(fnBody).toContain('/api/webapp/config');
    expect(fnBody).toContain('tma ${');
  });

  it('fetchWebappConfig sets _resolvedChannelName from data.broadcastChannelName on 200 (D9)', () => {
    const fnIdx = appJs.indexOf('async function fetchWebappConfig');
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    expect(fnBody).toContain('_resolvedChannelName');
    expect(fnBody).toContain('data.broadcastChannelName');
  });

  it('fetchWebappConfig falls back to BROADCAST_CHANNEL_FALLBACK on non-200 / 404 (D9)', () => {
    // The fallback assignment is in the function body; the constant is defined at module level.
    // Both must be present in the file (constant definition + usage inside the function).
    expect(appJs).toContain("BROADCAST_CHANNEL_FALLBACK = 'organize-mutations-jarvis'");
    // The fallback assignment inside the function: either direct assignment or via the constant
    expect(appJs).toContain('_resolvedChannelName = BROADCAST_CHANNEL_FALLBACK');
  });

  it('fetchWebappConfig is called BEFORE initBroadcastChannel at boot (D9 ordering)', () => {
    // The ordering in DOMContentLoaded: fetchWebappConfig(initData).then(() => { initBroadcastChannel() })
    // We find the CALL sites (not function definitions) and compare their positions in source.
    // fetchWebappConfig(initData) call — appears in DOMContentLoaded
    const fetchCallIdx = appJs.indexOf('fetchWebappConfig(initData)');
    expect(fetchCallIdx).toBeGreaterThan(-1);
    // initBroadcastChannel() call — appears INSIDE the .then() callback after fetchWebappConfig
    // Find it AFTER the fetchWebappConfig call (the function def at ~line 438 comes first; we skip it)
    const initBcCallIdx = appJs.indexOf('initBroadcastChannel()', fetchCallIdx);
    expect(initBcCallIdx).toBeGreaterThan(-1);
    // The fetchWebappConfig CALL must come before the initBroadcastChannel CALL in source order
    expect(fetchCallIdx).toBeLessThan(initBcCallIdx);
  });

  it('initBroadcastChannel uses _resolvedChannelName (not hardcoded ORGANIZE_MUTATIONS_CHANNEL)', () => {
    const fnIdx = appJs.indexOf('function initBroadcastChannel');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = appJs.slice(fnIdx, fnIdx + 600);
    expect(fnBody).toContain('_resolvedChannelName');
    // The BroadcastChannel constructor must use _resolvedChannelName
    expect(fnBody).toContain('new BroadcastChannel(_resolvedChannelName)');
  });
});

// ------------------------------------------------------------------
// v1.15.0 — Module split verification (R1 BLOCKING)
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 R1: module split (list-view.js, edit-form.js, dates.js)', () => {
  it('list-view.js file exists', () => {
    expect(() =>
      readFileSync(path.join(root, 'public/webapp/organize/list-view.js'), 'utf8'),
    ).not.toThrow();
  });

  it('edit-form.js file exists', () => {
    expect(() =>
      readFileSync(path.join(root, 'public/webapp/organize/edit-form.js'), 'utf8'),
    ).not.toThrow();
  });

  it('dates.js file exists', () => {
    expect(() =>
      readFileSync(path.join(root, 'public/webapp/organize/dates.js'), 'utf8'),
    ).not.toThrow();
  });

  it('kanban-view.js file exists', () => {
    expect(() =>
      readFileSync(path.join(root, 'public/webapp/organize/kanban-view.js'), 'utf8'),
    ).not.toThrow();
  });

  it('calendar-view.js file exists', () => {
    expect(() =>
      readFileSync(path.join(root, 'public/webapp/organize/calendar-view.js'), 'utf8'),
    ).not.toThrow();
  });

  it('app.js imports from list-view.js (R1 module split)', () => {
    expect(appJs).toMatch(/from\s*['"]\.\/list-view\.js['"]/);
  });

  it('app.js imports from kanban-view.js (v1.15.0 feature)', () => {
    expect(appJs).toMatch(/from\s*['"]\.\/kanban-view\.js['"]/);
  });

  it('app.js imports from calendar-view.js (v1.15.0 feature)', () => {
    expect(appJs).toMatch(/from\s*['"]\.\/calendar-view\.js['"]/);
  });
});

// ------------------------------------------------------------------
// v1.15.0 — list-view.js and edit-form.js exports contract
// ------------------------------------------------------------------

describe('webapp organize client — v1.15.0 list-view.js exports', () => {
  const listViewJs = readFileSync(
    path.join(root, 'public/webapp/organize/list-view.js'),
    'utf8',
  );

  it('list-view.js exports buildItemCard function', () => {
    expect(listViewJs).toContain('export function buildItemCard');
  });

  it('list-view.js exports buildGoalGroup function', () => {
    expect(listViewJs).toContain('export function buildGoalGroup');
  });

  it('list-view.js exports renderList function', () => {
    expect(listViewJs).toContain('export function renderList');
  });

  it('list-view.js does not use innerHTML on user content (ADR 009 decision 6)', () => {
    const dangerous = listViewJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('list-view.js uses textContent for rendering item titles', () => {
    expect(listViewJs).toContain('textContent');
  });
});

describe('webapp organize client — v1.15.0 edit-form.js exports', () => {
  const editFormJs = readFileSync(
    path.join(root, 'public/webapp/organize/edit-form.js'),
    'utf8',
  );

  it('edit-form.js exports initEditForm function', () => {
    expect(editFormJs).toContain('export function initEditForm');
  });

  it('edit-form.js exports showConflictUI function', () => {
    expect(editFormJs).toContain('export function showConflictUI');
  });

  it('edit-form.js exports hideConflictUI function', () => {
    expect(editFormJs).toContain('export function hideConflictUI');
  });

  it('edit-form.js does not use innerHTML on user content (ADR 009 decision 6)', () => {
    const dangerous = editFormJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });
});

// ==================================================================
// v1.16.0 — markdown.js, diff.js, organize markdown swap, 3-way diff
// ADR 016 D7/D8/D15 + R3/R4/W3/W5/W6 bindings
// ==================================================================

describe('webapp organize client — v1.16.0 markdown.js source properties', () => {
  const markdownJs = readFileSync(
    path.join(root, 'public/webapp/organize/markdown.js'),
    'utf8',
  );

  // --- Basic structure ---

  it('markdown.js exports renderMarkdown function', () => {
    expect(markdownJs).toContain('export function renderMarkdown');
  });

  it('markdown.js has isSafeUrl function (R3 belt-and-suspenders validator)', () => {
    expect(markdownJs).toContain('function isSafeUrl');
  });

  it('markdown.js has parseInline function', () => {
    expect(markdownJs).toContain('function parseInline');
  });

  it('markdown.js does NOT use innerHTML for user content (ADR 009 decision 6)', () => {
    // The only .innerHTML = '' call is on the hostElement (safe structural clear).
    // User content MUST use textContent or DOM construction.
    // Pattern: innerHTML = followed by something other than empty-string literal.
    const dangerous = markdownJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`]|''\s*;)[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('markdown.js uses textContent for all user-authored text nodes', () => {
    expect(markdownJs).toContain('textContent');
  });

  it('markdown.js defines MAX_LIST_ITEMS = 200 (R4 / D7.c DOS cap)', () => {
    expect(markdownJs).toContain('MAX_LIST_ITEMS = 200');
  });

  it('markdown.js defines MAX_HEADINGS = 50 (R4 / D7.c DOS cap)', () => {
    expect(markdownJs).toContain('MAX_HEADINGS = 50');
  });

  // --- W6 bounded inline regexes ---

  it('BOLD regex uses character-class negation [^*\\n] (W6 — prevents catastrophic backtracking)', () => {
    // Pattern: \*\*([^*\n]+)\*\*
    expect(markdownJs).toMatch(/BOLD_RE\s*=\s*\/\\?\*\\?\*\(\[/);
  });

  it('ITALIC regex uses character-class negation [^*\\n] (W6)', () => {
    expect(markdownJs).toMatch(/ITALIC_RE\s*=\s*\/\\?\*\(\[/);
  });

  it('INLINE_CODE regex uses character-class negation [^`\\n] (W6)', () => {
    expect(markdownJs).toMatch(/INLINE_CODE_RE\s*=/);
    expect(markdownJs).toContain('[^`\\n]');
  });

  it('LINK regex uses character-class negation [^\\]\\n] and [^)\\n] (W6)', () => {
    expect(markdownJs).toMatch(/LINK_RE\s*=/);
    expect(markdownJs).toContain('[^\\]\\n]');
  });

  // --- R3 URL validator structure ---

  it('isSafeUrl calls decodeURIComponent for URL-encoded bypass detection (R3)', () => {
    expect(markdownJs).toContain('decodeURIComponent');
  });

  it('isSafeUrl does HTML entity unescape with decimal &#NNN; (R3)', () => {
    expect(markdownJs).toContain('&#(\\d+);');
  });

  it('isSafeUrl applies strict prefix regex /^(https?:\\/\\/|mailto:)/i (R3)', () => {
    expect(markdownJs).toContain("^(https?:\\/\\/|mailto:)");
  });

  it('isSafeUrl validates with new URL() as final check (R3)', () => {
    expect(markdownJs).toContain('new URL(');
  });

  it('isSafeUrl allowlist includes http: https: mailto: (R3)', () => {
    expect(markdownJs).toContain("'http:'");
    expect(markdownJs).toContain("'https:'");
    expect(markdownJs).toContain("'mailto:'");
  });

  it('markdown.js sets rel="noopener noreferrer" on all links (R3)', () => {
    expect(markdownJs).toContain("'noopener noreferrer'");
  });

  it('markdown.js sets target="_blank" on all links (R3)', () => {
    expect(markdownJs).toContain("'_blank'");
  });

  // --- R3 injection-probe assertions (source-level guards) ---

  it('R3-1: isSafeUrl rejects javascript: via explicit http/https/mailto prefix check', () => {
    // The guard /^(https?:\/\/|mailto:)/i ensures javascript: fails
    expect(markdownJs).toContain("!/^(https?:\\/\\/|mailto:)/i.test(final)");
  });

  it('R3-5: image syntax NOT parsed — parser does not recognize ![...](...) (R3)', () => {
    // The parser should treat ![alt](url) as plain text — no special handling for '!'
    // Verify no '![' tokenizer exists in markdown.js
    expect(markdownJs).not.toContain("'!['");
    expect(markdownJs).not.toContain('"!["');
    // Verify no img element is ever created
    expect(markdownJs).not.toContain("createElement('img')");
    expect(markdownJs).not.toContain('createElement("img")');
  });

  it('R3-6: reference-style links NOT parsed — [text][ref] form not tokenized (R3)', () => {
    // Reference-style links require two bracket groups; only inline [text](url) is supported.
    // LINK_RE matches [text](url) — not [text][ref].
    // Verify no reference-style regex (e.g., /\[.*\]\[.*\]/) exists.
    expect(markdownJs).not.toMatch(/\[\.?\*\\?\]\[\.?\*\\?\]/);
  });

  // --- R4 DOS cap assertions ---

  it('R4: list truncation marker uses class markdown-truncated (R4 / D7.c)', () => {
    expect(markdownJs).toContain("'markdown-truncated'");
  });

  it('R4: heading overflow renders as <p> paragraph (R4 / D7.c)', () => {
    // When headingCount > MAX_HEADINGS, we createElement('p'), not a heading
    expect(markdownJs).toContain("createElement('p')");
  });

  it('R4: indentation is ignored — list items created regardless of leading whitespace (D7.c)', () => {
    // The bullet/ordered regex uses /^[ \t]*- / — matches indented lines (flattened)
    expect(markdownJs).toContain('[ \\t]*-');
  });
});

// --- markdown render heading/bold/italic/code/list/link cases ---

describe('webapp organize client — v1.16.0 markdown.js render cases (source assertions)', () => {
  const markdownJs = readFileSync(
    path.join(root, 'public/webapp/organize/markdown.js'),
    'utf8',
  );

  it('renders H1/H2/H3 via createElement with tag variable (D7 heading support)', () => {
    // Headings are created with createElement(tag) where tag = 'h1'|'h2'|'h3'
    // Verify the tag variable assignment covers all three heading levels
    expect(markdownJs).toContain("'h1'");
    expect(markdownJs).toContain("'h2'");
    expect(markdownJs).toContain("'h3'");
    expect(markdownJs).toContain("createElement(tag)");
  });

  it('renders bold via createElement strong (D7 inline)', () => {
    expect(markdownJs).toContain("createElement('strong')");
  });

  it('renders italic via createElement em (D7 inline)', () => {
    expect(markdownJs).toContain("createElement('em')");
  });

  it('renders inline code via createElement code (D7 inline)', () => {
    expect(markdownJs).toContain("createElement('code')");
  });

  it('renders fenced code blocks via createElement pre + code (D7 block)', () => {
    expect(markdownJs).toContain("createElement('pre')");
  });

  it('renders bullet lists via createElement ul + li (D7 block)', () => {
    // ul is created via conditional: type === 'bullet' ? 'ul' : 'ol'
    expect(markdownJs).toContain("'ul'");
    expect(markdownJs).toContain("createElement('li')");
  });

  it('renders ordered lists via createElement ol (D7 block)', () => {
    // ol is created via conditional: type === 'bullet' ? 'ul' : 'ol'
    expect(markdownJs).toContain("'ol'");
  });

  it('renders links via createElement a with validated href (D7 inline)', () => {
    expect(markdownJs).toContain("createElement('a')");
  });

  it('renders paragraphs via createElement p (D7 block)', () => {
    expect(markdownJs).toContain("createElement('p')");
  });

  it('W6 pathological-input test: BOLD_RE is bounded — does not span newlines', () => {
    // The regex [^*\n]+ means ** at start and ** at end with no newlines in between.
    // This prevents 'aaa**bbb\n**ccc' from matching BOLD_RE across line boundaries.
    expect(markdownJs).toContain('BOLD_RE');
    // Verify the regex does NOT use .* or .+ (unbounded)
    expect(markdownJs).not.toMatch(/BOLD_RE\s*=\s*\/[^/]*\.\*/);
  });
});

// --- W5 markdown swap regression: detail view uses .markdown-content not <pre> ---

describe('webapp organize client — v1.16.0 W5 markdown swap regression', () => {
  const indexHtml = readFileSync(
    path.join(root, 'public/webapp/organize/index.html'),
    'utf8',
  );

  it('W5: detail-notes uses <div class="markdown-content"> not <pre> (markdown swap)', () => {
    // v1.16.0 D15: detail-notes is now a <div class="markdown-content">
    expect(indexHtml).toContain('id="detail-notes"');
    expect(indexHtml).toContain('class="markdown-content"');
    // Must NOT still use <pre id="detail-notes"> (the v1.14.x pattern)
    expect(indexHtml).not.toMatch(/<pre[^>]*id="detail-notes"/);
  });

  it('W5: detail-progress uses <div class="markdown-content"> not <pre> (markdown swap)', () => {
    expect(indexHtml).toContain('id="detail-progress"');
    // Must NOT still use <pre id="detail-progress">
    expect(indexHtml).not.toMatch(/<pre[^>]*id="detail-progress"/);
  });

  it('W5: app.js (or detail-panel.js) calls renderMarkdown for detail notes (D15 swap)', () => {
    // v1.17.0: renderDetail extracted to detail-panel.js — check combined sources.
    const detailPanelJs = readFileSync(path.join(root, 'public/webapp/organize/detail-panel.js'), 'utf8');
    const combined = appJs + detailPanelJs;
    expect(combined).toContain('renderMarkdown(item.notes');
    expect(combined).toContain('renderMarkdown(item.progress');
  });

  it('W5: app.js imports renderMarkdown from ./markdown.js (D15)', () => {
    // renderMarkdown imported in app.js (for test-grep compat; re-exported via detail-panel.js)
    expect(appJs).toContain("from './markdown.js'");
    expect(appJs).toContain('renderMarkdown');
  });

  it('W5: detail-panel.js has plaintext fallback catch block for renderMarkdown', () => {
    // v1.17.0: the catch block with textContent fallback is in detail-panel.js (where renderDetail lives)
    const detailPanelJs = readFileSync(path.join(root, 'public/webapp/organize/detail-panel.js'), 'utf8');
    expect(detailPanelJs).toContain('_mdErr');
  });
});

// --- P12 inline help ---

describe('webapp organize client — v1.16.0 P12 inline help in edit form', () => {
  const indexHtml = readFileSync(
    path.join(root, 'public/webapp/organize/index.html'),
    'utf8',
  );

  it('P12: notes textarea has inline help hint .form-hint (P12 binding)', () => {
    expect(indexHtml).toContain('form-hint');
    expect(indexHtml).toContain('Markdown formatting');
  });
});

// --- diff.js source assertions ---

describe('webapp organize client — v1.16.0 diff.js source properties', () => {
  const diffJs = readFileSync(
    path.join(root, 'public/webapp/organize/diff.js'),
    'utf8',
  );

  it('diff.js exports splitLines function', () => {
    expect(diffJs).toContain('export function splitLines');
  });

  it('diff.js exports linesEqual function', () => {
    expect(diffJs).toContain('export function linesEqual');
  });

  it('diff.js exports diff3 function', () => {
    expect(diffJs).toContain('export function diff3');
  });

  it('diff.js exports renderDiffPanel function', () => {
    expect(diffJs).toContain('export function renderDiffPanel');
  });

  it('diff.js exports MAX_DIFF_LINES = 200 (R4 / P6 cap)', () => {
    expect(diffJs).toContain('MAX_DIFF_LINES = 200');
  });

  it('W3: linesEqual uses trailing-whitespace trim only — /\\s+$/ pattern (W3 binding)', () => {
    // Must trim trailing whitespace: a.replace(/\s+$/, '') === b.replace(/\s+$/, '')
    expect(diffJs).toContain('/\\s+$/');
    expect(diffJs).toContain("replace(/\\s+$/, '')");
  });

  it('diff.js does NOT use innerHTML on user content (ADR 009 decision 6)', () => {
    // User content in renderDiffPanel must use textContent
    const dangerous = diffJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('diff.js renderDiffPanel uses textContent for chunk content', () => {
    expect(diffJs).toContain('textContent = chunk.text');
  });

  it('diff3 returns { fallback: true } when input exceeds MAX_DIFF_LINES (R4 / P6)', () => {
    expect(diffJs).toContain('fallback: true');
  });

  it('diff.js imports lcs as internal function (not exported)', () => {
    // lcs is an internal DP helper; not exported
    expect(diffJs).toContain('function lcs(');
    expect(diffJs).not.toContain('export function lcs');
  });
});

// --- diff dispatch in edit-form.js ---

describe('webapp organize client — v1.16.0 diff dispatch in edit-form.js', () => {
  const editFormJs = readFileSync(
    path.join(root, 'public/webapp/organize/edit-form.js'),
    'utf8',
  );

  it('edit-form.js imports diff3 and MAX_DIFF_LINES from ./diff.js (D8)', () => {
    expect(editFormJs).toContain("from './diff.js'");
    expect(editFormJs).toContain('diff3');
    expect(editFormJs).toContain('MAX_DIFF_LINES');
  });

  it('edit-form.js imports renderDiffPanel from ./diff.js (D8)', () => {
    expect(editFormJs).toContain('renderDiffPanel');
  });

  it('edit-form.js has showDiffUI function for 3-way diff overlay (D8)', () => {
    expect(editFormJs).toContain('function showDiffUI');
  });

  it('edit-form.js dispatches notes 412 to 3-way diff path (D8)', () => {
    // The conflictedField check must identify notes/progress
    expect(editFormJs).toContain("'notes' in originalPatch ? 'notes'");
    expect(editFormJs).toContain("'progress' in originalPatch ? 'progress'");
  });

  it('edit-form.js falls back to 2-button conflict UI for short fields (D8 v1.14.4 R1 path)', () => {
    // When conflictedField is null (title/due/status/tags), showConflictUI is called
    expect(editFormJs).toContain('showConflictUI(');
  });

  it('edit-form.js captures _baselineNotes and _baselineProgress at enterEditMode (D8)', () => {
    expect(editFormJs).toContain('_baselineNotes');
    expect(editFormJs).toContain('_baselineProgress');
  });

  it('P14: showDiffUI handles currentItem === null (deleted item) — renders [Item deleted] placeholder', () => {
    // serverDeleted check must be present
    expect(editFormJs).toContain('serverDeleted');
    expect(editFormJs).toContain('[Item deleted]');
  });

  it('P14: "Take Theirs" relabeled to "Discard" when server item deleted (P14)', () => {
    // When serverDeleted, the Take Theirs button is relabeled Discard
    expect(editFormJs).toContain("textContent = 'Discard'");
  });

  it('P17: diff overlay uses hidden attribute on #diff-overlay element (P17 top-overlay)', () => {
    const indexHtml = readFileSync(path.join(root, 'public/webapp/organize/index.html'), 'utf8');
    expect(indexHtml).toContain('id="diff-overlay"');
    expect(indexHtml).toMatch(/id="diff-overlay"[^>]*hidden|<div[^>]*hidden[^>]*id="diff-overlay"/);
  });

  it('P17: diff-overlay CSS uses position: fixed for top-overlay placement (P17)', () => {
    const stylesCSS = readFileSync(path.join(root, 'public/webapp/organize/styles.css'), 'utf8');
    expect(stylesCSS).toContain('.diff-overlay');
    expect(stylesCSS).toContain('position: fixed');
    expect(stylesCSS).toContain('z-index: 1000');
  });

  it('edit-form.js has handleDiffTakeMine — re-PATCH with X-Force-Override (D8)', () => {
    expect(editFormJs).toContain('function handleDiffTakeMine');
    expect(editFormJs).toContain('FORCE_OVERRIDE_HEADER');
  });

  it('edit-form.js has handleDiffTakeTheirs — triggers reload (D8)', () => {
    expect(editFormJs).toContain('function handleDiffTakeTheirs');
  });

  it('edit-form.js has handleDiffMergeSave — sends merged value with X-Force-Override (D8)', () => {
    expect(editFormJs).toContain('function handleDiffMergeSave');
  });
});
