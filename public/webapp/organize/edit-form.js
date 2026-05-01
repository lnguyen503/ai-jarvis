/**
 * Edit form — Jarvis v1.16.0
 *
 * Extracted from app.js commit 0b (mechanical zero-logic-change relocation; R1 BLOCKING).
 * Contains: enterEditMode, exitEditMode, submitEdit, cancelEdit, parent picker UI,
 * char counters, 412 conflict UI (showConflictUI, hideConflictUI, handleConflictReload,
 * handleSaveAnyway, handleDeleteAnyway).
 *
 * v1.16.0 additions:
 *  - 3-way diff dispatch for notes/progress 412 conflicts (ADR 016 D8 + P14 + P17).
 *  - showDiffUI / hideDiffUI — top-overlay modal (P17: position:fixed; z-index:1000).
 *  - P14: when currentItem === null (server-deleted), "Take Theirs" → "Discard".
 *  - P12: inline help strings added to edit form HTML (index.html) for notes/progress textareas.
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *  - Textarea and input values set via DOM property .value — never setAttribute.
 *  - No native confirm() — inline "tap again" pattern only.
 *
 * ES module; no framework; no bundler.
 */

// v1.16.0 — 3-way diff for notes/progress 412 conflicts (ADR 016 D8)
import { diff3, MAX_DIFF_LINES, splitLines, renderDiffPanel } from './diff.js';

// ------------------------------------------------------------------
// Module-level DOM element references (populated by initEditForm)
// ------------------------------------------------------------------
let _editFormEl = null;
let _editTitleEl = null;
let _editDueEl = null;
let _editTagsEl = null;
let _editParentEl = null;
let _editNotesEl = null;
let _editProgressEl = null;
let _notesCounterEl = null;
let _progressCounterEl = null;
let _editCancelEl = null;
let _editSaveEl = null;
let _editErrorEl = null;
let _editSpinnerEl = null;
let _editBtnEl = null;
let _detailMetaEl = null;
let _conflictPanelEl = null;
let _conflictTitleEl = null;
let _conflictMessageEl = null;
let _conflictReloadEl = null;
let _conflictSaveAnywayEl = null;
let _conflictDeleteAnywayEl = null;
let _conflictCancelEl = null;

// v1.18.0 ADR 018 D1 — Coaching subsection DOM refs
let _coachIntensityEl = null; // container div#edit-coach-intensity
let _coachNudgeInfoEl = null; // p#edit-coach-nudge-info
// v1.19.0 D16 — Advanced disclosure refs (commit 16)
let _coachIntensityBadgeEl = null; // span#edit-coach-intensity-badge (always visible)

// v1.16.0 — 3-way diff overlay DOM refs (ADR 016 D8 / P17)
let _diffOverlayEl = null;
let _diffOverlayContentEl = null;
let _diffMergeAreaEl = null;
let _diffMergeTextareaEl = null;
let _diffMergeCancelEl = null;
let _diffMergeSaveEl = null;

// ------------------------------------------------------------------
// Callbacks (set by initEditForm)
// ------------------------------------------------------------------
let _onSubmit = null;    // (patchBody, etag) => void
let _onCancel = null;    // () => void
let _getInitData = null; // () => string
let _getItem = null;     // () => currentDetailItem
let _getEtag = null;     // () => currentDetailEtag
let _onSaveSuccess = null; // (updatedItem, newEtag) => void
let _onDeleteSuccess = null; // (itemId) => void
let _showToast = null;   // (msg, durationMs) => void
let _hideBcBanner = null; // () => void
let _broadcastMutation = null; // ({kind, itemId, newEtag}) => void

// ------------------------------------------------------------------
// Constants (duplicated from app.js for module isolation)
// ------------------------------------------------------------------
const ETAG_HEADER = 'ETag';
const IF_MATCH_HEADER = 'If-Match';
const FORCE_OVERRIDE_HEADER = 'X-Force-Override';
const FORCE_OVERRIDE_VALUE = '1';
const TOAST_DEFAULT_MS = 3000;
const TOAST_OVERRIDE_MS = 4000;
const TOAST_RESTORE_MS = 8000;
const NOTES_MAX = 10240;
const PROGRESS_MAX = 20480;
const CHAR_COUNTER_WARN_THRESHOLD = 0.8;
const DIFF_WARN_THRESHOLD_LINES = 3;

// ------------------------------------------------------------------
// Module-level state
// ------------------------------------------------------------------
let _editFormDirty = false;
let _progressSaveConfirmPending = false;
let _progressSaveConfirmTimer = null;
let _conflictPendingPatch = null;
let _conflictCurrentEtag = null;
let _goalsForPicker = null; // null = not loaded; [] = loaded but empty

// v1.16.0 — 3-way diff state (ADR 016 D8)
/** Which field triggered the diff (notes | progress) */
let _diffField = null;
/** The original baseline value (captured at edit-mode entry for the conflicted field) */
let _diffOriginal = null;
/** The user's pending edit value */
let _diffUserValue = null;
/** The server's current value (from 412 envelope currentItem) */
let _diffServerValue = null;
/** The pending PATCH body for Take Mine (resubmit with X-Force-Override) */
let _diffPendingPatch = null;
/** The item ID for the pending PATCH */
let _diffItemId = null;
/** Baseline notes value captured at edit-mode entry (for 3-way diff original column) */
let _baselineNotes = '';
/** Baseline progress value captured at edit-mode entry (for 3-way diff original column) */
let _baselineProgress = '';

/**
 * Initialize edit form DOM references and callbacks.
 * Must be called once from DOMContentLoaded.
 *
 * @param {object} refs   — DOM element references
 * @param {object} cbs    — callbacks
 */
