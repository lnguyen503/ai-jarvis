/**
 * Detail panel — Jarvis v1.17.0
 *
 * Extracted from app.js commit -1 (mechanical zero-logic-change relocation; W1 binding).
 * Contains: renderDetail, enterDetailView, exitDetailView, detail meta block rendering,
 * markdown integration, conflict UI integration, showDetailView/returnToList-partial,
 * currentDetailItem + currentDetailEtag state vars + getters/setters.
 *
 * W1 pre-extraction grep baseline in app.js: 1 (function renderDetail only).
 * W1 post-extraction grep in app.js: 0. Post-extraction grep in detail-panel.js: 1+.
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *  - No native confirm(). No inline event handlers.
 *
 * Imports:
 *   renderMarkdown from ./markdown.js
 *   enterEditMode, exitEditMode, hideConflictUI, getConflictPanelEl, showConflictUI from ./edit-form.js
 *
 * Exports:
 *   initDetailPanel(refs, callbacks)
 *   renderDetail(item)
 *   enterDetailView(item)    — show detail panel, hide list UI
 *   exitDetailView()         — reverse of enterDetailView
 *   getCurrentDetailItem()
 *   getCurrentDetailEtag()
 *   setCurrentDetailEtag(etag)
 *   clearDetailState()
 *
 * ES module; no framework; no bundler.
 */

import { renderMarkdown } from './markdown.js';
import { exitEditMode, getConflictPanelEl } from './edit-form.js';

// ------------------------------------------------------------------
// State (was in app.js — D1 picks rendering + state)
// ------------------------------------------------------------------

/** The item currently displayed in the detail panel. */
let currentDetailItem = null;

/** ETag captured from GET /:id response — sent as If-Match on mutations. */
let currentDetailEtag = null;

// ------------------------------------------------------------------
// DOM refs (populated by initDetailPanel)
// ------------------------------------------------------------------

let _detailPanelEl = null;
let _detailTitleEl = null;
let _detailMetaEl = null;
let _detailNotesEl = null;
let _detailProgressEl = null;

// ------------------------------------------------------------------
// Callbacks (set by initDetailPanel)
// ------------------------------------------------------------------

let _onReturnToList = null;       // () => void — called by exitDetailView to show list UI
let _setBackButtonAction = null;  // (action | null) => void — Telegram back button wiring
let _returnToListFn = null;       // () => void — stable reference used by back button

// ------------------------------------------------------------------
// Type icon helper (duplicated from app.js for module isolation)
// ------------------------------------------------------------------

