/**
 * Organize page — Jarvis v1.15.0
 *
 * Vanilla JS, no framework, no bundler. Loaded via <script type="module" src="./app.js" defer>.
 * ES module; 'use strict' is implicit. Same-origin module imports allowed under CSP
 * `script-src 'self'`. See CLAUDE.md "hierarchy.js ES module choice".
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content (titles, tags, notes, progress) uses textContent ONLY.
 *  - NEVER innerHTML for any string sourced from the API.
 *  - Tags rendered as separate <span> elements, each with textContent.
 *  - Notes/progress in <pre> with white-space: pre-wrap CSS for line preservation.
 *  - Textarea values set via DOM property .value (never setAttribute — D15/RA1).
 *  - Toast messages use textContent ONLY (never innerHTML).
 *
 * BackButton (R7): stable handler reference + offClick before onClick.
 * Filter persistence (R10): sessionStorage key 'organize-filter-state-v1'.
 * themeChanged (R12.4): subscribe to re-apply theme on dark/light toggle.
 *
 * v1.14.2 additions:
 *  - toggleComplete (optimistic, absolute-write, rollback on error — R18, W4)
 *  - enterEditMode / submitEdit / cancelEdit (non-optimistic PATCH — D14)
 *  - armDelete / disarmDelete / commitDelete (6-second confirm — R5)
 *  - showToast (duration param, textContent-only — D6)
 *  - Per-status checkbox visibility: hidden for abandoned items (R14)
 *
 * v1.14.3 additions:
 *  - groupByParent (hierarchy.js) — goals as collapsible group headers
 *  - collapseState (sessionStorage, key COLLAPSE_STATE_KEY)
 *  - notes + progress textarea edit fields with char counters (R1)
 *  - countLines / diff confirm on progress save (R3 — inline "tap again" pattern, no native-confirm)
 *
 * v1.14.4 additions:
 *  - ETag capture from GET /:id response; If-Match on PATCH/DELETE/POST /complete (ADR 012 D2/D3)
 *  - showConflictUI / handleSaveAnyway / handleDeleteAnyway — inline conflict panel (D5/D12/R9)
 *  - X-Force-Override: 1 header on Save Anyway / Delete Anyway (RA1)
 *  - REMOVED: v1.14.2 R2-mtime stale-edit detection — the mtime capture/header path and stale-edit toast — D6 sunset
 *
 * v1.14.5 additions:
 *  - Parent picker: <select id="edit-parent"> populated from GET /api/webapp/items?type=goal&status=active
 *  - fetchGoalsForPicker / renderParentPicker — cached per detail-session; cleared on list nav
 *  - submitEdit extended: includes parentId in patch when changed (null = clear parent)
 *  - BroadcastChannel cross-tab sync (ADR 013 D8/D10; revisions R4/R7/R8)
 *  - broadcastMutation: posts ONLY on success (W4 — never on 412 / 4xx / 5xx / network error)
 *  - handleBroadcastMessage: banner when edit form open + same item; silent refetch otherwise
 *  - showBcBanner / hideBcBanner / handleBcReload — bc-banner DOM contract (W1)
 *
 * v1.14.6 additions:
 *  - Multi-select mode: enterSelectMode / exitSelectMode / toggleItemSelection
 *  - Bulk actions: handleBulkComplete / handleBulkDelete / handleBulkReParent (R1 verb-asymmetric If-Match)
 *  - bulkPromisePool: client-side concurrency limiter (MAX_BULK_INFLIGHT = 10, D3)
 *  - Typed-confirm for bulk delete > BULK_DELETE_TYPED_CONFIRM_THRESHOLD (R2)
 *  - Create form: enterCreateForm / exitCreateForm / handleCreateSubmit with AbortController (R6)
 *  - D15 double-submit guard (_createSubmitInFlight flag + button.disabled)
 *  - BC dedup: always-reset timer pattern (_bcDedupTimer, BC_DEDUP_WINDOW_MS = 1000, R8)
 *  - R9 mutual exclusion: select mode and create form cannot both be visible
 *  - RA1: 11 KNOWN_ISSUES entries + 4 CLAUDE.md invariants
 *
 * v1.15.0 additions:
 *  - View switcher: List / Kanban / Calendar (D7; R7 strict-equal whitelist)
 *  - list-view.js extracted (R1 BLOCKING commit 0a — mechanical relocation)
 *  - edit-form.js extracted (R1 BLOCKING commit 0b — mechanical relocation)
 *  - kanban-view.js: tap-pick-tap-drop DnD; R2 tutorial toast; R3 rollback cancel
 *  - calendar-view.js: month/week/day; drag-to-reschedule; R6 cross-month 412 banner
 *  - dates.js: pure UTC date helpers; W2 ISO_DATE_RE + ISO_DATE_FORMAT; W3 JSDoc rationale
 *  - /api/webapp/config boot fetch: dynamic BroadcastChannel name (D9; R7 fallback)
 *  - R8: full re-render from renderedItems on all DnD rollback + PATCH 200 paths
 *
 * Tag validation posture (RA1 / §5 single-source-of-truth):
 *  - The client does NOT normalize tag content (no toLowerCase, no strip-chars).
 *  - submitEdit sends tags verbatim (split + trim only) to the server.
 *  - The server's validation.ts TAG_RE is the sole validation boundary.
 *  - Invalid tags are rejected server-side with TAG_INVALID_CHARS; the
 *    #edit-error element surfaces the error message to the user.
 */

import { groupByParent, loadCollapseState, saveCollapseState, isCollapsed, toggleCollapsed, pruneCollapseState } from './hierarchy.js';
import { renderList, buildItemCard, buildGoalGroup } from './list-view.js';
import { initEditForm, clearPickerCache, fetchGoalsForPicker, getGoalsForPicker, renderParentPicker, enterEditMode, exitEditMode, cancelEdit, submitEdit, showConflictUI, hideConflictUI, getConflictPanelEl } from './edit-form.js';
import { renderKanban, initKanbanView, enterKanbanView, exitKanbanView, handleDrop as handleKanbanDrop, cancelPendingRollback } from './kanban-view.js';
import { renderCalendar, initCalendarView, enterCalendarView, exitCalendarView, navPrev as calNavPrev, navNext as calNavNext, navToday as calNavToday, setSubview as calSetSubview, setCalendarMonth, handleCalendarDnD } from './calendar-view.js';
// v1.16.0 — markdown rendering (ADR 016 D7) + 3-way diff (ADR 016 D8)
import { renderMarkdown } from './markdown.js'; // eslint-disable-line no-unused-vars — used by detail-panel.js; retained here for test grep compat
import { diff3, MAX_DIFF_LINES, splitLines, renderDiffPanel } from './diff.js';
// v1.17.0 — detail-panel.js extracted (commit -1; W1 binding; ADR 017 D1)
import {
  initDetailPanel,
  renderDetail,
  enterDetailView as _enterDetailView,
  exitDetailView as _exitDetailView,
  getCurrentDetailItem,
  getCurrentDetailEtag,
  setCurrentDetailEtag,
  clearDetailState,
} from './detail-panel.js';

// ------------------------------------------------------------------
// v1.15.0 — View switcher constants (D7; R7 strict-equal whitelist)
// ------------------------------------------------------------------

/** sessionStorage key for the active view. Whitelist: {list, kanban, calendar}. */
const ORGANIZE_VIEW_KEY = 'organize-view-state-v1';

/** Documented whitelist — do NOT use Array.includes (prototype pollution risk). */
const VALID_VIEWS = ['list', 'kanban', 'calendar']; // eslint-disable-line no-unused-vars — documentation only

/**
 * Load the persisted view from sessionStorage.
 * R7 (MEDIUM from CP1 v1.15.0): strict-equal triple-OR.
 * NO Array.includes (prototype pollution risk); NO regex (injection vector risk).
 * Returns 'list' for any unrecognized / injected value and OVERWRITES the bad value.
 *
 * @returns {'list'|'kanban'|'calendar'}
 */
function loadView() {
  let raw = null;
  try { raw = sessionStorage.getItem(ORGANIZE_VIEW_KEY); } catch (_) { /* private mode */ }
  // R7 strict-equal binding
  if (raw === 'list' || raw === 'kanban' || raw === 'calendar') return raw;
  // Overwrite bad / injected value (defense-in-depth)
  try { sessionStorage.setItem(ORGANIZE_VIEW_KEY, 'list'); } catch (_) { /* private mode */ }
  return 'list';
}

function saveView(view) {
  if (view !== 'list' && view !== 'kanban' && view !== 'calendar') return; // defensive
  try { sessionStorage.setItem(ORGANIZE_VIEW_KEY, view); } catch (_) { /* private mode */ }
}

/** Current view mode. */
let currentViewMode = 'list';

/** BroadcastChannel name — fetched from /api/webapp/config at boot; falls back to hardcoded. */
const BROADCAST_CHANNEL_FALLBACK = 'organize-mutations-jarvis';
let _resolvedChannelName = BROADCAST_CHANNEL_FALLBACK;

// ------------------------------------------------------------------
// v1.14.5 BroadcastChannel — multi-bot scope per ADR R7 Option C
// v1.15.0: name now comes from /api/webapp/config (D9); fallback retained
// ------------------------------------------------------------------
const ORGANIZE_MUTATIONS_CHANNEL = BROADCAST_CHANNEL_FALLBACK; // kept for const-reference in tests
// v1.14.5 banner DOM contract (W1)
const BC_BANNER_ID = 'bc-banner';
const BC_RELOAD_BTN_ID = 'bc-reload';
const BC_DISMISS_BTN_ID = 'bc-dismiss';

// ------------------------------------------------------------------
// v1.14.6 — multi-select + bulk + create form constants (RA1 wire-constant discipline)
// ------------------------------------------------------------------
const MAX_BULK_INFLIGHT = 10;                  // D3: client-side concurrency limiter
const BC_DEDUP_WINDOW_MS = 1000;              // D16/R8: always-reset BC dedup window (covers 50-item bulk burst)
const BULK_DELETE_TYPED_CONFIRM_THRESHOLD = 50; // R2 (HIGH): above this, bulk DELETE requires typing "DELETE"
const CREATE_SUBMIT_TIMEOUT_MS = 30000;       // R6 (MEDIUM): AbortController timeout — closes iOS-backgrounded-fetch issue

