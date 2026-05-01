/**
 * View toggle — Jarvis v1.19.0
 *
 * Pre-feature scaffold (commit 0b). Houses view-switcher logic extracted
 * from app.js to help bring app.js under the 2000-LOC trigger.
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *
 * ES module; no framework; no bundler; no new npm deps.
 */

// ------------------------------------------------------------------
// Placeholder export (scaffold — commit 0b)
// ------------------------------------------------------------------

/**
 * Initialize view toggle buttons and wire click handlers.
 * No-op scaffold — can be expanded in future iterations.
 *
 * @param {object} _cbs
 * @param {Function} _cbs.onViewChange  - (viewName: string) => void
 */
export function initViewToggle(_cbs) {
  // Scaffold placeholder — view toggle logic remains in app.js for now
  // to avoid breaking existing wiring. This module is the pre-emptive
  // split per commit 0b (W1 LOC discipline).
}

/**
 * Set the active view button visually.
 * No-op scaffold.
 *
 * @param {string} _viewName
 */
export function setActiveView(_viewName) {
  // Scaffold placeholder
}