export function initEditForm(refs, cbs) {
  _editFormEl = refs.editFormEl;
  _editTitleEl = refs.editTitleEl;
  _editDueEl = refs.editDueEl;
  _editTagsEl = refs.editTagsEl;
  _editParentEl = refs.editParentEl;
  _editNotesEl = refs.editNotesEl;
  _editProgressEl = refs.editProgressEl;
  _notesCounterEl = refs.notesCounterEl;
  _progressCounterEl = refs.progressCounterEl;
  _editCancelEl = refs.editCancelEl;
  _editSaveEl = refs.editSaveEl;
  _editErrorEl = refs.editErrorEl;
  _editSpinnerEl = refs.editSpinnerEl;
  _editBtnEl = refs.editBtnEl;
  _detailMetaEl = refs.detailMetaEl;
  _conflictPanelEl = refs.conflictPanelEl;
  _conflictTitleEl = refs.conflictTitleEl;
  _conflictMessageEl = refs.conflictMessageEl;
  _conflictReloadEl = refs.conflictReloadEl;
  _conflictSaveAnywayEl = refs.conflictSaveAnywayEl;
  _conflictDeleteAnywayEl = refs.conflictDeleteAnywayEl;
  _conflictCancelEl = refs.conflictCancelEl;

  // v1.18.0 ADR 018 D1 — coach intensity refs
  _coachIntensityEl = refs.coachIntensityEl || document.getElementById('edit-coach-intensity');
  _coachNudgeInfoEl = refs.coachNudgeInfoEl || document.getElementById('edit-coach-nudge-info');
  // v1.19.0 D16 — intensity badge (always visible outside Advanced disclosure)
  _coachIntensityBadgeEl = refs.coachIntensityBadgeEl || document.getElementById('edit-coach-intensity-badge');

  // Wire coach intensity pill buttons (D16: pill picker stays functional inside <details>)
  if (_coachIntensityEl) {
    _coachIntensityEl.querySelectorAll('.coach-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        _coachIntensityEl.querySelectorAll('.coach-pill').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        _editFormDirty = true;
        if (_editSaveEl) _editSaveEl.disabled = false;
        // Update badge to show current intensity (D16: badge stays visible)
        _updateCoachIntensityBadge(btn.dataset.intensity);
      });
    });
  }

  // v1.16.0 — diff overlay refs (ADR 016 D8 / P17)
  _diffOverlayEl       = refs.diffOverlayEl       || document.getElementById('diff-overlay');
  _diffOverlayContentEl = refs.diffOverlayContentEl || document.getElementById('diff-overlay-content');
  _diffMergeAreaEl     = refs.diffMergeAreaEl     || document.getElementById('diff-merge-area');
  _diffMergeTextareaEl = refs.diffMergeTextareaEl || document.getElementById('diff-merge-textarea');
  _diffMergeCancelEl   = refs.diffMergeCancelEl   || document.getElementById('diff-merge-cancel');
  _diffMergeSaveEl     = refs.diffMergeSaveEl     || document.getElementById('diff-merge-save');

  // Wire diff overlay merge buttons
  if (_diffMergeCancelEl) _diffMergeCancelEl.addEventListener('click', hideDiffMergeArea);
  if (_diffMergeSaveEl)   _diffMergeSaveEl.addEventListener('click', handleDiffMergeSave);

  _getInitData = cbs.getInitData;
  _getItem = cbs.getItem;
  _getEtag = cbs.getEtag;
  _onSaveSuccess = cbs.onSaveSuccess;
  _onDeleteSuccess = cbs.onDeleteSuccess;
  _showToast = cbs.showToast;
  _hideBcBanner = cbs.hideBcBanner;
  _broadcastMutation = cbs.broadcastMutation;

  // Wire conflict panel buttons
  if (_conflictReloadEl) _conflictReloadEl.addEventListener('click', handleConflictReload);
  if (_conflictSaveAnywayEl) _conflictSaveAnywayEl.addEventListener('click', handleSaveAnyway);
  if (_conflictDeleteAnywayEl) _conflictDeleteAnywayEl.addEventListener('click', handleDeleteAnyway);
  if (_conflictCancelEl) _conflictCancelEl.addEventListener('click', hideConflictUI);

  // Wire edit form submit
  if (_editFormEl) _editFormEl.addEventListener('submit', submitEdit);

  // Wire edit cancel
  if (_editCancelEl) _editCancelEl.addEventListener('click', cancelEdit);

  // Wire status pills
  if (_editFormEl) {
    _editFormEl.querySelectorAll('.status-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        _editFormEl.querySelectorAll('.status-pill').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        _editFormDirty = true;
        if (_editSaveEl) _editSaveEl.disabled = false;
      });
    });
  }

  // Wire dirty inputs
  const dirtyInputs = [_editTitleEl, _editDueEl, _editTagsEl];
  dirtyInputs.forEach((input) => {
    if (input) {
      input.addEventListener('input', () => {
        _editFormDirty = true;
        if (_editSaveEl) _editSaveEl.disabled = false;
      });
    }
  });

  // Wire notes char counter + dirty
  if (_editNotesEl) {
    _editNotesEl.addEventListener('input', () => {
      _editFormDirty = true;
      if (_editSaveEl) _editSaveEl.disabled = false;
      if (_notesCounterEl) updateCounter(_editNotesEl, _notesCounterEl, NOTES_MAX);
    });
  }

  // Wire progress char counter + dirty + disarm confirm on change
  if (_editProgressEl) {
    _editProgressEl.addEventListener('input', () => {
      _editFormDirty = true;
      if (_editSaveEl) {
        _editSaveEl.disabled = false;
        if (_progressSaveConfirmPending) {
          _progressSaveConfirmPending = false;
          if (_progressSaveConfirmTimer) {
            clearTimeout(_progressSaveConfirmTimer);
            _progressSaveConfirmTimer = null;
          }
          _editSaveEl.textContent = 'Save';
        }
      }
      if (_progressCounterEl) updateCounter(_editProgressEl, _progressCounterEl, PROGRESS_MAX);
    });
  }

  // Wire parent picker change
  if (_editParentEl) {
    _editParentEl.addEventListener('change', () => {
      _editFormDirty = true;
      if (_editSaveEl) _editSaveEl.disabled = false;
    });
  }
}