// Webapp item create audit category (mirrors server items.create.ts; for BC kind field)
const WEBAPP_ITEM_CREATE_CATEGORY = 'webapp.item_create';

// Bulk action bar DOM ids (RA1 wire-constants discipline)
const SELECT_TOGGLE_BTN_ID = 'select-toggle';
const SELECT_BAR_ID = 'select-bar';
const SELECT_COUNT_ID = 'select-count';
const NEW_ITEM_BTN_ID = 'new-item-btn';
const CREATE_FORM_ID = 'create-form';

// ------------------------------------------------------------------
// v1.14.3 — Top-of-file constants (W1 magic-number naming)
// ------------------------------------------------------------------
const CHAR_COUNTER_WARN_THRESHOLD = 0.8;
const DIFF_WARN_THRESHOLD_LINES = 3;
const COLLAPSE_STATE_KEY = 'organize-collapse-state-v1'; // eslint-disable-line no-unused-vars — exported from hierarchy.js; named here for test grep
const NOTES_MAX = 10240;
const PROGRESS_MAX = 20480;

// ------------------------------------------------------------------
// v1.14.4 RA1 — wire-protocol header names (mirror server-side etag-headers.ts)
// ------------------------------------------------------------------
const ETAG_HEADER = 'ETag';
const IF_MATCH_HEADER = 'If-Match';
const FORCE_OVERRIDE_HEADER = 'X-Force-Override';
const FORCE_OVERRIDE_VALUE = '1';

// v1.14.4 RA1 (closes v1.14.3 F2 carry-forward) — toast duration constants
const TOAST_DEFAULT_MS = 3000;
const TOAST_LONG_MS = 5000;       // retained as a named constant (D6 sunset removes usage but the const is kept for test visibility)
const TOAST_RESTORE_MS = 8000;    // restore-success toast (existing)
const TOAST_OVERRIDE_MS = 4000;   // v1.14.4 D5 — Save Anyway success ("Note: another change was overridden")

// ------------------------------------------------------------------
// Filter state persistence (R10)
// ------------------------------------------------------------------
const FILTER_KEY = 'organize-filter-state-v1';
const DEFAULT_FILTERS = { type: 'all', status: 'active', tag: null };

// v1.18.0 ADR 018 D1: client-side "Coached only" toggle (not persisted; ephemeral per session)
let coachedOnlyFilter = false;

