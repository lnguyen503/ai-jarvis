/**
 * Audit log — Jarvis v1.17.0
 *
 * Vanilla JS, no framework, no bundler. ES module.
 * CSP: script-src 'self' https://telegram.org — no inline JS.
 * Read-only — no edit/delete UI elements.
 *
 * Security invariants (ADR 017 D4 + R9):
 *  - detail_json formatted via JSON.stringify(parsed, null, 2).
 *  - Truncated at DETAIL_JSON_DISPLAY_MAX_CHARS (16384 chars = 16KB).
 *  - Rendered in <pre> via pre.textContent ONLY — never innerHTML.
 *  - Row data (category, ts, actor) rendered via textContent.
 *
 * R4 binding: Refresh button resets cursor + fetches latest rows.
 * R6 binding: category filter validated against server-returned KNOWN_AUDIT_CATEGORIES.
 * R9 binding: 16KB display cap + textContent in <pre>.
 * Cursor-based pagination (forward-only): nextCursor opaque string.
 */

'use strict';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** R9: Display cap for detail_json pretty-print output. */
const DETAIL_JSON_DISPLAY_MAX_CHARS = 16_384;

const TOAST_DEFAULT_MS = 3000;
const TOAST_LONG_MS = 5000;

const DEFAULT_PAGE_SIZE = 50;

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

let _initData = '';
let _cursor = null;            // current pagination cursor (null = latest)
let _hasMore = false;          // whether there are more rows to load
let _currentFilters = {
  categories: [],              // validated string[]
  range: 'last_day',
  from: null,
  to: null,
};

/**
 * KNOWN_AUDIT_CATEGORIES — populated from first successful API response (R6).
 * Server returns this list; client validates filter selections against it.
 * @type {Set<string>}
 */
let _knownAuditCategories = new Set();

// ------------------------------------------------------------------
// DOM refs
// ------------------------------------------------------------------

let listViewEl = null;
let detailViewEl = null;
let refreshBtnEl = null;
let categoryFilterEl = null;
let rangeFilterEl = null;
let customRangeEl = null;
let rangeFromEl = null;
let rangeToEl = null;
let applyFiltersEl = null;
let listLoadingEl = null;
let auditListEl = null;
let listEmptyEl = null;
let listErrorEl = null;
let listRetryEl = null;
let paginationEl = null;
let loadMoreBtnEl = null;
let detailBackEl = null;
let detailCategoryEl = null;
let detailTsEl = null;
let detailActorEl = null;
let detailJsonEl = null;
let toastEl = null;

// ------------------------------------------------------------------
// Toast
// ------------------------------------------------------------------

let _toastTimer = null;

