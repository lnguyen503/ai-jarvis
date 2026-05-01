/**
 * Memory browser — Jarvis v1.17.0
 *
 * Vanilla JS, no framework, no bundler. ES module.
 * CSP: script-src 'self' https://telegram.org — no inline JS.
 *
 * Security invariants (ADR 017 D3 + R5 + R8):
 *  - Memory value rendered via textContent ONLY (NOT markdown.js — plain text per chat semantics).
 *  - Input/textarea values set via DOM property .value — never setAttribute.
 *  - No native confirm(). No inline event handlers.
 *  - Memory key whitelist: ^[a-z0-9_-]{1,64}$ enforced client-side (server enforces too).
 *
 * R5 binding: _memorySubmitInFlight flag + AbortController + MEMORY_SUBMIT_TIMEOUT_MS = 30000.
 * Shared flag covers Save AND Delete — no double mutation while one is in-flight.
 * If-Match header sent on PATCH (update); 412 → conflict UI.
 * If-Match not sent on PUT for new entries (server returns 412 if key already exists w/o header).
 */

'use strict';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** R5: Matches v1.14.6 D15+R6 pattern. */
const MEMORY_SUBMIT_TIMEOUT_MS = 30_000;

const TOAST_DEFAULT_MS = 3000;
const TOAST_LONG_MS = 5000;

/** Memory key whitelist (defense in depth — server enforces too). */
const MEMORY_KEY_RE = /^[a-z0-9_-]{1,64}$/;

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

/** R5: double-submit guard. Shared by save + delete. */
let _memorySubmitInFlight = false;

let _initData = '';
let _allEntries = [];   // full list from server
let _currentEntry = null; // entry in detail view
let _currentEtag = null;  // ETag for If-Match on PATCH

// ------------------------------------------------------------------
// DOM refs (populated in DOMContentLoaded)
// ------------------------------------------------------------------

let listViewEl = null;
let detailViewEl = null;
let searchInputEl = null;
let newEntryBtnEl = null;
let entryListEl = null;
let listLoadingEl = null;
let listEmptyEl = null;
let listErrorEl = null;
let listRetryEl = null;
let detailBackEl = null;
let readModeEl = null;
let editModeEl = null;
let newModeEl = null;
let detailKeyEl = null;
let detailCategoryEl = null;
let detailMtimeEl = null;
let detailValueEl = null;
let editBtnEl = null;
let deleteBtnEl = null;
let editKeyEl = null;
let editCategoryEl = null;
let editValueEl = null;
let conflictPanelEl = null;
let conflictMessageEl = null;
let conflictOverwriteEl = null;
let conflictCancelEl = null;
let editErrorEl = null;
let saveBtnEl = null;
let editCancelEl = null;
let newKeyEl = null;
let newCategoryEl = null;
let newValueEl = null;
let newErrorEl = null;
let newSaveBtnEl = null;
let newCancelEl = null;
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
// Client-side key whitelist validation (defense in depth)
// ------------------------------------------------------------------