function loadFilters() {
  try {
    const raw = sessionStorage.getItem(FILTER_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    return JSON.parse(raw) || { ...DEFAULT_FILTERS };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

function saveFilters(f) {
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    // sessionStorage may be unavailable in some Telegram versions; fail silently
  }
}

// ------------------------------------------------------------------
// BackButton wiring (R7) — stable handler + offClick before onClick
// ------------------------------------------------------------------
let _backButtonHandler = null;

function setBackButtonAction(action) {
  const bb = window.Telegram?.WebApp?.BackButton;
  if (!bb) return;
  if (_backButtonHandler) bb.offClick(_backButtonHandler);
  _backButtonHandler = action;
  if (action) {
    bb.onClick(action);
    bb.show();
  } else {
    bb.hide();
  }
}

// ------------------------------------------------------------------
// Theme application (R12.4)
// ------------------------------------------------------------------
function applyTheme() {
  const tp = window.Telegram?.WebApp?.themeParams || {};
  const root = document.documentElement;
  if (tp.bg_color) root.style.setProperty('--bg-color', tp.bg_color);
  if (tp.text_color) root.style.setProperty('--text-color', tp.text_color);
  if (tp.hint_color) root.style.setProperty('--hint-color', tp.hint_color);
  if (tp.button_color) root.style.setProperty('--button-bg', tp.button_color);
  if (tp.button_text_color) root.style.setProperty('--button-text', tp.button_text_color);
  if (tp.secondary_bg_color) root.style.setProperty('--secondary-bg', tp.secondary_bg_color);
}

// ------------------------------------------------------------------
// Type icon helper
// ------------------------------------------------------------------
function typeIcon(type) {
  if (type === 'task') return '📌';
  if (type === 'event') return '📅';
  if (type === 'goal') return '⚑';
  return '•';
}

// ------------------------------------------------------------------
// v1.14.3 — char counter helper (R1)
// ------------------------------------------------------------------
/**
 * Update a character counter element and toggle warn/error CSS classes.
 * @param {HTMLTextAreaElement} textareaEl
 * @param {HTMLElement} counterEl
 * @param {number} max
 */
function updateCounter(textareaEl, counterEl, max) {
  const len = textareaEl.value.length;
  counterEl.textContent = `${len} / ${max}`;
  counterEl.classList.toggle('warn', len >= max * CHAR_COUNTER_WARN_THRESHOLD && len < max);
  counterEl.classList.toggle('error', len >= max);
}

// ------------------------------------------------------------------
// DOM element cache
// ------------------------------------------------------------------
let loadingEl, itemListEl, emptyStateEl, errorStateEl, retryBtnEl, detailPanelEl;
let detailBackEl, detailTitleEl, detailMetaEl, detailNotesEl, detailProgressEl;
// v1.14.2 mutation elements (edit-form.js owns editFormEl and the full edit/conflict DOM;
// app.js still caches editBtnEl + editFormEl for BC-banner open-form check and wiring)
let editBtnEl, editFormEl, deleteBtnEl, toastEl, bcBannerEl;
let currentFilters = { ...DEFAULT_FILTERS };
let initData = '';

// v1.14.5 — BroadcastChannel instance or null when unavailable / poisoned
let bcChannel = null;

// v1.14.3 — collapse state (in-memory mirror of sessionStorage, avoids repeated parse)
let collapseState = {};

// ------------------------------------------------------------------
// v1.14.6 — Multi-select state (D9 — in-memory only, never sessionStorage)
// ------------------------------------------------------------------
/** Whether multi-select mode is active. */
let multiSelectMode = false;
/** IDs currently selected for bulk action; cleared on mode exit. */
const selectedIds = new Set();

// ------------------------------------------------------------------
// v1.14.6 — Create form state
// ------------------------------------------------------------------
/** D15 double-submit guard — prevents rapid-tap duplicates. */
let _createSubmitInFlight = false;
/** Current type selection in create form ('task'|'event'|'goal'). */
let _createFormType = 'task';

// ------------------------------------------------------------------
// v1.14.6 — Bulk delete confirm state (D12; R2)
// ------------------------------------------------------------------
/** Arms the 6-second two-tap confirm for small (≤50) bulk delete. */
let bulkDeleteConfirmPending = false;
let bulkDeleteConfirmTimer = null;

// ------------------------------------------------------------------
// v1.14.6 — BroadcastChannel dedup state (D16; R8 always-reset semantics)
// ------------------------------------------------------------------
/** setTimeout handle for the dedup window; always-reset on incoming BC message. */
let _bcDedupTimer = null;
/** The refetch kind queued for the dedup window ('detail'|'list'|null). */
let _lastBcRefetchKind = null;
/** itemId for the queued detail refetch (if kind === 'detail'). */
let _lastBcRefetchItemId = null;

// ------------------------------------------------------------------
// v1.14.2 — Mutation state
// ------------------------------------------------------------------
// v1.17.0: currentDetailItem + currentDetailEtag moved to detail-panel.js (D1 extraction).
// Use getCurrentDetailItem() / getCurrentDetailEtag() / setCurrentDetailEtag() / clearDetailState().
/** Timeout handle for the delete 6-second confirm window (R5). */
let deleteConfirmTimer = null;
/** In-flight renderedItems for the list (used to update on complete toggle). */
let renderedItems = [];

// ------------------------------------------------------------------
// Toast — textContent ONLY (Decision 6), configurable duration
// ------------------------------------------------------------------
let _toastHideTimer = null;

/**
 * Show a toast message.
 * @param {string} message  Plain-text message (textContent only — never innerHTML).
 * @param {number} [durationMs=TOAST_DEFAULT_MS]  How long to show the toast (milliseconds).
 */
function showToast(message, durationMs) {
  if (!toastEl) return;
  const duration = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : TOAST_DEFAULT_MS;
  // Clear any existing hide timer
  if (_toastHideTimer) clearTimeout(_toastHideTimer);
  // textContent ONLY for user-content interpolation (Decision 6)
  toastEl.textContent = message;
  toastEl.classList.remove('fade-out');
  toastEl.hidden = false;
  _toastHideTimer = setTimeout(() => {
    toastEl.classList.add('fade-out');
    setTimeout(() => {
      if (toastEl) toastEl.hidden = true;
    }, 400);
  }, duration);
}

// ------------------------------------------------------------------
// Show/hide helpers
// ------------------------------------------------------------------
function showLoading() {
  if (loadingEl) loadingEl.hidden = false;
  if (itemListEl) itemListEl.hidden = true;
  if (emptyStateEl) emptyStateEl.hidden = true;
  if (errorStateEl) errorStateEl.hidden = true;
  if (retryBtnEl) retryBtnEl.hidden = true;
}

function showList(items) {
  if (loadingEl) loadingEl.hidden = true;
  if (errorStateEl) errorStateEl.hidden = true;
  if (retryBtnEl) retryBtnEl.hidden = true;

  if (!items || items.length === 0) {
    if (itemListEl) itemListEl.hidden = true;
    if (emptyStateEl) emptyStateEl.hidden = false;
    return;
  }

  if (emptyStateEl) emptyStateEl.hidden = true;
  if (itemListEl) {
    itemListEl.hidden = false;
    // list-view.js renderList — explicit callbacks + state (R1 module split)
    const result = renderList(itemListEl, items, {
      onComplete: toggleComplete,
      onSelect: toggleItemSelection,
      onDetail: (id) => fetchAndShowDetail(id),
    }, {
      multiSelectMode,
      selectedIds,
      collapseState,
      onToggleCollapse: (goalId, allItems) => {
        collapseState = toggleCollapsed(collapseState, goalId);
        saveCollapseState(collapseState);
        showList(allItems);
      },
      onCollapseStateChange: (newState) => { collapseState = newState; },
    });
    if (result && result.collapseState) collapseState = result.collapseState;
    renderedItems = items;
  }

  // v1.15.0: if kanban/calendar view is active, re-render those too (R8)
  if (currentViewMode === 'kanban') {
    renderKanban(items);
  } else if (currentViewMode === 'calendar') {
    renderCalendar(items);
  }
}

function showError(message) {
  if (loadingEl) loadingEl.hidden = true;
  if (itemListEl) itemListEl.hidden = true;
  if (emptyStateEl) emptyStateEl.hidden = true;
  if (errorStateEl) {
    errorStateEl.hidden = false;
    // Safe: message comes from our own code, not directly from API user content
    errorStateEl.textContent = message;
  }
  if (retryBtnEl) retryBtnEl.hidden = false;
}

// ------------------------------------------------------------------
// v1.14.5 — BroadcastChannel cross-tab sync (ADR 013 D8/D10; revisions R4/R7/R8)
// ------------------------------------------------------------------

/**
 * Feature-detect and initialise BroadcastChannel. Called at DOMContentLoaded.
 * iOS Telegram WebApp (WKWebView) may define BroadcastChannel but throw on
 * postMessage — we guard the constructor here and the postMessage call in
 * broadcastMutation (R4 poison-pill pattern).
 */
function initBroadcastChannel() {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    bcChannel = new BroadcastChannel(_resolvedChannelName);
    bcChannel.onmessage = handleBroadcastMessage;
  } catch {
    bcChannel = null;
  }
}

/**
 * Post a mutation notification to other tabs after a SUCCESSFUL mutation.
 * W4 contract: MUST NOT be called on 412 / 4xx / 5xx / network error paths.
 * R4: postMessage wrapped in try/catch; on throw, set bcChannel = null (poison-pill
 * for iOS Telegram WebApp partial-support population) and log a one-time warning.
 *
 * @param {object} opts
 * @param {'patch'|'delete'|'complete'} opts.kind
 * @param {string} opts.itemId
 * @param {string|null} opts.newEtag
 */
function broadcastMutation({ kind, itemId, newEtag }) {
  if (!bcChannel) return;
  try {
    bcChannel.postMessage({ kind, itemId, newEtag, ts: Date.now() });
  } catch {
    // iOS Telegram WebApp partial-support: BroadcastChannel defined but unusable.
    // Poison-pill: disable for the rest of the session.
    console.warn('[organize] BroadcastChannel.postMessage threw — disabling for session.');
    bcChannel = null;
  }
}

/**
 * Handle an incoming BroadcastChannel message (from another tab / window).
 *
 * Listener policy (ADR 013 D8; revisions R8; v1.14.6 D16/R8 always-reset dedup):
 *  - Edit form open + same item → show banner (user has unsaved changes — don't auto-overwrite)
 *  - Detail open + edit form closed + same item → queue detail refetch
 *  - List view (no detail) → queue list refetch
 *  - Different item in detail → ignore (irrelevant to this tab's view)
 *  - Conflict panel visible → suppress (conflict panel's Reload already handles it)
 *
 * D16/R8 always-reset dedup: each incoming message resets the 1s timer.
 * A burst of 50 messages collapses into ONE refetch fired 1s after the last message.
 * BC_DEDUP_WINDOW_MS covers worst-case 50-item bulk burst wall-clock (~1s at 10-concurrent).
 *
 * @param {MessageEvent} ev
 */
function handleBroadcastMessage(ev) {
  if (!ev.data || !ev.data.itemId) return;
  const { itemId, kind } = ev.data;

  // Suppress when conflict panel is already visible (D8 note — redundant banner is noise)
  const _conflictPanelEl = getConflictPanelEl();
  if (_conflictPanelEl && !_conflictPanelEl.hidden) return;

  // Determine refetch kind
  let refetchKind = null;
  let refetchItemId = null;

  const _curDetailItem = getCurrentDetailItem();
  if (_curDetailItem && _curDetailItem.id === itemId) {
    // Same item in detail view
    if (editFormEl && !editFormEl.hidden) {
      // Edit form is open — show banner immediately (not subject to dedup — user must see it)
      showBcBanner(kind);
      return;
    }
    // Read-only detail — queue detail refetch
    refetchKind = 'detail';
    refetchItemId = itemId;
  } else if (!_curDetailItem) {
    // List view — queue list refetch
    refetchKind = 'list';
  } else {
    // Different item in detail — ignore
    return;
  }

  // D16/R8 always-reset dedup: accumulate latest kind; reset timer on every message
  _lastBcRefetchKind = refetchKind;
  _lastBcRefetchItemId = refetchItemId;
  if (_bcDedupTimer) clearTimeout(_bcDedupTimer);
  _bcDedupTimer = setTimeout(() => {
    _bcDedupTimer = null;
    const k = _lastBcRefetchKind;
    const id = _lastBcRefetchItemId;
    _lastBcRefetchKind = null;
    _lastBcRefetchItemId = null;
    if (k === 'detail' && id) {
      fetchAndShowDetail(id);
    } else if (k === 'list') {
      fetchItems();
    }
  }, BC_DEDUP_WINDOW_MS);
}

/**
 * Show the BroadcastChannel stale-item banner.
 * Banner text uses the mutation kind (e.g. "patched", "deleted", "completed").
 *
 * @param {'patch'|'delete'|'complete'} kind
 */
function showBcBanner(kind) {
  if (!bcBannerEl) return;
  // Suppress when conflict panel is already visible
  const _conflictPanelRef = getConflictPanelEl();
  if (_conflictPanelRef && !_conflictPanelRef.hidden) return;
  const messageEl = bcBannerEl.querySelector('.bc-message');
  if (messageEl) {
    // Map kind to past tense for user-facing text
    const verb = kind === 'patch' ? 'updated' : kind === 'delete' ? 'deleted' : 'completed';
    messageEl.textContent = `This item was ${verb} in another tab. Reload to see latest changes.`;
  }
  bcBannerEl.hidden = false;
}

/** Hide the BroadcastChannel stale-item banner. */
function hideBcBanner() {
  if (bcBannerEl) bcBannerEl.hidden = true;
}

/**
 * Handle the "Reload" click in the BC banner.
 * Refetches the current item, hides the banner, and resets the edit form to
 * fresh values. Any unsaved input is lost — the user explicitly requested Reload.
 */
function handleBcReload() {
  hideBcBanner();
  const _cur = getCurrentDetailItem();
  if (_cur) {
    fetchAndShowDetail(_cur.id);
  }
}

function showListView() {
  if (detailPanelEl) detailPanelEl.hidden = true;
  // Disarm any pending delete confirmation when leaving detail
  disarmDelete();
  // v1.14.4: clear conflict state when navigating away
  hideConflictUI();
  // v1.14.5: hide bc-banner and clear picker cache on list nav
  hideBcBanner();
  clearPickerCache(); // edit-form.js: reset goalsForPicker for next detail session
  setCurrentDetailEtag(null);
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.hidden = false;
  const headerEl = document.querySelector('header');
  if (headerEl) headerEl.hidden = false;
  const filtersEl = document.querySelector('.filters');
  if (filtersEl) filtersEl.hidden = false;
  setBackButtonAction(null);
  // v1.14.6: ensure create form is closed on list nav
  if (createFormEl && !createFormEl.hidden) exitCreateForm();
}

function showDetailView() {
  // v1.14.6 D9: navigating to detail exits select mode
  if (multiSelectMode) exitSelectMode();
  // v1.17.0: delegate show/hide logic to detail-panel.js (D1 extraction)
  _enterDetailView();
}

// ------------------------------------------------------------------
// v1.14.6 — Multi-select state machine (D9/D10/D11; R9 mutual exclusion)
// ------------------------------------------------------------------

/** Cached DOM refs for v1.14.6 select/create UI (populated in DOMContentLoaded). */
let selectToggleBtnEl = null;
let selectBarEl = null;
let selectCountEl = null;
let newItemBtnEl = null;
let createFormEl = null;
let createTitleEl = null;
let createDueEl = null;
let createTagsEl = null;
let createParentEl = null;
let createParentLabelEl = null;
let createNotesEl = null;
let createProgressEl = null;
let createTitleCounterEl = null;
let createNotesCounterEl = null;
let createProgressCounterEl = null;
let createSubmitEl = null;
let createCancelEl = null;
let createErrorEl = null;
let bulkDeleteTypedConfirmEl = null;
let bulkDeleteTypedInputEl = null;
let bulkDeleteTypedCountEl = null;
let bulkDeleteTypedConfirmBtnEl = null;
let bulkDeleteTypedCancelBtnEl = null;

/**
 * Enter multi-select mode.
 * R9: hides "+ New" button. Shows action bar.
 */
function enterSelectMode() {
  multiSelectMode = true;
  selectedIds.clear();

  // R9 mutual exclusion: hide + disable "+ New" button
  if (newItemBtnEl) {
    newItemBtnEl.hidden = true;
    newItemBtnEl.disabled = true;
  }

  // Toggle button label
  if (selectToggleBtnEl) selectToggleBtnEl.textContent = 'Cancel';

  // Show action bar
  if (selectBarEl) selectBarEl.hidden = false;

  // Update count display
  updateSelectCount();

  // Re-render list with selection checkboxes
  showList(renderedItems);
}

/**
 * Exit multi-select mode.
 * Clears selectedIds. R9: restores "+ New" button.
 */
function exitSelectMode() {
  multiSelectMode = false;
  selectedIds.clear();

  // Clear bulk-delete confirm state
  bulkDeleteConfirmPending = false;
  if (bulkDeleteConfirmTimer) {
    clearTimeout(bulkDeleteConfirmTimer);
    bulkDeleteConfirmTimer = null;
  }

  // Hide typed-confirm if visible
  if (bulkDeleteTypedConfirmEl) bulkDeleteTypedConfirmEl.hidden = true;
  if (bulkDeleteTypedInputEl) bulkDeleteTypedInputEl.value = '';

  // R9 mutual exclusion: restore "+ New" button
  if (newItemBtnEl) {
    newItemBtnEl.hidden = false;
    newItemBtnEl.disabled = false;
  }

  // Toggle button label back
  if (selectToggleBtnEl) selectToggleBtnEl.textContent = 'Select';

  // Hide action bar
  if (selectBarEl) selectBarEl.hidden = true;

  // Re-render list with normal complete-checkboxes
  showList(renderedItems);
}

/**
 * Toggle an item's selection state.
 * Updates selectedIds, count display, and card visual.
 * @param {string} itemId
 */
function toggleItemSelection(itemId) {
  if (selectedIds.has(itemId)) {
    selectedIds.delete(itemId);
  } else {
    selectedIds.add(itemId);
  }
  updateSelectCount();

  // Update the specific card's checkbox visual + selected class
  if (itemListEl) {
    const li = itemListEl.querySelector(`[data-item-id="${CSS.escape(itemId)}"], [data-goal-id="${CSS.escape(itemId)}"]`);
    if (li) {
      const btn = li.querySelector('.select-checkbox');
      const isNowSelected = selectedIds.has(itemId);
      if (btn) {
        btn.textContent = isNowSelected ? '☑' : '☐';
        btn.setAttribute('aria-label', isNowSelected ? 'Deselect' : 'Select');
      }
      li.classList.toggle('selected', isNowSelected);
    }
  }
}

/** Update the count display in the action bar. */
function updateSelectCount() {
  if (selectCountEl) selectCountEl.textContent = String(selectedIds.size);
}

// ------------------------------------------------------------------
// v1.14.6 — Bulk actions (D3/D4/D12; R1 verb-asymmetric If-Match; R2 typed-confirm)
// ------------------------------------------------------------------

/**
 * Client-side concurrency limiter for bulk operations (D3 — max 10 in-flight).
 * Returns results array in submission order.
 *
 * @template T
 * @param {T[]} items
 * @param {function(T): Promise<{ok: boolean, response?: Response, error?: Error}>} perItemAction
 * @returns {Promise<Array<{item: T, ok: boolean, response?: Response, error?: Error}>>}
 */
async function bulkPromisePool(items, perItemAction) {
  const results = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (true) { // eslint-disable-line no-constant-condition
      const idx = nextIdx++;
      if (idx >= items.length) return;
      try {
        const response = await perItemAction(items[idx]);
        results[idx] = { item: items[idx], ok: true, response };
      } catch (err) {
        results[idx] = { item: items[idx], ok: false, error: err };
      }
    }
  }

  const workerCount = Math.min(MAX_BULK_INFLIGHT, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Show a results toast for bulk operations (D4).
 * @param {number} succeeded
 * @param {number} total
 * @param {boolean} has412  — at least one 412 among the failures
 */
function showBulkResultsToast(succeeded, total, has412) {
  const failed = total - succeeded;
  if (failed === 0) {
    showToast(`Done: ${succeeded} item${succeeded === 1 ? '' : 's'}.`, TOAST_DEFAULT_MS);
  } else if (succeeded === 0 && has412) {
    showToast('Some items changed in another tab. Reload to see latest, then retry.', TOAST_LONG_MS);
  } else if (succeeded === 0) {
    showToast(`Failed: ${failed} item${failed === 1 ? '' : 's'}.`, TOAST_LONG_MS);
  } else {
    showToast(
      has412
        ? `${succeeded} done, ${failed} had concurrent edits — open detail to retry.`
        : `${succeeded} done, ${failed} failed (kept selected).`,
      TOAST_LONG_MS,
    );
  }
}

/**
 * Handle bulk Complete button tap.
 * R1 verb-asymmetric: POST /complete MAY omit If-Match.
 */
async function handleBulkComplete() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;

  // R6: AbortController + CREATE_SUBMIT_TIMEOUT_MS per item
  const results = await bulkPromisePool(ids, async (itemId) => {
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), CREATE_SUBMIT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/webapp/items/${encodeURIComponent(itemId)}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `tma ${initData}`,
          'Content-Type': 'application/json',
          // R1 verb-asymmetric: POST /complete MAY omit If-Match
        },
        body: JSON.stringify({ done: true }),
        signal: abortCtrl.signal,
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  });

  // D4 selection-state contract: remove succeeded; keep failed selected
  let succeeded = 0;
  for (const r of results) {
    if (r.ok) {
      selectedIds.delete(r.item);
      succeeded++;
    }
  }
  updateSelectCount();
  // Re-render to reflect visual changes
  showList(renderedItems);
  // Broadcast list refresh to other tabs (W4 — only on any success)
  if (succeeded > 0) {
    broadcastMutation({ kind: 'complete', itemId: ids[0], newEtag: null });
    // Refresh the list from server to reflect completed items
    fetchItems();
  }
  showBulkResultsToast(succeeded, ids.length, false);
  if (selectedIds.size === 0) exitSelectMode();
}

