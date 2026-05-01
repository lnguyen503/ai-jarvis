/**
 * Calendar view dispatcher — Jarvis v1.19.0
 *
 * Refactored from monolithic calendar-view.js (commit 0c — mechanical split).
 * Sub-views extracted:
 *  - calendar-month-view.js  — month grid + shared buildItemPill
 *  - calendar-day-view.js    — day view (scaffold; hourly in commit 11)
 *  - calendar-week-view.js   — week view (scaffold; hourly in commit 11)
 *
 * This file retains: init, enter/exit, navigation, setSubview, renderCalendar
 * dispatcher, handleCalendarDnD, cross-month conflict banner, state exports.
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *  - No native confirm().
 *
 * Calendar-date semantics (ADR 015 D3): see dates.js top-of-file JSDoc.
 * `due: 'YYYY-MM-DD'` always renders on that calendar date regardless of
 * user timezone. UTC math throughout.
 *
 * 412 conflict handling (R6):
 *  - Cross-month 412: show banner with item title + "View item" action.
 *  - "View item" navigates to the month containing the server's current due date.
 *  - Cell pulse-highlight for 2 seconds.
 *
 * ES module; no framework; no bundler; no new npm deps.
 */

import { parseISO, formatISO, addDays, addMonths, firstOfMonth,
         weekStart, isSameDay, today, formatMonthLabel, monthGrid } from './dates.js';
import { renderMonth, setMonthViewCallbacks } from './calendar-month-view.js';
import { renderDay } from './calendar-day-view.js';
import { renderWeek } from './calendar-week-view.js';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------
const IF_MATCH_HEADER = 'If-Match';
const ETAG_HEADER = 'ETag';
const TOAST_DEFAULT_MS = 3000;
/** ADR 015 D5.a — Monday as first day of week; also used by sub-view modules. */
const FIRST_DAY_OF_WEEK = 1; // Monday (ADR 015 D5.a)
const CALENDAR_SUBVIEW_KEY = 'organize-calendar-subview-v1';

// v1.19.0 D3 + D19 + D20 — drag-reschedule with debounce + undo (commit 13)
/** 300ms client-side debounce per-item before PATCH (D20). */
const DND_DEBOUNCE_MS = 300;
/** Undo toast window in ms (D19). */
const DND_UNDO_TOAST_MS = 5000;

// ------------------------------------------------------------------
// Module state
// ------------------------------------------------------------------

/** Anchor date for the current view (UTC midnight). */
let _currentDate = today();

/** Current subview: 'month' | 'week' | 'day' */
let _currentSubview = 'month';

// Injected from app.js
let _getInitData = null;
let _getRenderedItems = null;
let _onPatchSuccess = null;
let _showToast = null;
let _broadcastMutation = null;
let _container = null;
let _conflictBannerEl = null;

// DnD state
let _dragItemId = null;

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

/**
 * Initialize calendar view with DOM refs and callbacks.
 *
 * @param {HTMLElement} container
 * @param {HTMLElement} conflictBannerEl
 * @param {object} cbs
 */
export function initCalendarView(container, conflictBannerEl, cbs) {
  _container = container;
  _conflictBannerEl = conflictBannerEl;
  _getInitData = cbs.getInitData;
  _getRenderedItems = cbs.getRenderedItems;
  _onPatchSuccess = cbs.onPatchSuccess;
  _showToast = cbs.showToast;
  _broadcastMutation = cbs.broadcastMutation;

  // Wire month view's DnD callback via the callback getter pattern
  setMonthViewCallbacks(() => handleCalendarDnD);

  // Load persisted subview
  loadSubviewState();
}

// ------------------------------------------------------------------
// Subview state persistence
// ------------------------------------------------------------------

function loadSubviewState() {
  let raw = null;
  try { raw = sessionStorage.getItem(CALENDAR_SUBVIEW_KEY); } catch (_) { /* private mode */ }
  // Strict-equal whitelist (same posture as R7 for view-switcher)
  if (raw === 'month' || raw === 'week' || raw === 'day') {
    _currentSubview = raw;
  } else {
    _currentSubview = 'month';
  }
}