/**
 * Reset the goals-for-picker cache (called when returning to list view).
 */
export function clearPickerCache() {
  _goalsForPicker = null;
}

/**
 * Fetch active goals for the parent picker (exported for bulk-reparent in app.js).
 * Cached per detail-session; cleared via clearPickerCache() on list nav.
 */
export async function fetchGoalsForPicker(getInitData) {
  if (_goalsForPicker !== null) return;
  const initData = getInitData ? getInitData() : (_getInitData ? _getInitData() : '');
  if (!initData) { _goalsForPicker = []; return; }
  try {
    const res = await fetch('/api/webapp/items?type=goal&status=active', {
      method: 'GET',
      headers: { Authorization: `tma ${initData}` },
    });
    const data = await res.json();
    if (data.ok === true && Array.isArray(data.items)) {
      _goalsForPicker = data.items.map((g) => ({ id: g.id, title: g.title }));
    } else {
      _goalsForPicker = [];
    }
  } catch {
    _goalsForPicker = [];
  }
}

/**
 * Get the cached goals-for-picker array (null = not yet loaded).
 * Used by app.js bulk-reparent UI.
 * @returns {Array<{id: string, title: string}>|null}
 */
export function getGoalsForPicker() {
  return _goalsForPicker;
}

// ------------------------------------------------------------------
// Char counter helper
// ------------------------------------------------------------------
function updateCounter(textareaEl, counterEl, max) {
  const len = textareaEl.value.length;
  counterEl.textContent = `${len} / ${max}`;
  counterEl.classList.toggle('warn', len >= max * CHAR_COUNTER_WARN_THRESHOLD && len < max);
  counterEl.classList.toggle('error', len >= max);
}

// ------------------------------------------------------------------
// Line count helper (for progress diff warning — R3)
// ------------------------------------------------------------------
function countLines(s) {
  return (s ?? '').split('\n').filter((l) => l.trim().length > 0).length;
}

// ------------------------------------------------------------------
// Coach intensity badge helper (v1.19.0 D16 — commit 16)
// ------------------------------------------------------------------

/**
 * Update the always-visible coach intensity badge outside the <details> disclosure.
 * Uses textContent only — never innerHTML (ADR 009 D6).
 *
 * @param {string} intensity  — 'off' | 'gentle' | 'moderate' | 'persistent'
 */
function _updateCoachIntensityBadge(intensity) {
  if (!_coachIntensityBadgeEl) return;
  // v1.19.0 D1: 'auto' is the implicit default — hide badge entirely so the
  // UI stays uncluttered for users who never touched coaching. Show badge
  // only for explicit intensities (off / gentle / moderate / persistent).
  const value = intensity || 'auto';
  if (value === 'auto') {
    _coachIntensityBadgeEl.textContent = '';
    _coachIntensityBadgeEl.hidden = true;
    _coachIntensityBadgeEl.dataset.intensity = 'auto';
    return;
  }
  // textContent only — never innerHTML (security invariant ADR 009 D6)
  _coachIntensityBadgeEl.textContent = value;
  _coachIntensityBadgeEl.hidden = false;
  // Mirror intensity on data-intensity attribute so CSS can style it
  _coachIntensityBadgeEl.dataset.intensity = value;
}

// ------------------------------------------------------------------
// Parent picker
// ------------------------------------------------------------------

/**
 * Populate the parent picker <select> for the current item.
 * Uses textContent (never innerHTML) for goal titles — XSS guard.
 * Filters out the current item itself (R2 self-id guard).
 */
export function renderParentPicker() {
  const currentDetailItem = _getItem ? _getItem() : null;
  if (!_editParentEl || !currentDetailItem) return;
  // Clear existing options safely
  _editParentEl.innerHTML = '';

  // "(none)" option — always first
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(none)';
  _editParentEl.appendChild(noneOpt);

  if (Array.isArray(_goalsForPicker)) {
    for (const goal of _goalsForPicker) {
      // R2: skip self-reference
      if (goal.id === currentDetailItem.id) continue;
      const opt = document.createElement('option');
      opt.value = goal.id;
      opt.textContent = goal.title; // textContent only — never innerHTML (decision 6)
      _editParentEl.appendChild(opt);
    }
  }

  // Set current selection via DOM .value (never setAttribute — D15/RA1)
  _editParentEl.value = currentDetailItem.parentId ?? '';
}

// ------------------------------------------------------------------
// Enter / exit edit mode
// ------------------------------------------------------------------

/**
 * Enter edit mode for the current detail item.
 * Populates form fields via DOM property .value (never setAttribute — D15/RA1).
 */
