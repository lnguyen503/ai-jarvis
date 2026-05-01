/**
 * Kanban view — Jarvis v1.15.0
 *
 * NEW module. Kanban board rendering + DnD (tap-pick-tap-drop primary;
 * HTML5 DnD desktop coexisting fallback).
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *  - No native confirm().
 *
 * Mobile DnD strategy (ADR 015 D1):
 *  - Primary: tap "⋮⋮" handle to pick up a card, tap a goal column to drop.
 *  - Fallback: native HTML5 DnD for desktop coexistence.
 *
 * Optimistic UX (ADR 015 D12 + R3 + R8):
 *  - Card moves immediately on drop (optimistic).
 *  - On 412/4xx/5xx/network error: cancelPendingRollback() + full re-render from renderedItems.
 *  - R3: new pickup during in-flight rollback animation cancels the rollback; new pickup wins.
 *  - R8: re-render from renderedItems[] on both rollback AND PATCH 200.
 *
 * ES module; no framework; no bundler; no new npm deps.
 */

import { formatDueLabel } from './dates.js';

// ------------------------------------------------------------------
// Constants (R2 HIGH binding — ADR 015-revisions-after-cp1.md R2)
// ------------------------------------------------------------------

/** R2 (HIGH from CP1 v1.15.0): sessionStorage key for first-entry kanban toast.
 *  Per-tab; resets on tab close. */
const KANBAN_TUTORIAL_KEY = 'organize-kanban-tutorial-seen';

/** 8s auto-dismiss; tap-to-dismiss also works. */
const KANBAN_TUTORIAL_TOAST_MS = 8000;

/** Literal toast text — do not paraphrase (R2 binding). */
const KANBAN_TUTORIAL_TEXT = 'Tap a task card to pick it up, then tap a goal column to drop it.';

const IF_MATCH_HEADER = 'If-Match';
const ETAG_HEADER = 'ETag';
const KANBAN_MOVE_ERROR_TOAST_MS = 3000; // move-fail / conflict toast; local to kanban-view.js (F2 fix: renamed to avoid apparent duplication with app.js KANBAN_MOVE_ERROR_TOAST_MS)

// ------------------------------------------------------------------
// Module-level state
// ------------------------------------------------------------------

/** Currently picked-up card (tap-pick-tap-drop). @type {{itemId: string, sourceGoalId: string|null}|null} */
let _pickedItem = null;

/**
 * State for the in-flight rollback animation (R3).
 * @type {{itemId: string, sourceColId: string|null, frameId: number|null, timerId: number|null, cardEl: HTMLElement|null}|null}
 */
let _pendingRollback = null;

// Injected callbacks from app.js
let _getInitData = null;    // () => string
let _getRenderedItems = null; // () => item[]
let _onPatchSuccess = null; // (itemId, updatedItem, newEtag) => void
let _showToast = null;      // (msg, durationMs) => void
let _broadcastMutation = null; // ({kind, itemId, newEtag}) => void
let _container = null;      // HTMLElement for kanban board
let _toastEl = null;        // toast element for tutorial

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

/**
 * Initialize kanban view with DOM refs and callbacks.
 * Must be called once from DOMContentLoaded.
 *
 * @param {HTMLElement} container
 * @param {HTMLElement} toastEl
 * @param {object} cbs
 */
export function initKanbanView(container, toastEl, cbs) {
  _container = container;
  _toastEl = toastEl;
  _getInitData = cbs.getInitData;
  _getRenderedItems = cbs.getRenderedItems;
  _onPatchSuccess = cbs.onPatchSuccess;
  _showToast = cbs.showToast;
  _broadcastMutation = cbs.broadcastMutation;
}

// ------------------------------------------------------------------
// Tutorial toast (R2)
// ------------------------------------------------------------------

/**
 * Show the kanban tutorial toast on first entry per session.
 * R2 binding: only '1' in sessionStorage suppresses; any other value shows.
 */