function saveSubviewState(sv) {
  if (sv !== 'month' && sv !== 'week' && sv !== 'day') return;
  try { sessionStorage.setItem(CALENDAR_SUBVIEW_KEY, sv); } catch (_) { /* private mode */ }
}

// ------------------------------------------------------------------
// Enter / exit view
// ------------------------------------------------------------------

export function enterCalendarView() {
  if (_container) _container.hidden = false;
  loadSubviewState();
}

export function exitCalendarView() {
  if (_container) _container.hidden = true;
  hideBanner();
}

// ------------------------------------------------------------------
// Navigation
// ------------------------------------------------------------------

export function navPrev() {
  if (_currentSubview === 'month') {
    _currentDate = addMonths(_currentDate, -1);
  } else if (_currentSubview === 'week') {
    _currentDate = addDays(_currentDate, -7);
  } else {
    _currentDate = addDays(_currentDate, -1);
  }
  renderCalendar(_getRenderedItems ? _getRenderedItems() : []);
}

export function navNext() {
  if (_currentSubview === 'month') {
    _currentDate = addMonths(_currentDate, 1);
  } else if (_currentSubview === 'week') {
    _currentDate = addDays(_currentDate, 7);
  } else {
    _currentDate = addDays(_currentDate, 1);
  }
  renderCalendar(_getRenderedItems ? _getRenderedItems() : []);
}

export function navToday() {
  _currentDate = today();
  renderCalendar(_getRenderedItems ? _getRenderedItems() : []);
}

export function setSubview(sv) {
  if (sv !== 'month' && sv !== 'week' && sv !== 'day') return;
  _currentSubview = sv;
  saveSubviewState(sv);
  renderCalendar(_getRenderedItems ? _getRenderedItems() : []);
}

/** Set the calendar to a specific month (used by R6 cross-month conflict recovery). */
export function setCalendarMonth(d) {
  _currentDate = firstOfMonth(d);
  renderCalendar(_getRenderedItems ? _getRenderedItems() : []);
}

// ------------------------------------------------------------------
// Main render entry point (dispatcher)
// ------------------------------------------------------------------

/**
 * Render the calendar for the current subview and date.
 * Only items with a valid `due` date are rendered (others filtered out).
 *
 * @param {object[]} items
 */
export function renderCalendar(items) {
  if (!_container) return;

  // Filter: only items with a valid due date
  const dated = items.filter((i) => i.due && parseISO(i.due));

  // Update subview chip active state
  if (_container) {
    _container.querySelectorAll('[data-calendar-subview]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.calendarSubview === _currentSubview);
    });
  }

  // Update nav header
  const headerEl = _container.querySelector('.calendar-month-label');
  if (headerEl) {
    const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    headerEl.textContent = formatMonthLabel(_currentDate, locale);
  }

  // Render the appropriate subview
  const boardEl = _container.querySelector('.calendar-board');
  if (!boardEl) return;
  boardEl.innerHTML = '';

  if (_currentSubview === 'month') {
    renderMonth(boardEl, dated, _currentDate);
  } else if (_currentSubview === 'week') {
    renderWeek(boardEl, dated, _currentDate, handleCalendarDnD);
  } else {
    renderDay(boardEl, dated, _currentDate, handleCalendarDnD);
  }
}

// ------------------------------------------------------------------
// Drag-to-reschedule with debounce + undo (D3 + D19 + D20 — commit 13)
// Reuses kanban-view.js DnD pattern (see kanban-view.js handleDrop):
//   optimistic UI → debounced PATCH → undo toast → rollback on error.
// ------------------------------------------------------------------

/**
 * Per-item debounce map: itemId → { timer, newDate, oldIso, etag, localItem }.
 * D20: 300ms debounce; last drop wins. Map cleared on flush.
 *
 * @type {Map<string, {timer: number, newIso: string, oldIso: string, etag: string|null, localItem: object}>}
 */
const _dndDebounceMap = new Map();