export function enterEditMode(item) {
  if (!item) return;

  // Populate inputs via .value (DOM property, NOT setAttribute — D15 + RA1)
  if (_editTitleEl) _editTitleEl.value = item.title || '';
  if (_editDueEl) _editDueEl.value = item.due || '';
  if (_editTagsEl) _editTagsEl.value = Array.isArray(item.tags) ? item.tags.join(', ') : '';

  // Populate notes and progress textareas
  // v1.16.0: capture baseline values for 3-way diff (ADR 016 D8)
  _baselineNotes    = item.notes    || '';
  _baselineProgress = item.progress || '';

  if (_editNotesEl) {
    _editNotesEl.value = item.notes || '';
    if (_notesCounterEl) updateCounter(_editNotesEl, _notesCounterEl, NOTES_MAX);
  }
  if (_editProgressEl) {
    _editProgressEl.value = item.progress || '';
    if (_progressCounterEl) updateCounter(_editProgressEl, _progressCounterEl, PROGRESS_MAX);
  }

  // Status pills: set .active on the matching pill, remove from others
  if (_editFormEl) {
    _editFormEl.querySelectorAll('.status-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.status === item.status);
    });
  }

  // v1.18.0 ADR 018 D1: coach intensity pill picker + nudge info
  // v1.19.0 D16: update always-visible badge to reflect current intensity (commit 16)
  // v1.19.0 D1: 'auto' is the implicit default for items with no explicit intensity
  if (_coachIntensityEl) {
    const intensity = item.coachIntensity || 'auto';
    _coachIntensityEl.querySelectorAll('.coach-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.intensity === intensity);
    });
    _updateCoachIntensityBadge(intensity);
  }
  if (_coachNudgeInfoEl) {
    const count = item.coachNudgeCount ?? 0;
    _coachNudgeInfoEl.textContent = count > 0
      ? `${count} nudge${count === 1 ? '' : 's'} sent`
      : 'No nudges sent yet';
  }

  // Reset form state
  _editFormDirty = false;
  _progressSaveConfirmPending = false;
  if (_progressSaveConfirmTimer) {
    clearTimeout(_progressSaveConfirmTimer);
    _progressSaveConfirmTimer = null;
  }
  if (_editSaveEl) {
    _editSaveEl.disabled = true;
    _editSaveEl.textContent = 'Save';
  }
  if (_editErrorEl) {
    _editErrorEl.textContent = '';
    _editErrorEl.hidden = true;
  }
  if (_editSpinnerEl) _editSpinnerEl.hidden = true;

  // Show form, hide read-only meta
  if (_editFormEl) _editFormEl.hidden = false;
  if (_detailMetaEl) _detailMetaEl.hidden = true;
  if (_editBtnEl) _editBtnEl.hidden = true;

  // Fetch goals for parent picker (async; renders when ready)
  fetchGoalsForPicker().then(() => renderParentPicker());
}

/** Exit edit mode — restore read-only view without changing data. */
export function exitEditMode() {
  // Disarm any pending progress save confirmation
  _progressSaveConfirmPending = false;
  if (_progressSaveConfirmTimer) {
    clearTimeout(_progressSaveConfirmTimer);
    _progressSaveConfirmTimer = null;
  }
  if (_editSaveEl) _editSaveEl.textContent = 'Save';

  if (_editFormEl) _editFormEl.hidden = true;
  if (_detailMetaEl) _detailMetaEl.hidden = false;
  if (_editBtnEl) _editBtnEl.hidden = false;
  if (_editErrorEl) {
    _editErrorEl.textContent = '';
    _editErrorEl.hidden = true;
  }
  if (_editSpinnerEl) _editSpinnerEl.hidden = true;
  _editFormDirty = false;
  // v1.14.4: hide any active conflict panel when exiting edit mode
  hideConflictUI();
}

/** Cancel edit — restore form from currentDetailItem, exit edit mode. */
export function cancelEdit() {
  const currentDetailItem = _getItem ? _getItem() : null;
  if (currentDetailItem) {
    // Restore inputs from last-known state
    if (_editTitleEl) _editTitleEl.value = currentDetailItem.title || '';
    if (_editDueEl) _editDueEl.value = currentDetailItem.due || '';
    if (_editTagsEl) _editTagsEl.value = Array.isArray(currentDetailItem.tags)
      ? currentDetailItem.tags.join(', ')
      : '';
    // Restore notes + progress
    if (_editNotesEl) _editNotesEl.value = currentDetailItem.notes || '';
    if (_editProgressEl) _editProgressEl.value = currentDetailItem.progress || '';
    // Restore parent picker
    if (_editParentEl) _editParentEl.value = currentDetailItem.parentId ?? '';
    // v1.18.0 ADR 018 D1: restore coach intensity pill
    // v1.19.0 D1: 'auto' is the implicit default for items with no explicit intensity
    if (_coachIntensityEl) {
      const intensity = currentDetailItem.coachIntensity || 'auto';
      _coachIntensityEl.querySelectorAll('.coach-pill').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.intensity === intensity);
      });
      _updateCoachIntensityBadge(intensity);
    }
  }
  exitEditMode();
}

// ------------------------------------------------------------------
// Submit edit
// ------------------------------------------------------------------

/**
 * Submit the edit form. Builds a PATCH body from only the changed fields.
 * Non-optimistic — spinner while in flight; error inline in form on failure.
 *
 * R3 progress diff confirm: morphs Save button into "Tap again to confirm".
 *
 * @param {Event} e
 */