export function maybeShowKanbanTutorial() {
  let raw = null;
  try { raw = sessionStorage.getItem(KANBAN_TUTORIAL_KEY); } catch (_) { /* private mode */ }
  if (raw === '1') return; // strict equality — injection probe defaults to show
  if (_showToast) _showToast(KANBAN_TUTORIAL_TEXT, KANBAN_TUTORIAL_TOAST_MS);
  try { sessionStorage.setItem(KANBAN_TUTORIAL_KEY, '1'); } catch (_) { /* private mode */ }
}

// ------------------------------------------------------------------
// Enter / exit view
// ------------------------------------------------------------------

/** Called when switching to kanban view. */
export function enterKanbanView() {
  cancelPendingRollback();
  _pickedItem = null;
  if (_container) _container.hidden = false;
}

/** Called when switching away from kanban view (D8 — view-switch clears state). */
export function exitKanbanView() {
  cancelPendingRollback(); // R3: clear any in-flight rollback on view switch
  _pickedItem = null;
  if (_container) _container.hidden = true;
}

// ------------------------------------------------------------------
// Render
// ------------------------------------------------------------------

/**
 * Main render entry point. Rebuilds the kanban board from items.
 *
 * Column structure (ADR 015 D4):
 *  - One column per active goal (sorted by created ASC).
 *  - "Standalone" column last (items with parentId === null and type !== 'goal').
 *  - Abandoned goals: no column; their children appear in Standalone.
 *
 * @param {object[]} items  — filtered items (renderedItems)
 * @param {object} [opts]
 * @param {boolean} [opts.showTutorial=false]  — show tutorial toast on first entry
 */
export function renderKanban(items, opts = {}) {
  if (!_container) return;

  // Clear
  _container.innerHTML = '';

  // Build goal columns (D4: active goals sorted by created ASC)
  const goals = items
    .filter((i) => i.type === 'goal' && i.status !== 'abandoned')
    .sort((a, b) => {
      const ca = a.created || a.frontMatter?.created || '';
      const cb = b.created || b.frontMatter?.created || '';
      return ca < cb ? -1 : ca > cb ? 1 : 0;
    });

  const goalIds = new Set(goals.map((g) => g.id));

  // Group non-goal items by parentId
  const byGoal = new Map(); // goalId → item[]
  const standalone = [];

  for (const goal of goals) {
    byGoal.set(goal.id, []);
  }

  for (const item of items) {
    if (item.type === 'goal') continue; // goals render as column headers, not cards
    const pid = item.parentId || null;
    if (pid && goalIds.has(pid)) {
      byGoal.get(pid).push(item);
    } else {
      // Orphan (parent is abandoned/missing/null) → standalone
      standalone.push(item);
    }
  }

  // Build wrapper
  const board = document.createElement('div');
  board.className = 'kanban-board';

  // Goal columns
  for (const goal of goals) {
    const col = buildColumn(goal.id, goal.title, byGoal.get(goal.id) || [], items);
    board.appendChild(col);
  }

  // Standalone column (always last — D4)
  const standaloneCol = buildColumn(null, 'Standalone', standalone, items);
  board.appendChild(standaloneCol);

  _container.appendChild(board);

  // Tutorial toast (R2)
  if (opts.showTutorial !== false) {
    maybeShowKanbanTutorial();
  }
}

/**
 * Build a single kanban column.
 *
 * @param {string|null} goalId   — null for the Standalone column
 * @param {string} title         — column header text (user-authored; textContent only)
 * @param {object[]} cards       — items in this column
 * @param {object[]} allItems    — full renderedItems (for re-render on drop)
 * @returns {HTMLElement}
 */