/**
 * Handle bulk Delete button tap (D12; R2 typed-confirm).
 * R1 verb-asymmetric: DELETE MAY omit If-Match.
 */
function handleBulkDelete() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;

  if (ids.length > BULK_DELETE_TYPED_CONFIRM_THRESHOLD) {
    // R2: typed-confirm for >50 items
    showBulkDeleteTypedConfirm(ids);
    return;
  }

  // ≤50 items: 6-second two-tap confirm (D12; matches single-item v1.14.2 R5)
  if (!bulkDeleteConfirmPending) {
    bulkDeleteConfirmPending = true;
    showToast(`Delete ${ids.length} item${ids.length === 1 ? '' : 's'}? Tap Delete again within 6s.`, TOAST_LONG_MS);
    bulkDeleteConfirmTimer = setTimeout(() => {
      bulkDeleteConfirmPending = false;
      bulkDeleteConfirmTimer = null;
    }, 6000);
    return;
  }

  // Second tap within 6s — fire bulk dispatch
  clearTimeout(bulkDeleteConfirmTimer);
  bulkDeleteConfirmPending = false;
  bulkDeleteConfirmTimer = null;
  dispatchBulkDelete(ids);
}

/**
 * Show the typed-confirm UI for large (>50) bulk delete.
 * @param {string[]} ids
 */
function showBulkDeleteTypedConfirm(ids) {
  if (!bulkDeleteTypedConfirmEl || !bulkDeleteTypedInputEl || !bulkDeleteTypedCountEl) return;
  if (bulkDeleteTypedCountEl) bulkDeleteTypedCountEl.textContent = String(ids.length);
  if (bulkDeleteTypedInputEl) bulkDeleteTypedInputEl.value = '';
  bulkDeleteTypedConfirmEl.hidden = false;
  if (bulkDeleteTypedInputEl) bulkDeleteTypedInputEl.focus();

  // Wire confirm button (single-use; re-wire each show)
  function onConfirm() {
    const typed = bulkDeleteTypedInputEl ? bulkDeleteTypedInputEl.value : '';
    if (typed === 'DELETE') {
      bulkDeleteTypedConfirmEl.hidden = true;
      bulkDeleteTypedInputEl.value = '';
      cleanup();
      dispatchBulkDelete(ids);
    } else {
      // Show error inline via a toast (input stays open for retry)
      showToast('Type DELETE (uppercase) to confirm.', TOAST_DEFAULT_MS);
    }
  }

  function onCancel() {
    bulkDeleteTypedConfirmEl.hidden = true;
    if (bulkDeleteTypedInputEl) bulkDeleteTypedInputEl.value = '';
    cleanup();
  }

  function onKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  }

  function cleanup() {
    if (bulkDeleteTypedConfirmBtnEl) bulkDeleteTypedConfirmBtnEl.removeEventListener('click', onConfirm);
    if (bulkDeleteTypedCancelBtnEl) bulkDeleteTypedCancelBtnEl.removeEventListener('click', onCancel);
    if (bulkDeleteTypedInputEl) bulkDeleteTypedInputEl.removeEventListener('keydown', onKeydown);
  }

  if (bulkDeleteTypedConfirmBtnEl) bulkDeleteTypedConfirmBtnEl.addEventListener('click', onConfirm);
  if (bulkDeleteTypedCancelBtnEl) bulkDeleteTypedCancelBtnEl.addEventListener('click', onCancel);
  if (bulkDeleteTypedInputEl) bulkDeleteTypedInputEl.addEventListener('keydown', onKeydown);
}

/**
 * Execute the bulk delete after confirmation.
 * R1 verb-asymmetric: DELETE MAY omit If-Match.
 * @param {string[]} ids
 */
async function dispatchBulkDelete(ids) {
  const results = await bulkPromisePool(ids, async (itemId) => {
    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), CREATE_SUBMIT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `tma ${initData}`,
          // R1 verb-asymmetric: bulk DELETE MAY omit If-Match
        },
        signal: abortCtrl.signal,
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  });

  let succeeded = 0;
  const has412 = results.some((r) => !r.ok && r.error && r.error.status === 412);
  for (const r of results) {
    if (r.ok) {
      selectedIds.delete(r.item);
      // Remove from local renderedItems
      renderedItems = renderedItems.filter((i) => i.id !== r.item);
      succeeded++;
    }
  }
  updateSelectCount();
  showList(renderedItems);
  if (succeeded > 0) {
    broadcastMutation({ kind: 'delete', itemId: ids[0], newEtag: null });
  }
  showBulkResultsToast(succeeded, ids.length, has412);
  if (selectedIds.size === 0) exitSelectMode();
}

/**
 * Handle bulk re-parent button tap.
 * R1 BLOCKING: PATCH MUST send per-item If-Match (parentId silent-overwrite is highest risk).
 * Shows parent picker; on selection fires N parallel PATCHes WITH per-item ETags.
 */