export function submitEdit(e) {
  e.preventDefault();
  const currentDetailItem = _getItem ? _getItem() : null;
  const initData = _getInitData ? _getInitData() : '';
  if (!currentDetailItem || !initData) return;

  // --- Build patch: only include fields that changed ---
  const patch = {};

  // Title
  const newTitle = _editTitleEl ? _editTitleEl.value.trim() : null;
  if (newTitle !== null && newTitle !== (currentDetailItem.title || '').trim()) {
    patch.title = newTitle;
  }

  // Due
  const newDue = _editDueEl ? (_editDueEl.value || null) : null;
  const oldDue = currentDetailItem.due || null;
  if (newDue !== oldDue) {
    patch.due = newDue;
  }

  // Status — read from active status pill
  let newStatus = null;
  if (_editFormEl) {
    const activePill = _editFormEl.querySelector('.status-pill.active');
    if (activePill) newStatus = activePill.dataset.status;
  }
  if (newStatus && newStatus !== currentDetailItem.status) {
    patch.status = newStatus;
  }

  // Tags — split + trim only. Client does NOT normalize tag content.
  const rawTags = _editTagsEl ? _editTagsEl.value : '';
  const newTags = rawTags.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  const oldTags = Array.isArray(currentDetailItem.tags) ? [...currentDetailItem.tags] : [];
  const tagsChanged =
    newTags.length !== oldTags.length ||
    newTags.some((t, i) => t !== oldTags[i]);
  if (tagsChanged) {
    patch.tags = newTags;
  }

  // Notes: include only if changed
  if (_editNotesEl) {
    const newNotes = _editNotesEl.value;
    const oldNotes = currentDetailItem.notes || '';
    if (newNotes !== oldNotes) {
      patch.notes = newNotes;
    }
  }

  // Progress: include only if changed; R3 diff confirm
  if (_editProgressEl) {
    const newProgress = _editProgressEl.value;
    const oldProgress = currentDetailItem.progress || '';
    if (newProgress !== oldProgress) {
      // R3: check if the user is removing a significant number of lines
      const delta = countLines(newProgress) - countLines(oldProgress);
      if (delta < -DIFF_WARN_THRESHOLD_LINES) {
        if (!_progressSaveConfirmPending) {
          _progressSaveConfirmPending = true;
          const removed = -delta;
          if (_editSaveEl) {
            _editSaveEl.textContent = `Remove ${removed} entries? Tap again`;
            _editSaveEl.disabled = false;
          }
          if (_progressSaveConfirmTimer) clearTimeout(_progressSaveConfirmTimer);
          _progressSaveConfirmTimer = setTimeout(() => {
            _progressSaveConfirmPending = false;
            _progressSaveConfirmTimer = null;
            if (_editSaveEl) {
              _editSaveEl.textContent = 'Save';
              _editSaveEl.disabled = !_editFormDirty;
            }
          }, TOAST_OVERRIDE_MS);
          return; // Wait for second tap
        } else {
          // Second tap — user confirmed; disarm and proceed
          _progressSaveConfirmPending = false;
          if (_progressSaveConfirmTimer) {
            clearTimeout(_progressSaveConfirmTimer);
            _progressSaveConfirmTimer = null;
          }
          if (_editSaveEl) _editSaveEl.textContent = 'Save';
        }
      }
      patch.progress = newProgress;
    }
  }

  // v1.14.5 — parentId: include only if changed
  if (_editParentEl) {
    const pickerValue = _editParentEl.value || null; // '' → null
    const oldParentId = currentDetailItem.parentId ?? null;
    if (pickerValue !== oldParentId) {
      patch.parentId = pickerValue;
    }
  }

  // v1.18.0 ADR 018 D1: coachIntensity — include if changed
  // v1.19.0 D1: 'auto' is the implicit default for items with no explicit intensity
  if (_coachIntensityEl) {
    const activeCoachPill = _coachIntensityEl.querySelector('.coach-pill.active');
    const newIntensity = activeCoachPill ? activeCoachPill.dataset.intensity : 'auto';
    const oldIntensity = currentDetailItem.coachIntensity || 'auto';
    if (newIntensity !== oldIntensity) {
      patch.coachIntensity = newIntensity;
    }
  }

  // Nothing changed
  if (Object.keys(patch).length === 0) {
    exitEditMode();
    return;
  }

  // Show spinner, hide errors
  if (_editSpinnerEl) _editSpinnerEl.hidden = false;
  if (_editErrorEl) {
    _editErrorEl.textContent = '';
    _editErrorEl.hidden = true;
  }
  if (_editSaveEl) _editSaveEl.disabled = true;

  const currentEtag = _getEtag ? _getEtag() : null;
  const headers = {
    'Authorization': `tma ${initData}`,
    'Content-Type': 'application/json',
  };
  if (currentEtag !== null) {
    headers[IF_MATCH_HEADER] = currentEtag;
  }

  const originalPatch = patch;
  const itemId = currentDetailItem.id;

  fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(originalPatch),
  })
    .then((res) => res.json().then((data) => ({ status: res.status, data, res })))
    .then(({ status, data, res: fetchRes }) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;

      if (status === 200 && data.ok === true) {
        const newEtag = fetchRes.headers.get(ETAG_HEADER);
        if (_hideBcBanner) _hideBcBanner();
        if (_broadcastMutation) _broadcastMutation({ kind: 'patch', itemId, newEtag: newEtag || null });
        const updated = data.item || { ...currentDetailItem, ...originalPatch };
        if (_onSaveSuccess) _onSaveSuccess(updated, newEtag || null);
        if (_showToast) _showToast('Saved', TOAST_DEFAULT_MS);
      } else if (status === 412 && data.code === 'PRECONDITION_FAILED') {
        if (_editSpinnerEl) _editSpinnerEl.hidden = true;
        if (_editSaveEl) _editSaveEl.disabled = false;

        // v1.16.0 — 3-way diff dispatch (ADR 016 D8):
        // If the conflicted field is notes OR progress AND content is within MAX_DIFF_LINES,
        // show the 3-way diff modal (P17 top overlay). Otherwise fall back to the v1.14.4
        // R1 2-button conflict UI.
        const conflictedField = 'notes' in originalPatch ? 'notes'
          : 'progress' in originalPatch ? 'progress'
          : null;

        if (conflictedField) {
          const userText     = originalPatch[conflictedField] || '';
          const serverText   = (data.currentItem && data.currentItem[conflictedField]) || '';
          const originalText = conflictedField === 'notes' ? _baselineNotes : _baselineProgress;
          const userLineCount   = userText.split('\n').length;
          const serverLineCount = serverText.split('\n').length;
          const origLineCount   = originalText.split('\n').length;

          if (userLineCount > 0 && userLineCount <= MAX_DIFF_LINES &&
              serverLineCount <= MAX_DIFF_LINES && origLineCount <= MAX_DIFF_LINES) {
            // 3-way diff path (P17)
            showDiffUI({
              field:       conflictedField,
              original:    originalText,
              user:        userText,
              server:      serverText,
              patch:       originalPatch,
              itemId,
              currentItem: data.currentItem,
            });
          } else {
            // Fallback to v1.14.4 R1 2-button conflict UI (content too large)
            showConflictUI('patch', data.currentItem, data.currentEtag, originalPatch);
          }
        } else {
          // Short fields (title / due / status / tags) — always use 2-button UI
          showConflictUI('patch', data.currentItem, data.currentEtag, originalPatch);
        }
      } else if (status >= 400 && status < 500) {
        const msg = data.error || `Error ${data.code || status}`;
        if (_editErrorEl) {
          _editErrorEl.textContent = msg; // textContent only (Decision 6)
          _editErrorEl.hidden = false;
        }
        if (_editSaveEl) _editSaveEl.disabled = false;
      } else {
        const msg = data.error || `Server error (${status})`;
        if (_editErrorEl) {
          _editErrorEl.textContent = `Save failed: ${msg}`;
          _editErrorEl.hidden = false;
        }
        if (_editSaveEl) _editSaveEl.disabled = false;
      }
    })
    .catch((err) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;
      if (_editErrorEl) {
        _editErrorEl.textContent = `Save failed: ${err.message}`;
        _editErrorEl.hidden = false;
      }
      if (_editSaveEl) _editSaveEl.disabled = false;
    });
}