function buildColumn(goalId, title, cards, allItems) {
  const col = document.createElement('div');
  col.className = 'kanban-column';
  col.dataset.goalId = goalId || '__standalone__';

  // Column header
  const header = document.createElement('div');
  header.className = 'kanban-column-header';

  const titleEl = document.createElement('h3');
  titleEl.className = 'kanban-column-title';
  titleEl.textContent = title; // textContent — user-authored (decision 6)
  header.appendChild(titleEl);

  const countEl = document.createElement('span');
  countEl.className = 'kanban-column-count';
  countEl.textContent = String(cards.length);
  header.appendChild(countEl);

  col.appendChild(header);

  // Drop target: tap column header to drop picked card
  header.addEventListener('click', () => {
    if (_pickedItem) {
      handleColumnTap(goalId);
    }
  });

  // HTML5 DnD: dragover + drop on column (desktop coexistence)
  col.addEventListener('dragover', (e) => {
    e.preventDefault();
    col.classList.add('column-drop-target');
  });
  col.addEventListener('dragleave', () => {
    col.classList.remove('column-drop-target');
  });
  col.addEventListener('drop', (e) => {
    e.preventDefault();
    col.classList.remove('column-drop-target');
    const itemId = e.dataTransfer ? e.dataTransfer.getData('text/plain') : null;
    if (itemId) handleDrop(itemId, goalId, allItems);
  });

  // Card list
  const cardList = document.createElement('ul');
  cardList.className = 'kanban-card-list';

  if (cards.length === 0) {
    const placeholder = document.createElement('li');
    placeholder.className = 'kanban-column-empty';
    placeholder.textContent = '(empty — drop here to add tasks)';
    cardList.appendChild(placeholder);
  } else {
    for (const item of cards) {
      cardList.appendChild(buildCard(item, goalId));
    }
  }

  col.appendChild(cardList);

  // Also allow tap on the card list area (empty area) to drop
  cardList.addEventListener('click', (e) => {
    if (_pickedItem && e.target === cardList) {
      handleColumnTap(goalId);
    }
  });

  return col;
}

/**
 * Build a draggable item card for the kanban board.
 *
 * @param {object} item
 * @param {string|null} colGoalId  — the goal column this card is in
 * @returns {HTMLLIElement}
 */
function buildCard(item, colGoalId) {
  const isPickedUp = _pickedItem && _pickedItem.itemId === item.id;

  const li = document.createElement('li');
  li.className = 'kanban-card';
  if (isPickedUp) li.classList.add('card-pickup-selected');
  li.dataset.itemId = item.id;
  li.draggable = true;

  // Type icon + title
  const contentDiv = document.createElement('div');
  contentDiv.className = 'kanban-card-content';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'kanban-card-title';
  titleSpan.textContent = item.title || '(untitled)'; // textContent — never innerHTML

  contentDiv.appendChild(titleSpan);

  // Due date (if present)
  if (item.due) {
    const dueSpan = document.createElement('span');
    dueSpan.className = 'kanban-card-due';
    dueSpan.textContent = formatDueLabel(item.due); // textContent only
    contentDiv.appendChild(dueSpan);
  }

  // Status badge (for done items)
  if (item.status === 'done') {
    li.classList.add('card-done');
  }

  li.appendChild(contentDiv);

  // "⋮⋮" drag handle (D1.a — explicit pickup affordance)
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'kanban-drag-handle';
  handle.setAttribute('aria-label', 'Move item');
  handle.textContent = '⋮⋮';

  // Tap handle = enter pickup state (R3: cancelPendingRollback first)
  handle.addEventListener('click', (e) => {
    e.stopPropagation();
    handleCardTap(item.id, colGoalId);
  });

  li.appendChild(handle);

  // HTML5 DnD: dragstart (desktop coexistence)
  li.addEventListener('dragstart', (e) => {
    if (e.dataTransfer) e.dataTransfer.setData('text/plain', item.id);
    li.classList.add('card-dragging');
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('card-dragging');
  });

  // Card body tap: if a card is already picked, tap another card cancels pickup
  // (not drop — tap on a COLUMN drops; tap on a CARD cancels)
  li.addEventListener('click', (e) => {
    if (e.target === handle) return; // handled above
    if (_pickedItem && _pickedItem.itemId !== item.id) {
      // Cancel pickup — tap on different card cancels
      cancelPickup();
    } else if (_pickedItem && _pickedItem.itemId === item.id) {
      // Tap same card again = cancel pickup
      cancelPickup();
    } else {
      // No card picked — handle tap goes through handle click; body tap = noop for now
    }
  });

  return li;
}