/**
 * Validate a memory key client-side.
 * @param {string} key
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function validateMemoryKey(key) {
  if (!key || typeof key !== 'string') {
    return { ok: false, error: 'Key is required.' };
  }
  if (!MEMORY_KEY_RE.test(key)) {
    return { ok: false, error: 'Key must match ^[a-z0-9_-]{1,64}$ (lowercase letters, numbers, _ and -).' };
  }
  return { ok: true };
}

// ------------------------------------------------------------------
// View management
// ------------------------------------------------------------------

function showListView() {
  if (listViewEl) listViewEl.hidden = false;
  if (detailViewEl) detailViewEl.hidden = true;
  _currentEntry = null;
  _currentEtag = null;
}

function showDetailView(entry, etag) {
  _currentEntry = entry;
  _currentEtag = etag || null;
  if (listViewEl) listViewEl.hidden = true;
  if (detailViewEl) detailViewEl.hidden = false;

  // Show read mode
  showReadMode(entry);
}

function showReadMode(entry) {
  if (readModeEl) readModeEl.hidden = false;
  if (editModeEl) editModeEl.hidden = true;
  if (newModeEl) newModeEl.hidden = true;

  if (detailKeyEl) detailKeyEl.textContent = entry.key || ''; // textContent
  if (detailCategoryEl) {
    detailCategoryEl.textContent = entry.category || ''; // textContent
    detailCategoryEl.className = `badge badge-${entry.category || 'preferences'}`;
  }
  if (detailMtimeEl) detailMtimeEl.textContent = entry.mtime ? `Updated: ${entry.mtime}` : '';
  if (detailValueEl) detailValueEl.textContent = entry.body || ''; // R8: textContent ONLY
}

function showEditMode(entry) {
  if (readModeEl) readModeEl.hidden = true;
  if (editModeEl) editModeEl.hidden = false;
  if (newModeEl) newModeEl.hidden = true;

  if (editKeyEl) editKeyEl.value = entry.key || '';
  if (editCategoryEl) editCategoryEl.value = entry.category || 'preferences';
  if (editValueEl) editValueEl.value = entry.body || ''; // DOM .value — never setAttribute
  if (editErrorEl) editErrorEl.hidden = true;
  if (conflictPanelEl) conflictPanelEl.hidden = true;
}

function showNewMode() {
  if (listViewEl) listViewEl.hidden = true;
  if (detailViewEl) detailViewEl.hidden = false;
  if (readModeEl) readModeEl.hidden = true;
  if (editModeEl) editModeEl.hidden = true;
  if (newModeEl) newModeEl.hidden = false;

  if (newKeyEl) newKeyEl.value = '';
  if (newCategoryEl) newCategoryEl.value = 'preferences';
  if (newValueEl) newValueEl.value = '';
  if (newErrorEl) newErrorEl.hidden = true;
  _currentEntry = null;
  _currentEtag = null;
}

// ------------------------------------------------------------------
// Render list
// ------------------------------------------------------------------

function getFilteredEntries(query) {
  if (!query) return _allEntries;
  const q = query.toLowerCase();
  return _allEntries.filter((e) => (e.key || '').toLowerCase().includes(q));
}

function renderEntryList(entries) {
  if (!entryListEl) return;
  entryListEl.innerHTML = ''; // safe clear

  if (!entries || entries.length === 0) {
    entryListEl.hidden = true;
    if (listEmptyEl) listEmptyEl.hidden = false;
    return;
  }

  if (listEmptyEl) listEmptyEl.hidden = true;
  entryListEl.hidden = false;

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'entry-item';

    const keyEl = document.createElement('span');
    keyEl.className = 'entry-key';
    keyEl.textContent = entry.key || ''; // textContent

    const categoryEl = document.createElement('span');
    categoryEl.className = `badge badge-${entry.category || 'preferences'}`;
    categoryEl.textContent = entry.category || ''; // textContent

    const previewEl = document.createElement('span');
    previewEl.className = 'entry-preview';
    const body = entry.body || '';
    previewEl.textContent = body.length > 80 ? body.slice(0, 80) + '…' : body; // textContent

    li.appendChild(keyEl);
    li.appendChild(categoryEl);
    li.appendChild(previewEl);

    li.addEventListener('click', () => fetchEntryDetail(entry.key));
    entryListEl.appendChild(li);
  }
}

// ------------------------------------------------------------------
// API calls
// ------------------------------------------------------------------

async function fetchEntries() {
  if (!_initData) return;
  if (listLoadingEl) listLoadingEl.hidden = false;
  if (entryListEl) entryListEl.hidden = true;
  if (listErrorEl) listErrorEl.hidden = true;
  if (listRetryEl) listRetryEl.hidden = true;

  try {
    const res = await fetch('/api/webapp/memory', {
      headers: { Authorization: `tma ${_initData}` },
    });
    const data = await res.json();
    if (listLoadingEl) listLoadingEl.hidden = true;
    if (data.ok === true) {
      _allEntries = data.entries || [];
      const query = searchInputEl ? searchInputEl.value.trim() : '';
      renderEntryList(getFilteredEntries(query));
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

async function fetchEntryDetail(key) {
  if (!_initData) return;
  try {
    const res = await fetch(`/api/webapp/memory/${encodeURIComponent(key)}`, {
      headers: { Authorization: `tma ${_initData}` },
    });
    const etag = res.headers.get('ETag');
    const data = await res.json();
    if (data.ok === true) {
      showDetailView(data.entry, etag);
    } else {
      showToast(data.error || 'Failed to load entry.', TOAST_LONG_MS);
    }
  } catch (err) {
    showToast(`Network error: ${err.message}`, TOAST_LONG_MS);
  }
}

/**
 * R5: Save entry (create or update) with double-submit guard + AbortController + 30s timeout.
 * If-Match header sent on PATCH (update); omitted on PUT for new entries.
 */