// ------------------------------------------------------------------
// Conflict UI (ADR 012 D5/D12/R9)
// ------------------------------------------------------------------

/**
 * Show the inline conflict panel.
 *
 * @param {'patch'|'delete'} kind
 * @param {object|null} currentItem
 * @param {string|null} currentEtag
 * @param {object|null} originalChange
 */
export function showConflictUI(kind, currentItem, currentEtag, originalChange) {
  if (!_conflictPanelEl) return;

  _conflictPendingPatch = originalChange;
  _conflictCurrentEtag = currentEtag;

  const titleText = currentItem ? currentItem.title || '(untitled)' : 'this item';
  if (_conflictTitleEl) _conflictTitleEl.textContent = 'Conflict';
  if (_conflictMessageEl) {
    if (kind === 'patch') {
      _conflictMessageEl.textContent = `"${titleText}" changed since you opened it. Reload to see the latest, Save anyway to overwrite, or Cancel to keep editing.`;
    } else {
      _conflictMessageEl.textContent = `"${titleText}" changed since you opened it. Cancel deletion or Delete anyway?`;
    }
  }

  // Show/hide buttons per kind (R9)
  if (_conflictReloadEl) _conflictReloadEl.hidden = (kind !== 'patch');
  if (_conflictSaveAnywayEl) _conflictSaveAnywayEl.hidden = (kind !== 'patch');
  if (_conflictDeleteAnywayEl) _conflictDeleteAnywayEl.hidden = (kind !== 'delete');
  if (_conflictCancelEl) _conflictCancelEl.hidden = false;

  _conflictPanelEl.hidden = false;
}

/** Hide the conflict panel and reset state. */
export function hideConflictUI() {
  if (_conflictPanelEl) _conflictPanelEl.hidden = true;
  _conflictPendingPatch = null;
  _conflictCurrentEtag = null;
}

/** Expose conflict panel el for app.js checks (e.g., BC message suppression). */
export function getConflictPanelEl() {
  return _conflictPanelEl;
}

/**
 * Reload handler in conflict UI.
 */
function handleConflictReload() {
  const currentDetailItem = _getItem ? _getItem() : null;
  hideConflictUI();
  if (currentDetailItem && _onSaveSuccess) {
    // Trigger a full re-fetch of the detail item
    _onSaveSuccess(null, null, { reload: true, itemId: currentDetailItem.id });
  }
}

/**
 * Save Anyway handler in conflict UI (D5).
 * Re-sends PATCH WITHOUT If-Match, WITH X-Force-Override: 1.
 */