// ------------------------------------------------------------------
// Pickup / drop handlers
// ------------------------------------------------------------------

/**
 * Handle tap on a card's drag handle. Enter "selected for move" state.
 * R3: new pickup immediately cancels any in-flight rollback animation.
 *
 * @param {string} itemId
 * @param {string|null} sourceColId
 */
export function handleCardTap(itemId, sourceColId) {
  cancelPendingRollback(); // R3: new pickup wins over in-flight rollback

  if (_pickedItem && _pickedItem.itemId === itemId) {
    // Tap same card again = cancel
    cancelPickup();
    return;
  }

  // Clear any previously picked card's visual state
  if (_pickedItem) {
    const prevCard = _container ? _container.querySelector(`[data-item-id="${CSS.escape(_pickedItem.itemId)}"]`) : null;
    if (prevCard) prevCard.classList.remove('card-pickup-selected');
  }

  _pickedItem = { itemId, sourceColId };

  // Apply visual state to the newly picked card
  const cardEl = _container ? _container.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`) : null;
  if (cardEl) cardEl.classList.add('card-pickup-selected');

  // Highlight all drop target columns
  if (_container) {
    _container.querySelectorAll('.kanban-column').forEach((col) => {
      col.classList.add('column-droppable');
    });
  }
}

/**
 * Cancel the current pickup without dropping.
 */
function cancelPickup() {
  if (!_pickedItem) return;
  const cardEl = _container ? _container.querySelector(`[data-item-id="${CSS.escape(_pickedItem.itemId)}"]`) : null;
  if (cardEl) cardEl.classList.remove('card-pickup-selected');

  if (_container) {
    _container.querySelectorAll('.kanban-column').forEach((col) => {
      col.classList.remove('column-droppable');
    });
  }

  _pickedItem = null;
}

/**
 * Handle tap on a column header while a card is picked.
 * Fires the PATCH to move the card to this column.
 *
 * @param {string|null} targetGoalId  — null = Standalone column
 */
export function handleColumnTap(targetGoalId) {
  if (!_pickedItem) return;
  const { itemId } = _pickedItem;
  cancelPickup(); // Clear visual state before async op
  handleDrop(itemId, targetGoalId);
}

/**
 * Execute the drop: optimistic move → PATCH with If-Match → 200/412/error paths.
 * R8: full re-render from renderedItems on both 200 and rollback paths.
 *
 * @param {string} itemId
 * @param {string|null} targetGoalId
 */
export async function handleDrop(itemId, targetGoalId) {
  const initData = _getInitData ? _getInitData() : '';
  const items = _getRenderedItems ? _getRenderedItems() : [];

  // Find the item's current ETag
  const localItem = items.find((i) => i.id === itemId);
  if (!localItem) return;

  // Same-column drop = no-op (D6 analogy)
  const currentParentId = localItem.parentId || null;
  if (currentParentId === targetGoalId) return;

  const etag = localItem.etag || localItem._etag || null;

  // Optimistic: immediately update renderedItems in app.js via callback
  if (_onPatchSuccess) {
    // Optimistic pre-call with null etag so app.js can re-render immediately
    _onPatchSuccess(itemId, { ...localItem, parentId: targetGoalId }, null, { optimistic: true });
  }

  // Clear column drop-target highlight
  if (_container) {
    _container.querySelectorAll('.kanban-column').forEach((col) => col.classList.remove('column-drop-target'));
  }

  const headers = {
    'Authorization': `tma ${initData}`,
    'Content-Type': 'application/json',
  };
  if (etag) headers[IF_MATCH_HEADER] = etag;

  try {
    const res = await fetch(`/api/webapp/items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ parentId: targetGoalId }),
    });
    const data = await res.json();

    if (res.status === 200 && data.ok === true) {
      const newEtag = res.headers.get(ETAG_HEADER);
      if (_broadcastMutation) _broadcastMutation({ kind: 'patch', itemId, newEtag: newEtag || null });
      // R8: full re-render from updated renderedItems
      if (_onPatchSuccess) _onPatchSuccess(itemId, data.item || { ...localItem, parentId: targetGoalId }, newEtag || null, { optimistic: false });
    } else if (res.status === 412 && data.code === 'PRECONDITION_FAILED') {
      // Rollback: revert optimistic move; R8: full re-render
      if (_onPatchSuccess) _onPatchSuccess(itemId, localItem, etag, { optimistic: false, rollback: true });
      startRollbackAnimation(itemId);
      if (_showToast) _showToast('Concurrent edit detected — item moved back.', KANBAN_MOVE_ERROR_TOAST_MS);
    } else {
      // Error: rollback
      if (_onPatchSuccess) _onPatchSuccess(itemId, localItem, etag, { optimistic: false, rollback: true });
      const msg = data.error || `Error ${res.status}`;
      if (_showToast) _showToast(`Move failed: ${msg}`, KANBAN_MOVE_ERROR_TOAST_MS);
    }
  } catch (err) {
    // Network error: rollback
    if (_onPatchSuccess) _onPatchSuccess(itemId, localItem, etag, { optimistic: false, rollback: true });
    if (_showToast) _showToast(`Move failed: ${err.message}`, KANBAN_MOVE_ERROR_TOAST_MS);
  }
}