async function handleSave(isNew) {
  if (_memorySubmitInFlight) return; // R5 guard

  const keyEl = isNew ? newKeyEl : editKeyEl;
  const categoryEl = isNew ? newCategoryEl : editCategoryEl;
  const valueEl = isNew ? newValueEl : editValueEl;
  const errorEl = isNew ? newErrorEl : editErrorEl;

  const key = keyEl ? keyEl.value.trim() : '';
  const category = categoryEl ? categoryEl.value : 'preferences';
  const body = valueEl ? valueEl.value : ''; // DOM .value

  // Client-side key validation
  const keyValidation = validateMemoryKey(key);
  if (!keyValidation.ok) {
    if (errorEl) {
      errorEl.textContent = keyValidation.error;
      errorEl.hidden = false;
    }
    return;
  }

  if (!body.trim()) {
    if (errorEl) {
      errorEl.textContent = 'Value is required.';
      errorEl.hidden = false;
    }
    return;
  }

  if (errorEl) errorEl.hidden = true;
  if (conflictPanelEl && !isNew) conflictPanelEl.hidden = true;

  _memorySubmitInFlight = true;
  const submitBtn = isNew ? newSaveBtnEl : saveBtnEl;
  if (submitBtn) submitBtn.disabled = true;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), MEMORY_SUBMIT_TIMEOUT_MS);

  try {
    const headers = {
      Authorization: `tma ${_initData}`,
      'Content-Type': 'application/json',
    };
    // If-Match on PATCH (update) — R5 binding
    if (!isNew && _currentEtag) {
      headers['If-Match'] = _currentEtag;
    }

    const url = `/api/webapp/memory/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: isNew ? 'PUT' : 'PATCH',
      headers,
      body: JSON.stringify({ category, body }),
      signal: abortCtrl.signal,
    });

    const data = await res.json();

    if ((res.status === 200 || res.status === 201) && data.ok === true) {
      showToast(isNew ? 'Entry created.' : 'Entry updated.', TOAST_DEFAULT_MS);
      showListView();
      await fetchEntries();
    } else if (res.status === 412) {
      // 412 Precondition Failed — show conflict UI
      if (!isNew && conflictPanelEl && conflictMessageEl) {
        conflictMessageEl.textContent = data.error || 'This entry was modified by another session. Save anyway?';
        conflictPanelEl.hidden = false;
      }
    } else {
      if (errorEl) {
        errorEl.textContent = data.error || `Error ${data.code || res.status}`;
        errorEl.hidden = false;
      }
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.name === 'AbortError'
        ? 'Request timed out. Please try again.'
        : `Network error: ${err.message}`;
      errorEl.hidden = false;
    }
  } finally {
    clearTimeout(timeoutId);
    _memorySubmitInFlight = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

/** Force-overwrite on conflict — Save Anyway. */
async function handleSaveAnyway() {
  if (_memorySubmitInFlight) return; // R5 guard

  const key = editKeyEl ? editKeyEl.value.trim() : '';
  const category = editCategoryEl ? editCategoryEl.value : 'preferences';
  const body = editValueEl ? editValueEl.value : '';

  if (conflictPanelEl) conflictPanelEl.hidden = true;
  if (editErrorEl) editErrorEl.hidden = true;

  _memorySubmitInFlight = true;
  if (saveBtnEl) saveBtnEl.disabled = true;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), MEMORY_SUBMIT_TIMEOUT_MS);

  try {
    const res = await fetch(`/api/webapp/memory/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `tma ${_initData}`,
        'Content-Type': 'application/json',
        // No If-Match = force overwrite
      },
      body: JSON.stringify({ category, body }),
      signal: abortCtrl.signal,
    });
    const data = await res.json();
    if ((res.status === 200 || res.status === 201) && data.ok === true) {
      showToast('Entry saved (overwrite).', TOAST_DEFAULT_MS);
      showListView();
      await fetchEntries();
    } else {
      if (editErrorEl) {
        editErrorEl.textContent = data.error || `Error ${data.code || res.status}`;
        editErrorEl.hidden = false;
      }
    }
  } catch (err) {
    if (editErrorEl) {
      editErrorEl.textContent = err.name === 'AbortError'
        ? 'Request timed out. Please try again.'
        : `Network error: ${err.message}`;
      editErrorEl.hidden = false;
    }
  } finally {
    clearTimeout(timeoutId);
    _memorySubmitInFlight = false;
    if (saveBtnEl) saveBtnEl.disabled = false;
  }
}

let _deleteConfirmPending = false;
let _deleteConfirmTimer = null;