function handleSaveAnyway() {
  const currentDetailItem = _getItem ? _getItem() : null;
  const initData = _getInitData ? _getInitData() : '';
  if (!currentDetailItem || !initData || !_conflictPendingPatch) {
    hideConflictUI();
    return;
  }

  const itemId = currentDetailItem.id;
  const patch = _conflictPendingPatch;
  hideConflictUI();

  if (_editSpinnerEl) _editSpinnerEl.hidden = false;
  if (_editSaveEl) _editSaveEl.disabled = true;

  const headers = {
    'Authorization': `tma ${initData}`,
    'Content-Type': 'application/json',
    [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
    // Intentionally NO If-Match header — Save Anyway bypasses conflict check (D5)
  };

  fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  })
    .then((res) => res.json().then((data) => ({ status: res.status, data, res })))
    .then(({ status, data, res: fetchRes }) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;
      if (status === 200 && data.ok === true) {
        const newEtag = fetchRes.headers.get(ETAG_HEADER);
        if (_hideBcBanner) _hideBcBanner();
        if (_broadcastMutation) _broadcastMutation({ kind: 'patch', itemId, newEtag: newEtag || null });
        const updated = data.item || { ...currentDetailItem, ...patch };
        if (_onSaveSuccess) _onSaveSuccess(updated, newEtag || null);
        if (_showToast) _showToast('Saved. Note: another change was overridden.', TOAST_OVERRIDE_MS);
      } else {
        const msg = data.error || `Save failed (${status})`;
        if (_editErrorEl) {
          _editErrorEl.textContent = msg;
          _editErrorEl.hidden = false;
        }
        if (_editSaveEl) _editSaveEl.disabled = false;
      }
    })
    .catch((err) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;
      if (_editErrorEl) {
        _editErrorEl.textContent = `Save failed: ${err.message}`;
        _editErrorEl.hidden = false;
      }
      if (_editSaveEl) _editSaveEl.disabled = false;
    });
}

/**
 * Delete Anyway handler in conflict UI (R9).
 * Re-sends DELETE WITHOUT If-Match, WITH X-Force-Override: 1.
 */
function handleDeleteAnyway() {
  const currentDetailItem = _getItem ? _getItem() : null;
  const initData = _getInitData ? _getInitData() : '';
  if (!currentDetailItem || !initData) {
    hideConflictUI();
    return;
  }

  const itemId = currentDetailItem.id;
  hideConflictUI();

  const headers = {
    'Authorization': `tma ${initData}`,
    [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
    // Intentionally NO If-Match header — Delete Anyway bypasses conflict check (R9)
  };

  fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    headers,
  })
    .then((res) => res.json().then((data) => ({ status: res.status, data, res })))
    .then(({ status, data, res: fetchRes }) => {
      if (status === 200 && data.ok === true) {
        const newEtag = fetchRes.headers.get(ETAG_HEADER);
        if (_broadcastMutation) _broadcastMutation({ kind: 'delete', itemId, newEtag: newEtag || null });
        if (_onDeleteSuccess) _onDeleteSuccess(itemId);
        if (_showToast) _showToast(
          `Deleted. Restore via Telegram chat: /organize restore ${itemId}`,
          TOAST_RESTORE_MS,
        );
      } else {
        const msg = data.error || `Delete failed (${status})`;
        if (_showToast) _showToast(`Delete failed: ${msg}`, TOAST_OVERRIDE_MS);
      }
    })
    .catch((err) => {
      if (_showToast) _showToast(`Delete failed: ${err.message}`, TOAST_OVERRIDE_MS);
    });
}

// ------------------------------------------------------------------
// v1.16.0 — 3-way diff UI (ADR 016 D8 + P14 + P17)
// ------------------------------------------------------------------

/**
 * Show the 3-way diff overlay modal for a notes/progress 412 conflict.
 *
 * P14: when currentItem === null (server-deleted item), render server column as
 * "[Item deleted]" placeholder and relabel "Take Theirs" → "Discard".
 * "Take Mine" remains as "Save anyway" (re-PATCH with X-Force-Override).
 *
 * @param {{field, original, user, server, patch, itemId, currentItem}} opts
 */
function showDiffUI(opts) {
  if (!_diffOverlayEl || !_diffOverlayContentEl) return;

  _diffField       = opts.field;
  _diffOriginal    = opts.original;
  _diffUserValue   = opts.user;
  _diffServerValue = opts.server;
  _diffPendingPatch = opts.patch;
  _diffItemId      = opts.itemId;

  // P14: item deleted server-side
  const serverDeleted = opts.currentItem === null;
  const effectiveServer = serverDeleted ? '' : opts.server;

  // Compute diff (may return { fallback: true } if too large)
  const result = diff3(opts.original, opts.user, effectiveServer);

  // Clear previous content
  _diffOverlayContentEl.innerHTML = ''; // safe clear of our own container

  const panel = renderDiffPanel(result, {
    onTakeMine:      handleDiffTakeMine,
    onTakeTheirs:    handleDiffTakeTheirs,
    onMergeManually: handleDiffMergeManually,
  });

  // P14: relabel "Take Theirs" → "Discard" when server item is deleted
  if (serverDeleted) {
    const theirsBtn = panel.querySelector('.diff-take-theirs');
    if (theirsBtn) theirsBtn.textContent = 'Discard';
    // Also add a visual hint
    const hint = document.createElement('p');
    hint.style.color = '#dc2626';
    hint.style.fontSize = '0.82rem';
    hint.style.marginBottom = '0.5rem';
    hint.textContent = '[Item deleted by another session. "Discard" abandons your edit.]';
    _diffOverlayContentEl.appendChild(hint);
  }

  _diffOverlayContentEl.appendChild(panel);

  // Show overlay (P17 — position: fixed; z-index: 1000)
  if (_diffMergeAreaEl) _diffMergeAreaEl.hidden = true;
  _diffOverlayEl.hidden = false;
}