/**
 * Handle a calendar DnD drop — reschedule with optimistic UI + debounce + undo.
 *
 * Reuses the kanban-view.js DnD pattern (documented per ADR 019-revisions RA1):
 *   1. Optimistic: update item locally via _onPatchSuccess immediately.
 *   2. 300ms debounce per item (D20): last drop wins for rapid re-drops.
 *   3. On 200: keep optimistic state + show "Moved. Undo." toast with 5s window (D19).
 *   4. Undo: PATCH back to oldIso.
 *   5. On 4xx/5xx/network error: rollback optimistic state, show error toast.
 *
 * @param {string} itemId
 * @param {Date} newDate  — UTC Date for the target day
 */
export async function handleCalendarDnD(itemId, newDate) {
  const initData = _getInitData ? _getInitData() : '';
  const items = _getRenderedItems ? _getRenderedItems() : [];
  const localItem = items.find((i) => i.id === itemId);
  if (!localItem) return;
  const newIso = formatISO(newDate);
  const oldIso = localItem.due || null;
  // Drop on same day = no-op (D6: avoids spurious ETag bumps)
  if (newIso === oldIso) return;
  const etag = localItem.etag || localItem._etag || null;
  // Optimistic update (kanban-view.js DnD pattern reuse)
  if (_onPatchSuccess) _onPatchSuccess(itemId, { ...localItem, due: newIso }, etag, { optimistic: true });
  // D20: debounce — cancel pending, last drop wins
  const pending = _dndDebounceMap.get(itemId);
  if (pending) clearTimeout(pending.timer);
  await new Promise((resolve) => {
    const timer = setTimeout(async () => {
      _dndDebounceMap.delete(itemId);
      const headers = { 'Authorization': `tma ${initData}`, 'Content-Type': 'application/json' };
      if (etag) headers[IF_MATCH_HEADER] = etag;
      try {
        const res = await fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ due: newIso }),
        });
        const data = await res.json();
        if (res.status === 200 && data.ok === true) {
          const newEtag = res.headers.get(ETAG_HEADER);
          if (_broadcastMutation) _broadcastMutation({ kind: 'patch', itemId, newEtag: newEtag || null });
          if (_onPatchSuccess) _onPatchSuccess(itemId, data.item || { ...localItem, due: newIso }, newEtag || null, { optimistic: false });
          _showDndUndoToast(itemId, newIso, oldIso, newEtag || etag, data.item || { ...localItem, due: newIso });
        } else if (res.status === 412 && data.code === 'PRECONDITION_FAILED') {
          showCalendarConflictBanner(data.currentItem || localItem, oldIso); // R6
          if (_onPatchSuccess) _onPatchSuccess(itemId, localItem, etag, { optimistic: false, rollback: true });
        } else {
          if (_showToast) _showToast(`Reschedule failed: ${data.error || `Error ${res.status}`}`, TOAST_DEFAULT_MS);
          if (_onPatchSuccess) _onPatchSuccess(itemId, localItem, etag, { optimistic: false, rollback: true });
        }
      } catch (err) {
        if (_showToast) _showToast(`Reschedule failed: ${err.message}`, TOAST_DEFAULT_MS);
        if (_onPatchSuccess) _onPatchSuccess(itemId, localItem, etag, { optimistic: false, rollback: true });
      }
      resolve(undefined);
    }, DND_DEBOUNCE_MS);
    _dndDebounceMap.set(itemId, { timer, newIso, oldIso, etag, localItem });
  });
}

/**
 * Show "Moved to <date>. Undo." toast with 5-second undo action (D19).
 *
 * @param {string} itemId
 * @param {string} newIso
 * @param {string|null} oldIso
 * @param {string|null} currentEtag
 * @param {object} movedItem
 */
function _showDndUndoToast(itemId, newIso, oldIso, currentEtag, movedItem) {
  if (!_showToast || !oldIso) return;

  // Build toast message with undo button (using textContent-only pattern)
  const undoKey = `dnd-undo-${itemId}`;

  // Check if _showToast supports action buttons (some implementations do, some don't)
  // Fallback: use plain text if no button support; app.js showToast signature is
  //   (message, durationMs, actionLabel?, actionCallback?) per v1.14.2+ RA1 note
  _showToast(
    `Moved to ${newIso}. Tap to undo.`,
    DND_UNDO_TOAST_MS,
    'Undo',
    () => {
      void _executeDndUndo(itemId, newIso, oldIso, currentEtag, movedItem);
    },
  );
}