function typeIcon(type) {
  if (type === 'task') return '📌';
  if (type === 'event') return '📅';
  if (type === 'goal') return '⚑';
  return '•';
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Initialise the detail panel with DOM refs and callbacks.
 * Must be called once from app.js DOMContentLoaded before any other export is used.
 *
 * @param {object} refs
 * @param {HTMLElement} refs.detailPanelEl
 * @param {HTMLElement} refs.detailTitleEl
 * @param {HTMLElement} refs.detailMetaEl
 * @param {HTMLElement} refs.detailNotesEl
 * @param {HTMLElement} refs.detailProgressEl
 * @param {object} callbacks
 * @param {function} callbacks.onReturnToList   — called by exitDetailView; shows list UI
 * @param {function} callbacks.setBackButtonAction — (action | null) => void
 * @param {function} callbacks.returnToListFn   — stable () => void reference used by back button
 */
export function initDetailPanel(refs, callbacks) {
  _detailPanelEl    = refs.detailPanelEl    || null;
  _detailTitleEl    = refs.detailTitleEl    || null;
  _detailMetaEl     = refs.detailMetaEl     || null;
  _detailNotesEl    = refs.detailNotesEl    || null;
  _detailProgressEl = refs.detailProgressEl || null;

  _onReturnToList       = callbacks.onReturnToList       || null;
  _setBackButtonAction  = callbacks.setBackButtonAction  || null;
  _returnToListFn       = callbacks.returnToListFn       || null;
}

/**
 * Render the detail panel for an item.
 * Mirrors the original renderDetail in app.js — zero logic changes.
 *
 * @param {object} item — item object from the API
 */
export function renderDetail(item) {
  if (!item) return;

  currentDetailItem = item;

  // Title — textContent (user-authored)
  if (_detailTitleEl) _detailTitleEl.textContent = item.title || '(untitled)';

  // Meta block: type, status, due date, tags
  if (_detailMetaEl) {
    _detailMetaEl.innerHTML = ''; // safe clear

    const typeLine = document.createElement('p');
    typeLine.className = 'detail-type';
    typeLine.textContent = `${typeIcon(item.type)} ${item.type || ''}`;
    _detailMetaEl.appendChild(typeLine);

    const statusLine = document.createElement('p');
    const statusBadge = document.createElement('span');
    statusBadge.className = `badge badge-${item.status || 'active'}`;
    statusBadge.textContent = item.status || 'active';
    statusLine.appendChild(statusBadge);
    _detailMetaEl.appendChild(statusLine);

    if (item.due && item.due.length > 0) {
      const dueLine = document.createElement('p');
      dueLine.className = 'detail-due';
      dueLine.textContent = `Due: ${item.due}`;
      _detailMetaEl.appendChild(dueLine);
    }

    if (Array.isArray(item.tags) && item.tags.length > 0) {
      const tagsLine = document.createElement('div');
      tagsLine.className = 'item-tags';
      for (const tag of item.tags) {
        const tagSpan = document.createElement('span');
        tagSpan.className = 'tag';
        tagSpan.textContent = tag; // textContent — user-authored (decision 6)
        tagsLine.appendChild(tagSpan);
      }
      _detailMetaEl.appendChild(tagsLine);
    }
  }

  // Notes — v1.16.0: render as Markdown; plaintext fallback if markdown.js throws.
  if (_detailNotesEl) {
    try {
      renderMarkdown(item.notes || '', _detailNotesEl);
    } catch (_mdErr) {
      // Plaintext fallback — safe, never innerHTML
      _detailNotesEl.textContent = item.notes || '';
    }
  }

  // Progress — v1.16.0: render as Markdown; plaintext fallback if markdown.js throws.
  if (_detailProgressEl) {
    try {
      renderMarkdown(item.progress || '', _detailProgressEl);
    } catch (_mdErr) {
      // Plaintext fallback — safe, never innerHTML
      _detailProgressEl.textContent = item.progress || '';
    }
  }

  // Ensure we're in read-only mode (in case coming back from edit)
  exitEditMode();
}

/**
 * Enter detail view — show detail panel, hide list UI, wire back button.
 * Called after fetchAndShowDetail resolves successfully in app.js.
 */
export function enterDetailView() {
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.hidden = true;
  const headerEl = document.querySelector('header');
  if (headerEl) headerEl.hidden = true;
  const filtersEl = document.querySelector('.filters');
  if (filtersEl) filtersEl.hidden = true;
  if (_detailPanelEl) _detailPanelEl.hidden = false;
  if (_setBackButtonAction && _returnToListFn) {
    _setBackButtonAction(_returnToListFn);
  }
}

/**
 * Exit detail view — hide detail panel, clear state.
 * Calls onReturnToList callback to show list UI (the complement of enterDetailView).
 */
export function exitDetailView() {
  if (_detailPanelEl) _detailPanelEl.hidden = true;
  currentDetailItem = null;
  currentDetailEtag = null;
  if (_setBackButtonAction) _setBackButtonAction(null);
  if (_onReturnToList) _onReturnToList();
}

// ------------------------------------------------------------------
// State accessors (used by app.js callbacks, edit-form.js integration)
// ------------------------------------------------------------------

/** @returns {object|null} */
export function getCurrentDetailItem() {
  return currentDetailItem;
}

/** @returns {string|null} */
export function getCurrentDetailEtag() {
  return currentDetailEtag;
}

/**
 * @param {string|null} etag
 */
export function setCurrentDetailEtag(etag) {
  currentDetailEtag = etag;
}

/**
 * Clear detail state without navigating. Used by app.js delete success path.
 */
export function clearDetailState() {
  currentDetailItem = null;
  currentDetailEtag = null;
}