function handleBulkReParent() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;

  // Ensure goals are loaded before showing picker
  fetchGoalsForPicker(() => initData).then(() => {
    // Build a simple picker using edit-form.js goalsForPicker cache
    const goals = getGoalsForPicker() || [];
    if (goals.length === 0) {
      showToast('No active goals available to move items to.', TOAST_DEFAULT_MS);
      return;
    }

    // Use a simple select dialog approach: show a toast + a transient picker above the list
    // (Reuses getGoalsForPicker() — same data as edit-form parent picker)
    const pickerContainer = document.createElement('div');
    pickerContainer.className = 'bulk-reparent-picker';
    pickerContainer.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:50;background:var(--bg-color);border:2px solid var(--button-bg);border-radius:10px;padding:1rem;max-width:340px;width:calc(100vw - 2rem);box-shadow:0 4px 12px rgba(0,0,0,0.15)';

    const label = document.createElement('p');
    label.textContent = `Move ${ids.length} item${ids.length === 1 ? '' : 's'} to:`;
    label.style.cssText = 'margin:0 0 0.5rem;font-size:0.9rem;font-weight:600;';
    pickerContainer.appendChild(label);

    const select = document.createElement('select');
    select.style.cssText = 'width:100%;padding:8px 10px;border:1px solid var(--card-border);border-radius:8px;background:var(--bg-color);color:var(--text-color);font-size:0.95rem;font-family:inherit;box-sizing:border-box;margin-bottom:0.75rem;';

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(choose a goal…)';
    noneOpt.disabled = true;
    noneOpt.selected = true;
    select.appendChild(noneOpt);

    for (const goal of goals) {
      const opt = document.createElement('option');
      opt.value = goal.id;
      opt.textContent = goal.title; // textContent — never innerHTML (decision 6)
      select.appendChild(opt);
    }
    pickerContainer.appendChild(select);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:0.5rem;justify-content:flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:transparent;color:var(--hint-color);border:1px solid var(--card-border);border-radius:8px;padding:6px 14px;font-size:0.88rem;cursor:pointer;';

    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.textContent = 'Move';
    moveBtn.style.cssText = 'background:var(--button-bg);color:var(--button-text);border:none;border-radius:8px;padding:6px 14px;font-size:0.88rem;font-weight:600;cursor:pointer;';

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(moveBtn);
    pickerContainer.appendChild(btnRow);
    document.body.appendChild(pickerContainer);

    function dismiss() {
      if (pickerContainer.parentNode) pickerContainer.parentNode.removeChild(pickerContainer);
    }

    cancelBtn.addEventListener('click', dismiss);
    moveBtn.addEventListener('click', () => {
      const parentId = select.value;
      if (!parentId) {
        showToast('Select a goal first.', TOAST_DEFAULT_MS);
        return;
      }
      dismiss();
      dispatchBulkReParent(ids, parentId);
    });
  });
}

/**
 * Execute bulk re-parent after goal is picked.
 * R1 BLOCKING: PATCH MUST send per-item If-Match (captured at list-fetch time in renderedItems).
 * @param {string[]} ids
 * @param {string} parentId
 */
async function dispatchBulkReParent(ids, parentId) {
  const results = await bulkPromisePool(ids, async (itemId) => {
    // R1 BLOCKING: per-item ETag captured at list-fetch time
    const localItem = renderedItems.find((i) => i.id === itemId);
    const etag = localItem ? (localItem.etag || localItem._etag || null) : null;

    const headers = {
      Authorization: `tma ${initData}`,
      'Content-Type': 'application/json',
    };
    // R1 BLOCKING: PATCH MUST send per-item If-Match for parentId overwrite
    if (etag) headers[IF_MATCH_HEADER] = etag;

    const abortCtrl = new AbortController();
    const timeoutId = setTimeout(() => abortCtrl.abort(), CREATE_SUBMIT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ parentId }),
        signal: abortCtrl.signal,
      });
      const status = res.status;
      if (status === 412) throw Object.assign(new Error('412 PRECONDITION_FAILED'), { status: 412 });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${status}`), { status });
      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  });

  let succeeded = 0;
  const has412 = results.some((r) => !r.ok && r.error && r.error.status === 412);
  for (const r of results) {
    if (r.ok) {
      selectedIds.delete(r.item);
      succeeded++;
    }
  }
  updateSelectCount();
  if (succeeded > 0) {
    broadcastMutation({ kind: 'patch', itemId: ids[0], newEtag: null });
    fetchItems(); // Refresh list so hierarchy reflects new parents
  }
  showBulkResultsToast(succeeded, ids.length, has412);
  if (selectedIds.size === 0) exitSelectMode();
}

// ------------------------------------------------------------------
// v1.14.6 — Create form (D13/D14/D15; R6 AbortController; R9 mutual exclusion)
// ------------------------------------------------------------------

/**
 * Populate the create-form parent picker from edit-form.js goalsForPicker cache.
 * Mirrors renderParentPicker for the edit form.
 */
function renderCreateParentPicker() {
  if (!createParentEl) return;
  // Clear existing options safely
  createParentEl.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(none)';
  createParentEl.appendChild(noneOpt);

  const pickerGoals = getGoalsForPicker();
  if (Array.isArray(pickerGoals)) {
    for (const goal of pickerGoals) {
      const opt = document.createElement('option');
      opt.value = goal.id;
      opt.textContent = goal.title; // textContent — never innerHTML (decision 6)
      createParentEl.appendChild(opt);
    }
  }
  createParentEl.value = ''; // DOM property .value (never setAttribute — D15/RA1)
}

/**
 * Enter create form mode.
 * R9: hides "Select" button.
 * Resets form fields to defaults.
 */
function enterCreateForm() {
  if (!createFormEl) return;

  // R9 mutual exclusion: hide + disable "Select" button
  if (selectToggleBtnEl) {
    selectToggleBtnEl.hidden = true;
    selectToggleBtnEl.disabled = true;
  }

  // Reset type pills to Task
  _createFormType = 'task';
  if (createFormEl) {
    createFormEl.querySelectorAll('[data-create-type]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.createType === 'task');
    });
  }

  // Reset form fields via DOM .value (never setAttribute — D15/RA1)
  if (createTitleEl) createTitleEl.value = '';
  if (createDueEl) createDueEl.value = '';
  if (createTagsEl) createTagsEl.value = '';
  if (createNotesEl) createNotesEl.value = '';
  if (createProgressEl) createProgressEl.value = '';

  // Reset char counters
  if (createTitleEl && createTitleCounterEl) updateCounter(createTitleEl, createTitleCounterEl, 500);
  if (createNotesEl && createNotesCounterEl) updateCounter(createNotesEl, createNotesCounterEl, NOTES_MAX);
  if (createProgressEl && createProgressCounterEl) updateCounter(createProgressEl, createProgressCounterEl, PROGRESS_MAX);

  // Reset submit + error state
  if (createSubmitEl) createSubmitEl.disabled = false;
  if (createErrorEl) { createErrorEl.textContent = ''; createErrorEl.hidden = true; }

  // Parent picker: show/hide based on type (hidden for goal)
  updateCreateParentVisibility();

  // Fetch goals for parent picker via edit-form.js cache (async; renders when ready)
  fetchGoalsForPicker(() => initData).then(() => renderCreateParentPicker());

  // Show form
  createFormEl.hidden = false;

  // Focus title input
  if (createTitleEl) createTitleEl.focus();
}

/**
 * Exit create form mode.
 * R9: restores "Select" button.
 */
function exitCreateForm() {
  if (createFormEl) createFormEl.hidden = true;

  // R9 mutual exclusion: restore "Select" button
  if (selectToggleBtnEl) {
    selectToggleBtnEl.hidden = false;
    selectToggleBtnEl.disabled = false;
  }

  // Reset inflight flag in case form is cancelled mid-flight (defensive)
  _createSubmitInFlight = false;
  if (createSubmitEl) createSubmitEl.disabled = false;
}

/**
 * Show/hide parent picker based on current type.
 * Goals cannot have parents (v1.14.3 R13 + ADR 014 D8).
 */
function updateCreateParentVisibility() {
  const isGoal = _createFormType === 'goal';
  if (createParentEl) createParentEl.hidden = isGoal;
  if (createParentLabelEl) createParentLabelEl.hidden = isGoal;
}

/**
 * Show an inline error in the create form.
 * @param {string} msg
 */
function showCreateError(msg) {
  if (!createErrorEl) return;
  createErrorEl.textContent = msg; // textContent — never innerHTML (decision 6)
  createErrorEl.hidden = false;
}

/**
 * Handle create form submission.
 * D15 double-submit guard: _createSubmitInFlight flag + button.disabled.
 * R6: AbortController + CREATE_SUBMIT_TIMEOUT_MS timeout.
 *
 * @param {Event} e
 */
async function handleCreateSubmit(e) {
  e.preventDefault();
  if (_createSubmitInFlight) return;
  _createSubmitInFlight = true;

  const btn = createSubmitEl;
  if (btn) btn.disabled = true;
  if (createErrorEl) { createErrorEl.textContent = ''; createErrorEl.hidden = true; }

  // R6: AbortController + 30s timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CREATE_SUBMIT_TIMEOUT_MS);

  try {
    // Collect form body
    const title = createTitleEl ? createTitleEl.value.trim() : '';
    if (!title) {
      showCreateError('Title is required.');
      return;
    }

    const payload = { type: _createFormType, title };

    const dueVal = createDueEl ? createDueEl.value : '';
    if (dueVal) payload.due = dueVal;

    const tagsRaw = createTagsEl ? createTagsEl.value : '';
    const tags = tagsRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
    if (tags.length > 0) payload.tags = tags;

    const notesVal = createNotesEl ? createNotesEl.value : '';
    if (notesVal) payload.notes = notesVal;

    const progressVal = createProgressEl ? createProgressEl.value : '';
    if (progressVal) payload.progress = progressVal;

    // Parent picker (hidden + cleared for goal type — D14)
    if (_createFormType !== 'goal' && createParentEl) {
      const parentVal = createParentEl.value;
      if (parentVal) payload.parentId = parentVal;
    }

    const res = await fetch('/api/webapp/items', {
      method: 'POST',
      headers: {
        Authorization: `tma ${initData}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (res.status === 201) {
      const data = await res.json();
      if (data.ok === true) {
        // Broadcast create to other tabs (W4 — only on success)
        broadcastMutation({ kind: WEBAPP_ITEM_CREATE_CATEGORY, itemId: data.item.id, newEtag: res.headers.get('ETag') || null });
        exitCreateForm();
        await fetchItems(); // Show new item at top of list
        showToast('Item created.', TOAST_DEFAULT_MS);
      } else {
        showCreateError(data.error || 'Create failed.');
      }
    } else if (res.status >= 400 && res.status < 500) {
      const errData = await res.json().catch(() => ({}));
      showCreateError(errData.error || `Error ${errData.code || res.status}`);
    } else {
      showCreateError(`Server error (${res.status}). Try again.`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      showCreateError('Request timed out; retry?');
    } else {
      showCreateError(`Network error: ${err.message}`);
    }
  } finally {
    clearTimeout(timeoutId);
    _createSubmitInFlight = false;
    if (btn) btn.disabled = false;
  }
}