// ------------------------------------------------------------------
// Rollback animation (R3)
// ------------------------------------------------------------------

/**
 * Start a 200ms rollback animation for a card.
 * R3: any new card pickup IMMEDIATELY cancels this animation.
 *
 * @param {string} itemId
 */
function startRollbackAnimation(itemId) {
  cancelPendingRollback(); // defensive: clear any prior

  const cardEl = _container ? _container.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`) : null;
  // Since we use full re-render (R8), the card may not be in the DOM at this point.
  // The re-render from app.js callback handles the visual update;
  // the animation here is a secondary visual cue on the card if it is present.

  const timerId = setTimeout(() => {
    if (cardEl) cardEl.classList.remove('rollback-animating');
    _pendingRollback = null;
  }, 200);

  if (cardEl) cardEl.classList.add('rollback-animating');

  _pendingRollback = {
    itemId,
    frameId: null,
    timerId,
    cardEl,
  };
}

/**
 * Cancel the in-flight rollback animation (R3 binding).
 * Called when a new card pickup starts — new pickup always wins.
 * The rolled-back card snaps to source position (no animation; position state only).
 */
export function cancelPendingRollback() {
  if (!_pendingRollback) return;
  const { frameId, timerId, cardEl } = _pendingRollback;
  if (frameId) cancelAnimationFrame(frameId);
  if (timerId) clearTimeout(timerId);
  if (cardEl) {
    cardEl.classList.remove('rollback-animating');
    // Snap to source: force layout settle
    cardEl.style.transition = 'none';
    requestAnimationFrame(() => { if (cardEl) cardEl.style.transition = ''; });
  }
  _pendingRollback = null;
}

// ------------------------------------------------------------------
// Expose for testing
// ------------------------------------------------------------------
export { KANBAN_TUTORIAL_KEY, KANBAN_TUTORIAL_TOAST_MS, KANBAN_TUTORIAL_TEXT };