/** R5: delete also goes through the in-flight guard (no double-delete). */
async function handleDelete() {
  if (_memorySubmitInFlight) return; // R5 guard (shared flag covers delete too)

  if (!_deleteConfirmPending) {
    // First tap — arm confirm
    _deleteConfirmPending = true;
    if (deleteBtnEl) {
      deleteBtnEl.textContent = 'Confirm delete?';
      deleteBtnEl.classList.add('confirming');
    }
    _deleteConfirmTimer = setTimeout(() => {
      _deleteConfirmPending = false;
      if (deleteBtnEl) {
        deleteBtnEl.textContent = 'Delete';
        deleteBtnEl.classList.remove('confirming');
      }
    }, 6000);
    return;
  }

  // Second tap — commit
  clearTimeout(_deleteConfirmTimer);
  _deleteConfirmPending = false;
  if (deleteBtnEl) {
    deleteBtnEl.textContent = 'Delete';
    deleteBtnEl.classList.remove('confirming');
  }

  if (!_currentEntry) return;
  const key = _currentEntry.key;

  _memorySubmitInFlight = true;
  if (deleteBtnEl) deleteBtnEl.disabled = true;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), MEMORY_SUBMIT_TIMEOUT_MS);

  try {
    const headers = { Authorization: `tma ${_initData}` };
    if (_currentEtag) headers['If-Match'] = _currentEtag;

    const res = await fetch(`/api/webapp/memory/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers,
      signal: abortCtrl.signal,
    });
    const data = await res.json();
    if (res.status === 200 && data.ok === true) {
      showToast('Entry deleted.', TOAST_DEFAULT_MS);
      showListView();
      await fetchEntries();
    } else if (res.status === 412) {
      showToast('Entry was modified. Refresh and try again.', TOAST_LONG_MS);
    } else {
      showToast(data.error || 'Delete failed.', TOAST_LONG_MS);
    }
  } catch (err) {
    showToast(err.name === 'AbortError' ? 'Request timed out.' : `Delete failed: ${err.message}`, TOAST_LONG_MS);
  } finally {
    clearTimeout(timeoutId);
    _memorySubmitInFlight = false;
    if (deleteBtnEl) deleteBtnEl.disabled = false;
  }
}

// ------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  listViewEl = document.getElementById('list-view');
  detailViewEl = document.getElementById('detail-view');
  searchInputEl = document.getElementById('search-input');
  newEntryBtnEl = document.getElementById('new-entry-btn');
  entryListEl = document.getElementById('entry-list');
  listLoadingEl = document.getElementById('list-loading');
  listEmptyEl = document.getElementById('list-empty');
  listErrorEl = document.getElementById('list-error');
  listRetryEl = document.getElementById('list-retry');
  detailBackEl = document.getElementById('detail-back');
  readModeEl = document.getElementById('read-mode');
  editModeEl = document.getElementById('edit-mode');
  newModeEl = document.getElementById('new-mode');
  detailKeyEl = document.getElementById('detail-key');
  detailCategoryEl = document.getElementById('detail-category');
  detailMtimeEl = document.getElementById('detail-mtime');
  detailValueEl = document.getElementById('detail-value');
  editBtnEl = document.getElementById('edit-btn');
  deleteBtnEl = document.getElementById('delete-btn');
  editKeyEl = document.getElementById('edit-key');
  editCategoryEl = document.getElementById('edit-category');
  editValueEl = document.getElementById('edit-value');
  conflictPanelEl = document.getElementById('conflict-panel');
  conflictMessageEl = document.getElementById('conflict-message');
  conflictOverwriteEl = document.getElementById('conflict-overwrite');
  conflictCancelEl = document.getElementById('conflict-cancel');
  editErrorEl = document.getElementById('edit-error');
  saveBtnEl = document.getElementById('save-btn');
  editCancelEl = document.getElementById('edit-cancel');
  newKeyEl = document.getElementById('new-key');
  newCategoryEl = document.getElementById('new-category');
  newValueEl = document.getElementById('new-value');
  newErrorEl = document.getElementById('new-error');
  newSaveBtnEl = document.getElementById('new-save-btn');
  newCancelEl = document.getElementById('new-cancel');
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

  // Search filter
  if (searchInputEl) {
    searchInputEl.addEventListener('input', () => {
      renderEntryList(getFilteredEntries(searchInputEl.value.trim()));
    });
  }

  // New entry button
  if (newEntryBtnEl) newEntryBtnEl.addEventListener('click', showNewMode);

  // Retry button
  if (listRetryEl) listRetryEl.addEventListener('click', fetchEntries);

  // Detail back button
  if (detailBackEl) detailBackEl.addEventListener('click', showListView);

  // Edit button
  if (editBtnEl) {
    editBtnEl.addEventListener('click', () => {
      if (_currentEntry) showEditMode(_currentEntry);
    });
  }

  // Delete button
  if (deleteBtnEl) deleteBtnEl.addEventListener('click', handleDelete);

  // Save button (edit mode)
  if (saveBtnEl) saveBtnEl.addEventListener('click', () => handleSave(false));

  // Edit cancel
  if (editCancelEl) {
    editCancelEl.addEventListener('click', () => {
      if (_currentEntry) showReadMode(_currentEntry);
    });
  }

  // Conflict panel
  if (conflictOverwriteEl) conflictOverwriteEl.addEventListener('click', handleSaveAnyway);
  if (conflictCancelEl) {
    conflictCancelEl.addEventListener('click', () => {
      if (conflictPanelEl) conflictPanelEl.hidden = true;
    });
  }

  // New entry save + cancel
  if (newSaveBtnEl) newSaveBtnEl.addEventListener('click', () => handleSave(true));
  if (newCancelEl) newCancelEl.addEventListener('click', showListView);

  fetchEntries();
});