/** Hide the diff overlay and reset diff state. */
function hideDiffUI() {
  if (_diffOverlayEl) _diffOverlayEl.hidden = true;
  if (_diffMergeAreaEl) _diffMergeAreaEl.hidden = true;
  _diffField = null;
  _diffOriginal = null;
  _diffUserValue = null;
  _diffServerValue = null;
  _diffPendingPatch = null;
  _diffItemId = null;
}

/** Handle "Take Mine" — re-PATCH with user's pending value + X-Force-Override: 1 */
function handleDiffTakeMine() {
  if (!_diffPendingPatch || !_diffItemId) { hideDiffUI(); return; }
  const initData = _getInitData ? _getInitData() : '';
  if (!initData) { hideDiffUI(); return; }

  hideDiffUI();

  const headers = {
    'Authorization': `tma ${initData}`,
    'Content-Type': 'application/json',
    [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
  };

  if (_editSpinnerEl) _editSpinnerEl.hidden = false;
  const itemId = _diffItemId;
  const patch  = _diffPendingPatch;

  fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  })
    .then((res) => res.json().then((data) => ({ status: res.status, data, res: res })))
    .then(({ status, data, res: fetchRes }) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;
      if (status === 200 && data.ok === true) {
        const newEtag = fetchRes.headers.get(ETAG_HEADER);
        const currentDetailItem = _getItem ? _getItem() : null;
        if (_hideBcBanner) _hideBcBanner();
        if (_broadcastMutation) _broadcastMutation({ kind: 'patch', itemId, newEtag: newEtag || null });
        const updated = data.item || { ...(currentDetailItem || {}), ...patch };
        if (_onSaveSuccess) _onSaveSuccess(updated, newEtag || null);
        if (_showToast) _showToast('Saved (your version)', TOAST_DEFAULT_MS);
      } else {
        const msg = data.error || `Save failed (${status})`;
        if (_editErrorEl) {
          _editErrorEl.textContent = msg;
          _editErrorEl.hidden = false;
        }
        if (_editSaveEl) _editSaveEl.disabled = false;
      }
    })
    .catch((err) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;
      if (_editErrorEl) {
        _editErrorEl.textContent = `Save failed: ${err.message}`;
        _editErrorEl.hidden = false;
      }
      if (_editSaveEl) _editSaveEl.disabled = false;
    });
}

/**
 * Handle "Take Theirs" (or "Discard" when server-deleted).
 * Re-fetches the item from the server; resets edit form.
 */
function handleDiffTakeTheirs() {
  const currentDetailItem = _getItem ? _getItem() : null;
  hideDiffUI();
  // Trigger a full re-fetch (same as handleConflictReload)
  if (currentDetailItem && _onSaveSuccess) {
    _onSaveSuccess(null, null, { reload: true, itemId: currentDetailItem.id });
  }
}

/** Handle "Save Manually-Merged" — show a textarea pre-populated with server value. */
function handleDiffMergeManually() {
  if (!_diffMergeAreaEl || !_diffMergeTextareaEl) return;
  // Pre-populate with server value so user can hand-merge
  _diffMergeTextareaEl.value = _diffServerValue || ''; // .value — never setAttribute
  _diffMergeAreaEl.hidden = false;
  _diffMergeTextareaEl.focus();
}

/** Cancel the manual merge area — return to diff panel. */
function hideDiffMergeArea() {
  if (_diffMergeAreaEl) _diffMergeAreaEl.hidden = true;
}

/**
 * Save the manually-merged content.
 * Sends PATCH with X-Force-Override: 1 and the textarea's merged value.
 */
function handleDiffMergeSave() {
  if (!_diffMergeTextareaEl || !_diffPendingPatch || !_diffItemId) {
    hideDiffUI();
    return;
  }
  const initData = _getInitData ? _getInitData() : '';
  if (!initData) { hideDiffUI(); return; }

  // Build patch with the merged value for the conflicted field
  const mergedValue = _diffMergeTextareaEl.value; // .value — DOM property
  const mergedPatch = { ..._diffPendingPatch, [_diffField]: mergedValue };
  const itemId = _diffItemId;

  hideDiffUI();

  const headers = {
    'Authorization': `tma ${initData}`,
    'Content-Type': 'application/json',
    [FORCE_OVERRIDE_HEADER]: FORCE_OVERRIDE_VALUE,
  };

  if (_editSpinnerEl) _editSpinnerEl.hidden = false;

  fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(mergedPatch),
  })
    .then((res) => res.json().then((data) => ({ status: res.status, data, res: res })))
    .then(({ status, data, res: fetchRes }) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;
      if (status === 200 && data.ok === true) {
        const newEtag = fetchRes.headers.get(ETAG_HEADER);
        const currentDetailItem = _getItem ? _getItem() : null;
        if (_hideBcBanner) _hideBcBanner();
        if (_broadcastMutation) _broadcastMutation({ kind: 'patch', itemId, newEtag: newEtag || null });
        const updated = data.item || { ...(currentDetailItem || {}), ...mergedPatch };
        if (_onSaveSuccess) _onSaveSuccess(updated, newEtag || null);
        if (_showToast) _showToast('Saved (merged)', TOAST_DEFAULT_MS);
      } else {
        const msg = data.error || `Save failed (${status})`;
        if (_editErrorEl) {
          _editErrorEl.textContent = msg;
          _editErrorEl.hidden = false;
        }
        if (_editSaveEl) _editSaveEl.disabled = false;
      }
    })
    .catch((err) => {
      if (_editSpinnerEl) _editSpinnerEl.hidden = true;
      if (_editErrorEl) {
        _editErrorEl.textContent = `Save failed: ${err.message}`;
        _editErrorEl.hidden = false;
      }
      if (_editSaveEl) _editSaveEl.disabled = false;
    });
}
