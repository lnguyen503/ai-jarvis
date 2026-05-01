/**
 * Calendar month view — Jarvis v1.19.0
 *
 * Extracted from calendar-view.js (commit 0c — mechanical zero-logic-change).
 * Contains: renderMonth (6-week × 7-day grid) + buildItemPill (shared).
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *
 * Calendar-date semantics (ADR 015 D3 + dates.js): UTC accessors only.
 *
 * ES module; no framework; no bundler; no new npm deps.
 */

import { parseISO, formatISO, isSameDay, today, monthGrid, formatDowLabel,
         noonOfDayUTC } from './dates.js';

// Injected by calendar-view.js dispatcher via setMonthViewCallbacks
let _getHandleCalendarDnD = null;

/** @param {Function} fn  — () => handleCalendarDnD */
export function setMonthViewCallbacks(fn) {
  _getHandleCalendarDnD = fn;
}

// ------------------------------------------------------------------
// Constants (duplicated from calendar-view.js for module isolation)
// ------------------------------------------------------------------
const FIRST_DAY_OF_WEEK = 1; // Monday

// ------------------------------------------------------------------
// Month view render
// ------------------------------------------------------------------

/**
 * Render a 6-week × 7-day grid for the current month.
 *
 * @param {HTMLElement} board
 * @param {object[]} items  — only items with `due` (pre-filtered)
 * @param {Date} currentDate  — UTC Date anchor for the view
 */
export function renderMonth(board, items, currentDate) {
  board.className = 'calendar-board calendar-month';

  // v1.19.0 D5: empty state when no items have due dates in this month
  const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const todayDate = today();

  // Day-of-week header row
  const dowRow = document.createElement('div');
  dowRow.className = 'calendar-dow-row';
  for (let i = 0; i < 7; i++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-dow-cell';
    cell.textContent = formatDowLabel(i, locale, FIRST_DAY_OF_WEEK);
    dowRow.appendChild(cell);
  }
  board.appendChild(dowRow);

  // Grid
  const grid = document.createElement('div');
  grid.className = 'calendar-month-grid';

  const cells = monthGrid(currentDate, FIRST_DAY_OF_WEEK);

  for (const cell of cells) {
    const cellEl = document.createElement('div');
    cellEl.className = 'calendar-day-cell';
    if (!cell.inMonth) cellEl.classList.add('cell-other-month');
    if (isSameDay(cell.date, todayDate)) cellEl.classList.add('cell-today');

    const isoDate = formatISO(cell.date);
    cellEl.dataset.cellDate = isoDate;

    // Day number
    const dayNum = document.createElement('span');
    dayNum.className = 'calendar-day-num';
    dayNum.textContent = String(cell.date.getUTCDate());
    cellEl.appendChild(dayNum);

    // Items for this day (up to 3; +N more)
    const dayItems = items.filter((i) => i.due === isoDate);
    const visible = dayItems.slice(0, 3);
    const overflow = dayItems.length - 3;

    for (const item of visible) {
      const pill = buildItemPill(item);
      cellEl.appendChild(pill);
    }
    if (overflow > 0) {
      const moreEl = document.createElement('span');
      moreEl.className = 'calendar-more';
      moreEl.textContent = `+${overflow} more`;
      cellEl.appendChild(moreEl);
    }

    // DnD: dragover + drop
    cellEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      cellEl.classList.add('cell-drop-target');
    });
    cellEl.addEventListener('dragleave', () => {
      cellEl.classList.remove('cell-drop-target');
    });
    cellEl.addEventListener('drop', (e) => {
      e.preventDefault();
      cellEl.classList.remove('cell-drop-target');
      const itemId = e.dataTransfer ? e.dataTransfer.getData('text/plain') : null;
      const handleDnD = _getHandleCalendarDnD ? _getHandleCalendarDnD() : null;
      if (itemId && handleDnD) handleDnD(itemId, cell.date);
    });

    grid.appendChild(cellEl);
  }

  board.appendChild(grid);
}

// ------------------------------------------------------------------
// Item pill (shared across subviews — imported by day + week views too)
// ------------------------------------------------------------------

/**
 * Build a draggable item pill element.
 *
 * @param {object} item
 * @param {Function|null} [onDragStart]  — optional (itemId) => void
 * @param {Function|null} [onDragEnd]    — optional () => void
 * @returns {HTMLElement}
 */
export function buildItemPill(item, onDragStart = null, onDragEnd = null) {
  const pill = document.createElement('div');
  pill.className = 'calendar-item-pill';
  if (item.status === 'done') pill.classList.add('pill-done');
  pill.dataset.itemId = item.id;
  pill.draggable = true;

  // v1.19.0 D2 + D18: visual hierarchy type + status classes
  applyItemClasses(pill, item);

  // Text content (never innerHTML — ADR 009 D6)
  const titleSpan = document.createElement('span');
  titleSpan.className = 'pill-title';
  titleSpan.textContent = item.title || '(untitled)'; // textContent — never innerHTML
  pill.appendChild(titleSpan);

  // Accessibility icon affordances (D18 — don't rely solely on color)
  appendAccessibilityIcon(pill, item);

  // DnD drag start
  pill.addEventListener('dragstart', (e) => {
    if (e.dataTransfer) e.dataTransfer.setData('text/plain', item.id);
    pill.classList.add('pill-dragging');
    if (onDragStart) onDragStart(item.id);
  });
  pill.addEventListener('dragend', () => {
    pill.classList.remove('pill-dragging');
    if (onDragEnd) onDragEnd();
  });

  return pill;
}

// ------------------------------------------------------------------
// Visual hierarchy helpers (D2 + D18 — commit 12)
// ------------------------------------------------------------------

/**
 * Apply type + status CSS classes to a calendar item pill.
 * D2: type colors; D18: status affordances.
 * Does NOT rely solely on color — accessibility icons appended separately.
 *
 * @param {HTMLElement} el
 * @param {object} item
 */
export function applyItemClasses(el, item) {
  // Type class
  if (item.type === 'goal') el.classList.add('type-goal');
  else if (item.type === 'task') el.classList.add('type-task');
  else if (item.type === 'event') el.classList.add('type-event');

  // Status class
  if (item.status === 'done') el.classList.add('status-done');
  else if (item.status === 'abandoned') el.classList.add('status-done'); // same visual
  else el.classList.add('status-active');

  // Overdue: due date is in the past and status is not done
  if (item.due && item.status !== 'done' && item.status !== 'abandoned') {
    const dueDate = item.due; // 'YYYY-MM-DD' string
    const todayStr = new Date().toISOString().slice(0, 10);
    if (dueDate < todayStr) el.classList.add('status-overdue');
  }

  // Coach persistent ring
  if (item.coachIntensity === 'persistent') el.classList.add('coach-persistent');
}

/**
 * Append a small accessibility icon to a pill element (D18).
 * Screen readers read aria-label; sighted users see the emoji.
 *
 * @param {HTMLElement} pill
 * @param {object} item
 */
export function appendAccessibilityIcon(pill, item) {
  if (item.status === 'done') {
    const icon = document.createElement('span');
    icon.className = 'done-icon';
    icon.setAttribute('aria-label', 'Done');
    icon.textContent = '✓';
    pill.appendChild(icon);
  } else if (item.due) {
    const dueStr = item.due;
    const todayStr = new Date().toISOString().slice(0, 10);
    if (dueStr < todayStr && item.status !== 'abandoned') {
      const icon = document.createElement('span');
      icon.className = 'overdue-icon';
      icon.setAttribute('aria-label', 'Overdue');
      icon.textContent = '⚠';
      pill.appendChild(icon);
    }
  }
}