/**
 * Execute the undo PATCH (move back to oldIso).
 *
 * @param {string} itemId
 * @param {string} _newIso  — unused; kept for signature clarity
 * @param {string} oldIso
 * @param {string|null} currentEtag
 * @param {object} movedItem
 */
async function _executeDndUndo(itemId, _newIso, oldIso, currentEtag, movedItem) {
  const initData = _getInitData ? _getInitData() : '';

  const headers = {
    'Authorization': `tma ${initData}`,
    'Content-Type': 'application/json',
  };
  if (currentEtag) headers[IF_MATCH_HEADER] = currentEtag;

  try {
    const res = await fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ due: oldIso }),
    });
    const data = await res.json();

    if (res.status === 200 && data.ok === true) {
      const newEtag = res.headers.get(ETAG_HEADER);
      if (_broadcastMutation) _broadcastMutation({ kind: 'patch', itemId, newEtag: newEtag || null });
      if (_onPatchSuccess) _onPatchSuccess(itemId, data.item || { ...movedItem, due: oldIso }, newEtag || null, { optimistic: false });
      if (_showToast) _showToast('Undone.', TOAST_DEFAULT_MS);
    } else {
      const msg = data.error || `Error ${res.status}`;
      if (_showToast) _showToast(`Undo failed: ${msg}`, TOAST_DEFAULT_MS);
    }
  } catch (err) {
    if (_showToast) _showToast(`Undo failed: ${err.message}`, TOAST_DEFAULT_MS);
  }
}

// ------------------------------------------------------------------
// Cross-month 412 conflict banner (R6)
// ------------------------------------------------------------------

/**
 * Show the calendar conflict banner with item title + "View item" action.
 * R6 binding: banner text uses item title (textContent); "View item" navigates
 * to the month containing currentItem.due and pulse-highlights the cell.
 *
 * @param {object} currentItem  — server's current item from 412 envelope
 * @param {string} originalDue  — the due date the user was on
 */
export function showCalendarConflictBanner(currentItem, originalDue) {
  if (!_conflictBannerEl) return;

  const newDue = currentItem.due || null;
  const newMonth = newDue ? parseISO(newDue) : null;
  const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const monthLabel = newMonth ? formatMonthLabel(newMonth, locale) : 'another date';

  const textEl = _conflictBannerEl.querySelector('.calendar-conflict-text');
  if (textEl) {
    // textContent — user-authored title; XSS-safe
    textEl.textContent = `'${currentItem.title || '(untitled)'}' was moved by another change to ${monthLabel}.`;
  }

  const viewBtn = _conflictBannerEl.querySelector('.calendar-conflict-view');
  const dismissBtn = _conflictBannerEl.querySelector('.calendar-conflict-dismiss');

  if (viewBtn) {
    // Remove previous listener by cloning
    const newViewBtn = viewBtn.cloneNode(true);
    viewBtn.parentNode.replaceChild(newViewBtn, viewBtn);
    newViewBtn.addEventListener('click', () => {
      hideBanner();
      if (newMonth) {
        setCalendarMonth(newMonth);
        // Pulse-highlight the target cell after render
        setTimeout(() => {
          const cellEl = _container ? _container.querySelector(`[data-cell-date="${newDue}"]`) : null;
          if (cellEl) {
            cellEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            cellEl.classList.add('cell-highlight-pulse');
            setTimeout(() => {
              cellEl.classList.remove('cell-highlight-pulse');
            }, 2000);
          }
        }, 50);
      }
    });
  }

  if (dismissBtn) {
    const newDismissBtn = dismissBtn.cloneNode(true);
    dismissBtn.parentNode.replaceChild(newDismissBtn, dismissBtn);
    newDismissBtn.addEventListener('click', hideBanner);
  }

  _conflictBannerEl.hidden = false;
}

function hideBanner() {
  if (_conflictBannerEl) _conflictBannerEl.hidden = true;
}

// ------------------------------------------------------------------
// Expose internal state for testing
// ------------------------------------------------------------------
export function getCurrentDate() { return _currentDate; }
