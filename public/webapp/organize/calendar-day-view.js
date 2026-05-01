/**
 * Calendar day view — Jarvis v1.19.0
 *
 * Implements single-day hourly grid (8am–10pm visible; scrollable for night).
 * Items placed in their hour slot per dueDate UTC time (or all-day band if no time).
 * Coach activity overlay: items with coach lastNudge matching today get a 🤖 marker.
 *
 * Reuses buildItemPill from calendar-month-view.js (same DnD pattern as kanban-view.js).
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *
 * Calendar-date semantics (ADR 015 D3 + dates.js):
 *  - UTC accessors only. due: 'YYYY-MM-DD' is a calendar date, not a timestamp.
 *  - Hour slots use UTC hour of dueDateTime when present; otherwise all-day band.
 *
 * ES module; no framework; no bundler; no new npm deps.
 */

import { formatISO, isSameDay, today, noonOfDayUTC } from './dates.js';
import { buildItemPill } from './calendar-month-view.js';

// ------------------------------------------------------------------
// Constants (D14 + D15)
// ------------------------------------------------------------------
/** First hour visible in the scrollable hourly grid. */
const DAY_VIEW_START_HOUR = 8;  // 8am
/** Last hour visible (inclusive) before overflow-y scroll. */
const DAY_VIEW_END_HOUR = 22;   // 10pm
/** Height of each hour slot in pixels (must match .calendar-hour-slot CSS). */
const HOUR_SLOT_HEIGHT_PX = 60;

// ------------------------------------------------------------------
// Day view render
// ------------------------------------------------------------------

/**
 * Render a single-day view with hourly grid (8am–10pm) and coach overlay.
 *
 * Items are placed in their hour slot when dueDateTime is present; otherwise
 * they appear in the all-day band at the top.
 *
 * @param {HTMLElement} board
 * @param {object[]} items  — only items with `due` (pre-filtered)
 * @param {Date} currentDate  — UTC Date anchor for the view
 * @param {Function} handleDnD  — (itemId, date) => void
 * @param {Set<string>} [coachItemIds]  — IDs nudged by coach today (coach overlay)
 */
export function renderDay(board, items, currentDate, handleDnD, coachItemIds = new Set()) {
  board.className = 'calendar-board calendar-day';

  const isoDate = formatISO(currentDate);
  const todayDate = today();

  // Header
  const header = document.createElement('div');
  header.className = 'calendar-day-header';
  const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  try {
    header.textContent = new Intl.DateTimeFormat(locale, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }).format(noonOfDayUTC(currentDate));
  } catch {
    header.textContent = isoDate;
  }
  if (isSameDay(currentDate, todayDate)) header.classList.add('cell-today');
  board.appendChild(header);

  const dayItems = items.filter((i) => i.due === isoDate);

  // Split into timed (has dueDateTime) and all-day
  const timedItems = dayItems.filter((i) => i.dueDateTime && typeof i.dueDateTime === 'string');
  const allDayItems = dayItems.filter((i) => !i.dueDateTime);

  // All-day band
  const allDayBand = document.createElement('div');
  allDayBand.className = 'calendar-day-allday';
  const allDayLabel = document.createElement('span');
  allDayLabel.className = 'calendar-day-allday-label';
  allDayLabel.textContent = 'All day';
  allDayBand.appendChild(allDayLabel);

  if (allDayItems.length === 0 && timedItems.length === 0) {
    // Empty state — handled by caller (commit 15); show a placeholder
    const empty = document.createElement('p');
    empty.className = 'calendar-day-empty';
    empty.textContent = 'No items due today.';
    allDayBand.appendChild(empty);
  } else {
    for (const item of allDayItems) {
      const pill = buildDayPill(item, coachItemIds, handleDnD, currentDate);
      allDayBand.appendChild(pill);
    }
  }
  board.appendChild(allDayBand);

  // Scrollable hourly grid
  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'calendar-day-scroll';

  const hoursContainer = document.createElement('div');
  hoursContainer.className = 'calendar-day-hours';

  for (let h = 0; h < 24; h++) {
    const slot = document.createElement('div');
    slot.className = 'calendar-hour-slot';
    if (h < DAY_VIEW_START_HOUR || h > DAY_VIEW_END_HOUR) {
      slot.classList.add('hour-slot-offpeak');
    }
    slot.dataset.hour = String(h);

    const label = document.createElement('span');
    label.className = 'calendar-hour-label';
    const ampm = h < 12 ? 'am' : 'pm';
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    label.textContent = `${displayH}${ampm}`;
    slot.appendChild(label);

    // Place timed items in their slot (UTC hour)
    const slotItems = timedItems.filter((i) => {
      // dueDateTime is ISO-8601 with time component; extract UTC hour
      try {
        const dt = new Date(i.dueDateTime);
        return !isNaN(dt.getTime()) && dt.getUTCHours() === h;
      } catch {
        return false;
      }
    });
    for (const item of slotItems) {
      const pill = buildDayPill(item, coachItemIds, handleDnD, currentDate);
      slot.appendChild(pill);
    }

    // DnD: drop onto an hour slot
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      slot.classList.add('cell-drop-target');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('cell-drop-target'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('cell-drop-target');
      const itemId = e.dataTransfer ? e.dataTransfer.getData('text/plain') : null;
      if (itemId && handleDnD) handleDnD(itemId, currentDate);
    });

    hoursContainer.appendChild(slot);
  }

  scrollWrapper.appendChild(hoursContainer);
  board.appendChild(scrollWrapper);

  // Scroll to 8am by default
  setTimeout(() => {
    const firstSlot = hoursContainer.querySelector('.calendar-hour-slot:not(.hour-slot-offpeak)');
    if (firstSlot) firstSlot.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 0);
}

// ------------------------------------------------------------------
// Day item pill with coach marker
// ------------------------------------------------------------------

/**
 * Build an item pill for the day view, adding a coach 🤖 marker if nudged today.
 *
 * @param {object} item
 * @param {Set<string>} coachItemIds
 * @param {Function|null} handleDnD
 * @param {Date} currentDate
 * @returns {HTMLElement}
 */
function buildDayPill(item, coachItemIds, handleDnD, currentDate) {
  const pill = buildItemPill(
    item,
    null, // onDragStart handled below
    null,
  );
  pill.classList.add('calendar-item-day');

  // Coach overlay marker (D14 + D15: 🤖 for coach-nudged items)
  if (coachItemIds.has(item.id)) {
    const marker = document.createElement('span');
    marker.className = 'coach-overlay-marker';
    marker.textContent = '🤖';
    marker.setAttribute('aria-label', 'Coach active on this item');
    pill.appendChild(marker);
  }

  // Re-attach DnD drop to current date (pill already has dragstart from buildItemPill)
  if (handleDnD) {
    pill.addEventListener('dragstart', (e) => {
      if (e.dataTransfer) e.dataTransfer.setData('text/plain', item.id);
    });
  }

  return pill;
}