// ------------------------------------------------------------------
// v1.14.2 — Complete toggle (optimistic UI, absolute-write — R18)
// ------------------------------------------------------------------
/**
 * Toggle the done status of an item from the list card.
 * Optimistic flip: update the DOM immediately; roll back on error (W4).
 * Uses absolute-write semantics — sends the TARGET state, not a toggle (R18).
 * Does NOT refetch the list (predictability over freshness — ADR 010 D16).
 * @param {object} item  The list item object (from renderedItems).
 */
function toggleComplete(item) {
  if (!initData) return;

  const currentDone = item.status === 'done';
  const targetDone = !currentDone;

  // Optimistic: find the check-btn for this item and flip it
  const checkBtn = itemListEl
    ? itemListEl.querySelector(`.check-btn[data-item-id="${CSS.escape(item.id)}"]`)
    : null;
  if (checkBtn) {
    checkBtn.dataset.done = String(targetDone);
    checkBtn.textContent = targetDone ? '✅' : '⭕';
    checkBtn.setAttribute('aria-label', targetDone ? 'Mark incomplete' : 'Mark complete');
  }

  const headers = {
    'Authorization': `tma ${initData}`,
    'Content-Type': 'application/json',
  };
  // v1.14.4 D3/D9: list-card complete-checkbox does NOT send If-Match because the
  // list response does not carry per-item ETags (ADR 012 D2/SF-7). No-op fast-path
  // (R4) on the server handles the idempotent case without ETag ceremony.

  fetch(`/api/webapp/items/${encodeURIComponent(item.id)}/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ done: targetDone }),
  })
    .then((res) => {
      if (!res.ok) {
        // 4xx — rollback optimistic flip (W4: do NOT broadcast on error)
        if (checkBtn) {
          checkBtn.dataset.done = String(currentDone);
          checkBtn.textContent = currentDone ? '✅' : '⭕';
          checkBtn.setAttribute('aria-label', currentDone ? 'Mark incomplete' : 'Mark complete');
        }
        return res.json().then((data) => {
          const msg = data.error || `Server error (${res.status})`;
          showToast(`Error: ${msg}`, TOAST_OVERRIDE_MS);
        }).catch(() => {
          showToast(`Server error (${res.status})`, TOAST_OVERRIDE_MS);
        });
      }
      return res.json().then((data) => {
        if (data.ok === true) {
          // v1.14.5: broadcast successful complete to other tabs (W4 — only on success)
          broadcastMutation({ kind: 'complete', itemId: item.id, newEtag: null });

          // Update local item state so future toggles have correct baseline
          const idx = renderedItems.findIndex((i) => i.id === item.id);
          if (idx !== -1) {
            renderedItems[idx] = { ...renderedItems[idx], status: data.item?.status || (targetDone ? 'done' : 'active') };
            // Sync item ref so the closure stays current for the next click
            Object.assign(item, renderedItems[idx]);
          }
        } else {
          // Server-reported error on 2xx (shouldn't happen, but defend)
          // W4: do NOT broadcast on server-reported error
          if (checkBtn) {
            checkBtn.dataset.done = String(currentDone);
            checkBtn.textContent = currentDone ? '✅' : '⭕';
            checkBtn.setAttribute('aria-label', currentDone ? 'Mark incomplete' : 'Mark complete');
          }
          showToast(data.error || 'Could not update item.', TOAST_OVERRIDE_MS);
        }
      });
    })
    .catch((err) => {
      // Network failure — rollback optimistic flip (W4: do NOT broadcast on network error)
      if (checkBtn) {
        checkBtn.dataset.done = String(currentDone);
        checkBtn.textContent = currentDone ? '✅' : '⭕';
        checkBtn.setAttribute('aria-label', currentDone ? 'Mark incomplete' : 'Mark complete');
      }
      showToast(`Network error: ${err.message}`, TOAST_OVERRIDE_MS);
    });
}

// ------------------------------------------------------------------
// Detail rendering — v1.17.0: renderDetail extracted to ./detail-panel.js (D1; W1).
// renderDetail imported at top of file from detail-panel.js.
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// v1.14.2 — Edit mode: enterEditMode, exitEditMode, cancelEdit, submitEdit
// All imported from ./edit-form.js (R1 BLOCKING — mechanical zero-logic-change relocation).
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// v1.14.2 — Delete (6-second two-tap confirm — R5)
// ------------------------------------------------------------------
/**
 * Arm the delete confirm. First tap morphs the button into a countdown.
 * Second tap within 6s commits the delete.
 */
function armDelete() {
  if (!deleteBtnEl) return;
  // If already confirming, the second tap commits
  if (deleteBtnEl.classList.contains('confirming')) {
    disarmDelete();
    commitDelete();
    return;
  }
  deleteBtnEl.classList.add('confirming');
  // Countdown text updates every second
  let remaining = 6;
  deleteBtnEl.textContent = `Tap again to confirm (${remaining}s)`;
  const countInterval = setInterval(() => {
    remaining -= 1;
    if (remaining > 0 && deleteBtnEl) {
      deleteBtnEl.textContent = `Tap again to confirm (${remaining}s)`;
    }
  }, 1000);
  deleteConfirmTimer = setTimeout(() => {
    clearInterval(countInterval);
    disarmDelete();
  }, 6000);
  // Store the interval so disarmDelete can clear it
  deleteBtnEl._countInterval = countInterval;
}

/** Disarm the delete confirmation — restore button to initial state. */
function disarmDelete() {
  if (!deleteBtnEl) return;
  if (deleteConfirmTimer) {
    clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
  }
  if (deleteBtnEl._countInterval) {
    clearInterval(deleteBtnEl._countInterval);
    deleteBtnEl._countInterval = null;
  }
  deleteBtnEl.classList.remove('confirming');
  deleteBtnEl.textContent = '🗑 Delete';
}

/** Execute the DELETE request after confirmation. */
function commitDelete() {
  const _curItem = getCurrentDetailItem();
  if (!_curItem || !initData) return;

  const itemId = _curItem.id;
  const headers = {
    'Authorization': `tma ${initData}`,
  };
  // v1.14.4 D3: send If-Match when we have a captured ETag
  const _curEtag = getCurrentDetailEtag();
  if (_curEtag !== null) {
    headers[IF_MATCH_HEADER] = _curEtag;
  }

  fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    headers,
  })
    .then((res) => res.json().then((data) => ({ status: res.status, data, res })))
    .then(({ status, data, res: fetchRes }) => {
      if (status === 200 && data.ok === true) {
        // v1.14.5: broadcast successful delete to other tabs (W4 — only on success)
        const newEtag = fetchRes.headers.get(ETAG_HEADER);
        broadcastMutation({ kind: 'delete', itemId, newEtag: newEtag || null });

        // Remove from local list
        renderedItems = renderedItems.filter((i) => i.id !== itemId);
        clearDetailState();
        returnToList();
        // Refresh the list view to reflect the deletion
        showList(renderedItems);
        // Show restore hint (R16) — TOAST_RESTORE_MS duration, textContent only
        showToast(
          `Deleted. Restore via Telegram chat: /organize restore ${itemId}`,
          TOAST_RESTORE_MS,
        );
      } else if (status === 412 && data.code === 'PRECONDITION_FAILED') {
        // v1.14.4 R9: DELETE conflict UI — Cancel + Delete Anyway (no Reload)
        // W4: do NOT broadcast on 412
        disarmDelete();
        showConflictUI('delete', data.currentItem, data.currentEtag, null);
      } else {
        // W4: do NOT broadcast on error
        const msg = data.error || `Error ${data.code || status}`;
        disarmDelete();
        showToast(`Delete failed: ${msg}`, TOAST_OVERRIDE_MS);
      }
    })
    .catch((err) => {
      // W4: do NOT broadcast on network error
      disarmDelete();
      showToast(`Delete failed: ${err.message}`, TOAST_OVERRIDE_MS);
    });
}

// ------------------------------------------------------------------
// v1.14.4 — Conflict UI: showConflictUI, hideConflictUI, getConflictPanelEl
// All imported from ./edit-form.js (R1 BLOCKING — mechanical zero-logic-change relocation).
// handleConflictReload, handleSaveAnyway, handleDeleteAnyway use initEditForm callbacks.
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Filter chip state
// ------------------------------------------------------------------
function updateFilterChips() {
  // Type chips
  document.querySelectorAll('[data-filter-type]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filterType === currentFilters.type);
  });
  // Status chips
  document.querySelectorAll('[data-filter-status]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filterStatus === currentFilters.status);
  });
  // v1.18.0 ADR 018 D1: coached-only chip
  const coachedChip = document.getElementById('filter-coached');
  if (coachedChip) coachedChip.classList.toggle('active', coachedOnlyFilter);
}

function buildQueryString(filters) {
  const params = new URLSearchParams();
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.tag) params.set('tag', filters.tag);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// ------------------------------------------------------------------
// API calls
// ------------------------------------------------------------------
function fetchItems() {
  if (!initData) {
    showError('Not authenticated. Open from Telegram.');
    return;
  }
  showLoading();

  const url = `/api/webapp/items${buildQueryString(currentFilters)}`;
  fetch(url, {
    method: 'GET',
    headers: { Authorization: `tma ${initData}` },
  })
    .then((res) => res.json())
    .then((data) => {
      // R3: unified envelope — check ok flag
      if (data.ok === true) {
        let items = data.items || [];
        // v1.18.0 ADR 018 D1: client-side coached-only filter
        if (coachedOnlyFilter) {
          items = items.filter((it) => it.coachIntensity && it.coachIntensity !== 'off');
        }
        showList(items);
      } else {
        const msg = data.error || `Error ${data.code || 'UNKNOWN'}`;
        showError(msg);
      }
    })
    .catch((err) => {
      showError(`Network error: ${err.message}`);
    });
}

function fetchAndShowDetail(itemId) {
  if (!initData) return;

  fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
    method: 'GET',
    headers: { Authorization: `tma ${initData}` },
  })
    .then((res) => {
      // v1.14.4 D2: capture ETag from response header for use as If-Match on mutations
      const etag = res.headers.get(ETAG_HEADER);
      setCurrentDetailEtag(etag || null);
      return res.json();
    })
    .then((data) => {
      // R3: unified envelope — check ok flag
      if (data.ok === true) {
        renderDetail(data.item);
        showDetailView();
      } else {
        const msg = data.error || `Error ${data.code || 'UNKNOWN'}`;
        showError(msg);
      }
    })
    .catch((err) => {
      showError(`Network error: ${err.message}`);
    });
}

// ------------------------------------------------------------------
// v1.15.0 — View switcher (D7; R7; D8)
// ------------------------------------------------------------------

/** DOM refs for view containers and switcher buttons (populated in DOMContentLoaded). */
let kanbanViewEl = null;
let calendarViewEl = null;
let viewListBtnEl = null;
let viewKanbanBtnEl = null;
let viewCalendarBtnEl = null;
let calendarConflictBannerEl = null;

/**
 * Switch to a different view.
 * D8: exits multi-select on view switch; clears in-flight rollback.
 *
 * @param {'list'|'kanban'|'calendar'} targetView
 */
function switchView(targetView) {
  if (targetView !== 'list' && targetView !== 'kanban' && targetView !== 'calendar') return;
  if (targetView === currentViewMode) return;

  // D8: exit multi-select mode on view switch
  if (multiSelectMode) exitSelectMode();

  // Exit current view
  if (currentViewMode === 'kanban') {
    exitKanbanView();
    cancelPendingRollback();
  } else if (currentViewMode === 'calendar') {
    exitCalendarView();
  }

  currentViewMode = targetView;
  saveView(targetView);

  // Update switcher button active states
  if (viewListBtnEl) viewListBtnEl.classList.toggle('active', targetView === 'list');
  if (viewKanbanBtnEl) viewKanbanBtnEl.classList.toggle('active', targetView === 'kanban');
  if (viewCalendarBtnEl) viewCalendarBtnEl.classList.toggle('active', targetView === 'calendar');

  // Show / hide view containers
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.hidden = (targetView !== 'list');
  if (kanbanViewEl) kanbanViewEl.hidden = (targetView !== 'kanban');
  if (calendarViewEl) calendarViewEl.hidden = (targetView !== 'calendar');

  // Enter new view
  if (targetView === 'kanban') {
    enterKanbanView();
    renderKanban(renderedItems, { showTutorial: true });
  } else if (targetView === 'calendar') {
    enterCalendarView();
    renderCalendar(renderedItems);
  }
}

// ------------------------------------------------------------------
// v1.15.0 — /api/webapp/config boot fetch (D9)
// ------------------------------------------------------------------

/**
 * Fetch /api/webapp/config to get the dynamic BroadcastChannel name.
 * Falls back to hardcoded 'organize-mutations-jarvis' on any failure.
 * Must be called BEFORE initBroadcastChannel.
 *
 * @param {string} iData  — initData for auth
 * @returns {Promise<void>}
 */
async function fetchWebappConfig(iData) {
  try {
    const res = await fetch('/api/webapp/config', {
      method: 'GET',
      headers: { Authorization: `tma ${iData}` },
    });
    if (res.status === 200) {
      const data = await res.json();
      if (data.ok === true && typeof data.broadcastChannelName === 'string' && data.broadcastChannelName.length > 0) {
        _resolvedChannelName = data.broadcastChannelName;
        return;
      }
    }
    // 404 or non-200: older server without the endpoint — fall back silently
    if (res.status !== 404) {
      console.info('[organize] /api/webapp/config returned', res.status, '— using fallback channel name');
    }
  } catch {
    // Network error — fall back silently
    console.info('[organize] /api/webapp/config fetch failed — using fallback channel name');
  }
  _resolvedChannelName = BROADCAST_CHANNEL_FALLBACK;
}

// ------------------------------------------------------------------
// Navigation
// ------------------------------------------------------------------
function returnToList() {
  showListView();
}

// ------------------------------------------------------------------
// Initialisation
// ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Cache DOM elements
  loadingEl = document.getElementById('loading');
  itemListEl = document.getElementById('item-list');
  emptyStateEl = document.getElementById('empty-state');
  errorStateEl = document.getElementById('error-state');
  retryBtnEl = document.getElementById('retry-btn');
  detailPanelEl = document.getElementById('detail-panel');
  detailBackEl = document.getElementById('detail-back');
  detailTitleEl = document.getElementById('detail-title');
  detailMetaEl = document.getElementById('detail-meta');
  detailNotesEl = document.getElementById('detail-notes');
  detailProgressEl = document.getElementById('detail-progress');
  // v1.14.2 mutation elements (app.js only caches what it needs directly)
  editBtnEl = document.getElementById('edit-btn');
  editFormEl = document.getElementById('edit-form'); // needed for BC-banner open-form check
  deleteBtnEl = document.getElementById('delete-btn');
  toastEl = document.getElementById('toast');
  // v1.14.5 — bc-banner
  bcBannerEl = document.getElementById(BC_BANNER_ID);

  // v1.17.0 — init detail-panel.js module with DOM refs + callbacks (D1 extraction)
  initDetailPanel({
    detailPanelEl:    document.getElementById('detail-panel'),
    detailTitleEl:    document.getElementById('detail-title'),
    detailMetaEl:     document.getElementById('detail-meta'),
    detailNotesEl:    document.getElementById('detail-notes'),
    detailProgressEl: document.getElementById('detail-progress'),
  }, {
    onReturnToList:      showListView,
    setBackButtonAction: setBackButtonAction,
    returnToListFn:      returnToList,
  });

  // v1.14.2 + v1.14.3 + v1.14.4 + v1.14.5 — init edit-form.js module with all DOM refs + callbacks
  initEditForm({
    editFormEl:              document.getElementById('edit-form'),
    editTitleEl:             document.getElementById('edit-title'),
    editDueEl:               document.getElementById('edit-due'),
    editTagsEl:              document.getElementById('edit-tags'),
    editParentEl:            document.getElementById('edit-parent'),
    editNotesEl:             document.getElementById('edit-notes'),
    editProgressEl:          document.getElementById('edit-progress'),
    notesCounterEl:          document.getElementById('notes-counter'),
    progressCounterEl:       document.getElementById('progress-counter'),
    editCancelEl:            document.getElementById('edit-cancel'),
    editSaveEl:              document.getElementById('edit-save'),
    editErrorEl:             document.getElementById('edit-error'),
    editSpinnerEl:           document.getElementById('edit-spinner'),
    editBtnEl:               document.getElementById('edit-btn'),
    detailMetaEl:            document.getElementById('detail-meta'),
    conflictPanelEl:         document.getElementById('conflict-panel'),
    conflictTitleEl:         document.getElementById('conflict-title'),
    conflictMessageEl:       document.getElementById('conflict-message'),
    conflictReloadEl:        document.getElementById('conflict-reload'),
    conflictSaveAnywayEl:    document.getElementById('conflict-save-anyway'),
    conflictDeleteAnywayEl:  document.getElementById('conflict-delete-anyway'),
    conflictCancelEl:        document.getElementById('conflict-cancel'),
  }, {
    getInitData:       () => initData,
    getItem:           () => getCurrentDetailItem(),
    getEtag:           () => getCurrentDetailEtag(),
    onSaveSuccess:     (updated, newEtag, opts) => {
      if (opts && opts.reload && opts.itemId) {
        fetchAndShowDetail(opts.itemId);
        return;
      }
      if (newEtag) setCurrentDetailEtag(newEtag);
      hideBcBanner();
      renderDetail(updated);
      const idx = renderedItems.findIndex((i) => i.id === updated.id);
      if (idx !== -1) {
        renderedItems[idx] = { ...renderedItems[idx], ...updated };
        showList(renderedItems);
      }
    },
    onDeleteSuccess:   (itemId) => {
      renderedItems = renderedItems.filter((i) => i.id !== itemId);
      clearDetailState();
      returnToList();
      showList(renderedItems);
    },
    showToast,
    hideBcBanner,
    broadcastMutation,
  });
  // v1.14.6 — multi-select + bulk action bar
  selectToggleBtnEl = document.getElementById(SELECT_TOGGLE_BTN_ID);
  selectBarEl = document.getElementById(SELECT_BAR_ID);
  selectCountEl = document.getElementById(SELECT_COUNT_ID);
  newItemBtnEl = document.getElementById(NEW_ITEM_BTN_ID);
  // v1.14.6 — create form elements
  createFormEl = document.getElementById(CREATE_FORM_ID);
  createTitleEl = document.getElementById('create-title');
  createDueEl = document.getElementById('create-due');
  createTagsEl = document.getElementById('create-tags');
  createParentEl = document.getElementById('create-parent');
  createParentLabelEl = document.getElementById('create-parent-label');
  createNotesEl = document.getElementById('create-notes');
  createProgressEl = document.getElementById('create-progress');
  createTitleCounterEl = document.getElementById('create-title-counter');
  createNotesCounterEl = document.getElementById('create-notes-counter');
  createProgressCounterEl = document.getElementById('create-progress-counter');
  createSubmitEl = document.getElementById('create-submit');
  createCancelEl = document.getElementById('create-cancel');
  createErrorEl = document.getElementById('create-error');
  // v1.14.6 — bulk delete typed-confirm
  bulkDeleteTypedConfirmEl = document.getElementById('bulk-delete-typed-confirm');
  bulkDeleteTypedInputEl = document.getElementById('bulk-delete-typed-input');
  bulkDeleteTypedCountEl = document.getElementById('bulk-delete-count');
  bulkDeleteTypedConfirmBtnEl = document.getElementById('bulk-delete-typed-confirm-btn');
  bulkDeleteTypedCancelBtnEl = document.getElementById('bulk-delete-typed-cancel-btn');

  // Load collapse state from sessionStorage
  collapseState = loadCollapseState();

  // --- Unauth path: SDK not present (opened in browser, not via Telegram) ---
  if (!window.Telegram || !window.Telegram.WebApp) {
    showError('Open this from a /webapp button in Telegram.');
    return;
  }

  const twa = window.Telegram.WebApp;

  // Signal readiness and expand to full height
  twa.ready();
  twa.expand();

  // Apply theme immediately (R12.4)
  applyTheme();

  // Subscribe to theme changes so dark/light toggle is handled (R12.4)
  twa.onEvent('themeChanged', applyTheme);

  initData = twa.initData || '';

  // --- Unauth path: empty initData (developer tools / direct URL) ---
  if (!initData) {
    showError('Open this from a /webapp button in Telegram.');
    return;
  }

  // Load persisted filter state from sessionStorage (R10)
  currentFilters = loadFilters();
  updateFilterChips();

  // Wire filter chips — type
  document.querySelectorAll('[data-filter-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // v1.14.6 D9/R7: filter change exits select mode (different filter = different working set)
      if (multiSelectMode) exitSelectMode();
      currentFilters = { ...currentFilters, type: btn.dataset.filterType };
      saveFilters(currentFilters);
      updateFilterChips();
      fetchItems();
    });
  });

  // Wire filter chips — status
  document.querySelectorAll('[data-filter-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // v1.14.6 D9/R7: filter change exits select mode
      if (multiSelectMode) exitSelectMode();
      currentFilters = { ...currentFilters, status: btn.dataset.filterStatus };
      saveFilters(currentFilters);
      updateFilterChips();
      fetchItems();
    });
  });

  // v1.18.0 ADR 018 D1: wire coached-only filter chip (client-side toggle)
  const coachedChipEl = document.getElementById('filter-coached');
  if (coachedChipEl) {
    coachedChipEl.addEventListener('click', () => {
      if (multiSelectMode) exitSelectMode();
      coachedOnlyFilter = !coachedOnlyFilter;
      updateFilterChips();
      fetchItems();
    });
  }

  // Wire retry button
  if (retryBtnEl) {
    retryBtnEl.addEventListener('click', fetchItems);
  }

  // Wire in-page back button on the detail panel
  if (detailBackEl) {
    detailBackEl.addEventListener('click', returnToList);
  }

  // Wire edit button (enter edit mode — app.js owns the "Enter Edit" action)
  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      const _cur = getCurrentDetailItem();
      if (_cur) enterEditMode(_cur);
    });
  }

  // Wire delete button — first tap arms, second tap (within 6s) commits
  if (deleteBtnEl) {
    deleteBtnEl.addEventListener('click', armDelete);
  }

  // Note: edit form submit, cancel, status pills, dirty inputs, conflict panel buttons,
  // and parent picker are all wired by initEditForm() above.

  // v1.14.5 — wire bc-banner buttons
  const bcReloadBtn = document.getElementById(BC_RELOAD_BTN_ID);
  const bcDismissBtn = document.getElementById(BC_DISMISS_BTN_ID);
  if (bcReloadBtn) {
    bcReloadBtn.addEventListener('click', handleBcReload);
  }
  if (bcDismissBtn) {
    bcDismissBtn.addEventListener('click', hideBcBanner);
  }

  // ------------------------------------------------------------------
  // v1.15.0 — Cache view switcher + kanban/calendar DOM refs
  // ------------------------------------------------------------------
  viewListBtnEl = document.getElementById('view-list');
  viewKanbanBtnEl = document.getElementById('view-kanban');
  viewCalendarBtnEl = document.getElementById('view-calendar');
  kanbanViewEl = document.getElementById('kanban-view');
  calendarViewEl = document.getElementById('calendar-view');
  calendarConflictBannerEl = document.getElementById('calendar-conflict-banner');

  // Wire view switcher buttons
  if (viewListBtnEl) viewListBtnEl.addEventListener('click', () => switchView('list'));
  if (viewKanbanBtnEl) viewKanbanBtnEl.addEventListener('click', () => switchView('kanban'));
  if (viewCalendarBtnEl) viewCalendarBtnEl.addEventListener('click', () => switchView('calendar'));

  // Wire calendar nav buttons
  const calPrevBtn = document.getElementById('cal-prev');
  const calNextBtn = document.getElementById('cal-next');
  const calTodayBtn = document.getElementById('cal-today');
  if (calPrevBtn) calPrevBtn.addEventListener('click', calNavPrev);
  if (calNextBtn) calNextBtn.addEventListener('click', calNavNext);
  if (calTodayBtn) calTodayBtn.addEventListener('click', calNavToday);

  // Wire calendar subview chips
  document.querySelectorAll('[data-calendar-subview]').forEach((btn) => {
    btn.addEventListener('click', () => calSetSubview(btn.dataset.calendarSubview));
  });

  // Init kanban view module
  if (kanbanViewEl) {
    initKanbanView(kanbanViewEl, toastEl, {
      getInitData: () => initData,
      getRenderedItems: () => renderedItems,
      onPatchSuccess: (itemId, updatedItem, newEtag, opts) => {
        if (opts && !opts.optimistic) {
          // Update renderedItems with the server-confirmed (or rolled-back) state
          const idx = renderedItems.findIndex((i) => i.id === itemId);
          if (idx !== -1) {
            renderedItems[idx] = { ...renderedItems[idx], ...updatedItem };
            if (newEtag) renderedItems[idx].etag = newEtag;
          }
        } else if (opts && opts.optimistic) {
          // Optimistic: update in-memory immediately for re-render
          const idx = renderedItems.findIndex((i) => i.id === itemId);
          if (idx !== -1) {
            renderedItems[idx] = { ...renderedItems[idx], ...updatedItem };
          }
        }
        // R8: full re-render from renderedItems
        if (currentViewMode === 'kanban') renderKanban(renderedItems);
      },
      showToast,
      broadcastMutation,
    });
  }

  // Init calendar view module
  if (calendarViewEl) {
    initCalendarView(calendarViewEl, calendarConflictBannerEl, {
      getInitData: () => initData,
      getRenderedItems: () => renderedItems,
      onPatchSuccess: (itemId, updatedItem, newEtag, opts) => {
        if (opts && !opts.optimistic) {
          const idx = renderedItems.findIndex((i) => i.id === itemId);
          if (idx !== -1) {
            renderedItems[idx] = { ...renderedItems[idx], ...updatedItem };
            if (newEtag) renderedItems[idx].etag = newEtag;
          }
        }
        // R8: full re-render from renderedItems
        if (currentViewMode === 'calendar') renderCalendar(renderedItems);
      },
      showToast,
      broadcastMutation,
    });
  }

  // ------------------------------------------------------------------
  // v1.15.0 — Boot: fetch /api/webapp/config then init BroadcastChannel (D9)
  // ------------------------------------------------------------------
  // Fetch config first (must set _resolvedChannelName BEFORE BroadcastChannel setup)
  fetchWebappConfig(initData).then(() => {
    // v1.14.5 — initialise BroadcastChannel (feature-detect + try/catch — D10)
    initBroadcastChannel();
  });

  // v1.15.0: restore persisted view
  const persistedView = loadView();
  currentViewMode = persistedView;
  if (viewListBtnEl) viewListBtnEl.classList.toggle('active', persistedView === 'list');
  if (viewKanbanBtnEl) viewKanbanBtnEl.classList.toggle('active', persistedView === 'kanban');
  if (viewCalendarBtnEl) viewCalendarBtnEl.classList.toggle('active', persistedView === 'calendar');
  const mainElView = document.getElementById('main');
  if (mainElView) mainElView.hidden = (persistedView !== 'list');
  if (kanbanViewEl) kanbanViewEl.hidden = (persistedView !== 'kanban');
  if (calendarViewEl) calendarViewEl.hidden = (persistedView !== 'calendar');

  // ------------------------------------------------------------------
  // v1.14.6 — Wire multi-select + create form (D10/D13; R9 mutual exclusion)
  // ------------------------------------------------------------------

  // Select toggle button — enters / cancels select mode (R9: label "Select" / "Cancel")
  if (selectToggleBtnEl) {
    selectToggleBtnEl.addEventListener('click', () => {
      if (multiSelectMode) {
        exitSelectMode();
      } else {
        enterSelectMode();
      }
    });
  }

  // "+ New" button — enters create form (R9: only when not in select mode)
  if (newItemBtnEl) {
    newItemBtnEl.addEventListener('click', () => {
      if (!multiSelectMode) enterCreateForm();
    });
  }

  // Bulk action bar buttons
  const bulkCompleteBtn = document.getElementById('bulk-complete');
  const bulkDeleteBtn = document.getElementById('bulk-delete');
  const bulkReparentBtn = document.getElementById('bulk-reparent');
  const bulkCancelBtn = document.getElementById('bulk-cancel');
  if (bulkCompleteBtn) bulkCompleteBtn.addEventListener('click', handleBulkComplete);
  if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', handleBulkDelete);
  if (bulkReparentBtn) bulkReparentBtn.addEventListener('click', handleBulkReParent);
  if (bulkCancelBtn) bulkCancelBtn.addEventListener('click', exitSelectMode);

  // Create form submit + cancel
  if (createFormEl) {
    createFormEl.addEventListener('submit', handleCreateSubmit);
  }
  if (createCancelEl) {
    createCancelEl.addEventListener('click', exitCreateForm);
  }

  // Create form — type pill clicks
  if (createFormEl) {
    createFormEl.querySelectorAll('[data-create-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _createFormType = btn.dataset.createType || 'task';
        createFormEl.querySelectorAll('[data-create-type]').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        // Show/hide parent picker based on type (goal can't have parent — ADR 014 D8)
        updateCreateParentVisibility();
        if (_createFormType === 'goal' && createParentEl) {
          createParentEl.value = ''; // DOM property .value — never setAttribute
        }
      });
    });
  }

  // Create form — title char counter + unlock submit
  if (createTitleEl) {
    createTitleEl.addEventListener('input', () => {
      if (createTitleCounterEl) updateCounter(createTitleEl, createTitleCounterEl, 500);
      // Enable/disable submit based on title content
      if (createSubmitEl) createSubmitEl.disabled = createTitleEl.value.trim().length === 0;
    });
  }

  // Create form — notes + progress char counters
  if (createNotesEl) {
    createNotesEl.addEventListener('input', () => {
      if (createNotesCounterEl) updateCounter(createNotesEl, createNotesCounterEl, NOTES_MAX);
    });
  }
  if (createProgressEl) {
    createProgressEl.addEventListener('input', () => {
      if (createProgressCounterEl) updateCounter(createProgressEl, createProgressCounterEl, PROGRESS_MAX);
    });
  }

  // ESC key — exits select mode or create form
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (multiSelectMode) exitSelectMode();
      else if (createFormEl && !createFormEl.hidden) exitCreateForm();
    }
  });

  // Initial fetch
  fetchItems();
});