function showToast(msg, durationMs) {
  if (!toastEl) return;
  const dur = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : TOAST_DEFAULT_MS;
  if (_toastTimer) clearTimeout(_toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.remove('fade-out');
  toastEl.hidden = false;
  _toastTimer = setTimeout(() => {
    toastEl.classList.add('fade-out');
    setTimeout(() => { if (toastEl) toastEl.hidden = true; }, 400);
  }, dur);
}

// ------------------------------------------------------------------
// Theme
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
// R9: detail_json rendering (16KB cap + textContent)
// ------------------------------------------------------------------

/**
 * Format and truncate a JSON string for display.
 * R9: pretty-print via JSON.stringify; truncate at DETAIL_JSON_DISPLAY_MAX_CHARS;
 * rendered via pre.textContent ONLY.
 *
 * @param {string} jsonString   raw JSON string from server
 * @returns {string}            display-ready string (may include truncation suffix)
 */
export function formatDetailJson(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (_err) {
    // Not valid JSON — display as-is (still textContent; no innerHTML)
    parsed = jsonString;
  }
  const pretty = typeof parsed === 'string'
    ? parsed
    : JSON.stringify(parsed, null, 2);

  if (pretty.length > DETAIL_JSON_DISPLAY_MAX_CHARS) {
    return pretty.slice(0, DETAIL_JSON_DISPLAY_MAX_CHARS) +
      '\n\n... [truncated; full content in audit_log.detail_json column]';
  }
  return pretty;
}

// ------------------------------------------------------------------
// R6: category filter validation
// ------------------------------------------------------------------

/**
 * Validate selected categories against the server-returned KNOWN_AUDIT_CATEGORIES.
 * R6: unknown values → error message; empty array = all categories (default).
 *
 * @param {string[]} selected
 * @returns {{ok: true, validated: string[]}|{ok: false, error: string}}
 */
export function validateCategoryFilter(selected, knownCategories) {
  if (!selected || selected.length === 0) {
    return { ok: true, validated: [] };
  }
  const unknown = selected.filter((c) => !knownCategories.has(c));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown category: ${unknown.join(', ')}` };
  }
  return { ok: true, validated: selected };
}

// ------------------------------------------------------------------
// Category dropdown population (R6)
// ------------------------------------------------------------------

function populateCategoryDropdown(categories) {
  if (!categoryFilterEl) return;
  categoryFilterEl.innerHTML = ''; // safe clear

  // "All" pseudo-option
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All categories'; // textContent
  categoryFilterEl.appendChild(allOpt);

  for (const cat of categories) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat; // textContent — server-controlled closed set
    categoryFilterEl.appendChild(opt);
  }
}

// ------------------------------------------------------------------
// View management
// ------------------------------------------------------------------

function showListView() {
  if (listViewEl) listViewEl.hidden = false;
  if (detailViewEl) detailViewEl.hidden = true;
}

function showDetailViewPanel(row) {
  if (listViewEl) listViewEl.hidden = true;
  if (detailViewEl) detailViewEl.hidden = false;

  if (detailCategoryEl) {
    detailCategoryEl.textContent = row.category || ''; // textContent
    detailCategoryEl.className = 'badge';
  }
  if (detailTsEl) detailTsEl.textContent = row.ts || ''; // textContent
  if (detailActorEl) {
    const actorText = row.actor_user_id ? `User ID: ${row.actor_user_id}` : '';
    detailActorEl.textContent = actorText; // textContent
  }
  if (detailJsonEl) {
    // R9: detail_json rendered via textContent in <pre>
    const formatted = formatDetailJson(
      typeof row.detail_json === 'string' ? row.detail_json : JSON.stringify(row.detail_json || {})
    );
    detailJsonEl.textContent = formatted; // R9: NEVER innerHTML
  }
}

// ------------------------------------------------------------------
// Render list
// ------------------------------------------------------------------

function renderAuditList(rows, append) {
  if (!auditListEl) return;

  if (!append) {
    auditListEl.innerHTML = ''; // safe clear on fresh load
  }

  if (!rows || rows.length === 0) {
    if (!append) {
      auditListEl.hidden = true;
      if (listEmptyEl) listEmptyEl.hidden = false;
    }
    return;
  }

  if (listEmptyEl) listEmptyEl.hidden = true;
  auditListEl.hidden = false;

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'audit-row';

    const catEl = document.createElement('span');
    catEl.className = 'audit-category';
    catEl.textContent = row.category || ''; // textContent

    const tsEl = document.createElement('span');
    tsEl.className = 'audit-ts';
    tsEl.textContent = row.ts || ''; // textContent

    li.appendChild(catEl);
    li.appendChild(tsEl);
    li.addEventListener('click', () => showDetailViewPanel(row));
    auditListEl.appendChild(li);
  }
}

// ------------------------------------------------------------------
// Build API query string
// ------------------------------------------------------------------

function buildQueryString(cursor) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  params.set('limit', String(DEFAULT_PAGE_SIZE));

  // R6: only add validated categories
  if (_currentFilters.categories.length > 0) {
    params.set('categories', _currentFilters.categories.join(','));
  }

  if (_currentFilters.range !== 'custom') {
    params.set('range', _currentFilters.range);
  } else {
    if (_currentFilters.from) params.set('from', _currentFilters.from);
    if (_currentFilters.to) params.set('to', _currentFilters.to);
  }

  return `?${params.toString()}`;
}

// ------------------------------------------------------------------
// API calls
// ------------------------------------------------------------------

async function fetchAuditRows(cursor, append) {
  if (!_initData) return;

  if (!append) {
    if (listLoadingEl) listLoadingEl.hidden = false;
    if (auditListEl) auditListEl.hidden = true;
    if (listEmptyEl) listEmptyEl.hidden = true;
    if (listErrorEl) listErrorEl.hidden = true;
    if (listRetryEl) listRetryEl.hidden = true;
    if (paginationEl) paginationEl.hidden = true;
  }

  try {
    const qs = buildQueryString(cursor);
    const res = await fetch(`/api/webapp/audit${qs}`, {
      headers: { Authorization: `tma ${_initData}` },
    });
    const data = await res.json();
    if (listLoadingEl) listLoadingEl.hidden = true;

    if (data.ok === true) {
      // R6: populate category dropdown from server-returned categories (first load only)
      if (data.knownCategories && Array.isArray(data.knownCategories) && _knownAuditCategories.size === 0) {
        for (const cat of data.knownCategories) _knownAuditCategories.add(cat);
        populateCategoryDropdown(data.knownCategories);
      }

      const rows = data.rows || [];
      renderAuditList(rows, append);

      // Update cursor state
      _cursor = data.nextCursor || null;
      _hasMore = !!data.nextCursor;
      if (paginationEl) paginationEl.hidden = !_hasMore;
    } else {
      if (listErrorEl) {
        listErrorEl.textContent = data.error || `Error ${data.code || 'UNKNOWN'}`;
        listErrorEl.hidden = false;
      }
      if (listRetryEl) listRetryEl.hidden = false;
    }
  } catch (err) {
    if (listLoadingEl) listLoadingEl.hidden = true;
    if (listErrorEl) {
      listErrorEl.textContent = `Network error: ${err.message}`;
      listErrorEl.hidden = false;
    }
    if (listRetryEl) listRetryEl.hidden = false;
  }
}

/** R4: Refresh = reset cursor + fetch latest. */
function handleRefresh() {
  _cursor = null;
  fetchAuditRows(null, false);
}

/** Load more (cursor-based pagination — forward-only). */
function handleLoadMore() {
  if (!_hasMore || !_cursor) return;
  fetchAuditRows(_cursor, true);
}

// ------------------------------------------------------------------
// Read filter selections
// ------------------------------------------------------------------

function readSelectedCategories() {
  if (!categoryFilterEl) return [];
  const selected = [];
  for (const opt of categoryFilterEl.options) {
    if (opt.selected && opt.value !== '') {
      selected.push(opt.value);
    }
  }
  return selected;
}

// ------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  listViewEl = document.getElementById('list-view');
  detailViewEl = document.getElementById('detail-view');
  refreshBtnEl = document.getElementById('refresh-btn');
  categoryFilterEl = document.getElementById('category-filter');
  rangeFilterEl = document.getElementById('range-filter');
  customRangeEl = document.getElementById('custom-range');
  rangeFromEl = document.getElementById('range-from');
  rangeToEl = document.getElementById('range-to');
  applyFiltersEl = document.getElementById('apply-filters');
  listLoadingEl = document.getElementById('list-loading');
  auditListEl = document.getElementById('audit-list');
  listEmptyEl = document.getElementById('list-empty');
  listErrorEl = document.getElementById('list-error');
  listRetryEl = document.getElementById('list-retry');
  paginationEl = document.getElementById('pagination');
  loadMoreBtnEl = document.getElementById('load-more-btn');
  detailBackEl = document.getElementById('detail-back');
  detailCategoryEl = document.getElementById('detail-category');
  detailTsEl = document.getElementById('detail-ts');
  detailActorEl = document.getElementById('detail-actor');
  detailJsonEl = document.getElementById('detail-json');
  toastEl = document.getElementById('toast');

  if (!window.Telegram || !window.Telegram.WebApp) {
    if (listLoadingEl) listLoadingEl.textContent = 'Open this from a /webapp button in Telegram.';
    return;
  }

  const twa = window.Telegram.WebApp;
  twa.ready();
  twa.expand();
  applyTheme();
  twa.onEvent('themeChanged', applyTheme);

  _initData = twa.initData || '';
  if (!_initData) {
    if (listLoadingEl) listLoadingEl.textContent = 'Open this from a /webapp button in Telegram.';
    return;
  }

  // R4: Refresh button
  if (refreshBtnEl) refreshBtnEl.addEventListener('click', handleRefresh);

  // Range filter — show/hide custom range inputs
  if (rangeFilterEl) {
    rangeFilterEl.addEventListener('change', () => {
      if (customRangeEl) customRangeEl.hidden = (rangeFilterEl.value !== 'custom');
    });
  }

  // Apply filters button (R6: validates categories before fetch)
  if (applyFiltersEl) {
    applyFiltersEl.addEventListener('click', () => {
      const selectedCategories = readSelectedCategories();

      // R6: validate selected categories against known list (skip validation if list not yet populated)
      if (_knownAuditCategories.size > 0 && selectedCategories.length > 0) {
        const validation = validateCategoryFilter(selectedCategories, _knownAuditCategories);
        if (!validation.ok) {
          showToast(validation.error, TOAST_LONG_MS);
          return;
        }
        _currentFilters.categories = validation.validated;
      } else {
        _currentFilters.categories = selectedCategories;
      }

      _currentFilters.range = rangeFilterEl ? rangeFilterEl.value : 'last_day';
      _currentFilters.from = (rangeFromEl && _currentFilters.range === 'custom') ? rangeFromEl.value : null;
      _currentFilters.to = (rangeToEl && _currentFilters.range === 'custom') ? rangeToEl.value : null;

      // Reset cursor and fetch
      _cursor = null;
      fetchAuditRows(null, false);
    });
  }

  // Load more button
  if (loadMoreBtnEl) loadMoreBtnEl.addEventListener('click', handleLoadMore);

  // Retry button
  if (listRetryEl) listRetryEl.addEventListener('click', () => fetchAuditRows(null, false));

  // Detail back button
  if (detailBackEl) detailBackEl.addEventListener('click', showListView);

  // Initial load
  fetchAuditRows(null, false);
});
