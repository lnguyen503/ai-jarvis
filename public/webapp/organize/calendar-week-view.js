/**
 * Calendar week view — Jarvis v1.19.0
 *
 * Implements 7-column × hourly row grid. Items placed by day + hour per UTC.
 * Coach activity overlay: items with coach lastNudge matching today get a 🤖 marker.
 *
 * Reuses buildItemPill from calendar-month-view.js.
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *
 * Calendar-date semantics (ADR 015 D3 + dates.js):
 *  - UTC accessors only. due: 'YYYY-MM-DD' is a calendar date, not a timestamp.
 *
 * ES module; no framework; no bundler; no new npm deps.
 */

import { formatISO, addDays, isSameDay, today, weekStart, formatDowLabel } from './dates.js';
import { buildItemPill } from './calendar-month-view.js';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------
const FIRST_DAY_OF_WEEK = 1; // Monday
/** Hours displayed in the header row. */
const WEEK_HOURS = Array.from({ length: 24 }, (_, i) => i);

// ------------------------------------------------------------------
// Week view render
// ------------------------------------------------------------------

/**
 * Render a 7-column week view with hourly rows and coach overlay.
 *
 * Items appear in the column for their day. If they have a dueDateTime, they
 * are placed in that hour's row. Otherwise they appear at top of the column.
 *
 * @param {HTMLElement} board
 * @param {object[]} items  — only items with `due` (pre-filtered)
 * @param {Date} currentDate  — UTC Date anchor for the view
 * @param {Function} handleDnD  — (itemId, date) => void
 * @param {Set<string>} [coachItemIds]  — IDs nudged by coach today
 */
export function renderWeek(board, items, currentDate, handleDnD, coachItemIds = new Set()) {
  board.className = 'calendar-board calendar-week';

  const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const todayDate = today();
  const weekStartDate = weekStart(currentDate, FIRST_DAY_OF_WEEK);

  // Build the week grid: header row + 24 hour rows × 7 columns
  // Use a CSS grid approach: single scrollable container
  const gridEl = document.createElement('div');
  gridEl.className = 'calendar-week-grid';

  // --- Column headers (day labels) ---
  const headerRow = document.createElement('div');
  headerRow.className = 'calendar-week-header-row';

  // Empty corner cell for hour label column
  const cornerCell = document.createElement('div');
  cornerCell.className = 'calendar-week-corner';
  headerRow.appendChild(cornerCell);

  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStartDate, i);
    const headerCell = document.createElement('div');
    headerCell.className = 'calendar-week-day-header';
    if (isSameDay(d, todayDate)) headerCell.classList.add('cell-today');
    headerCell.dataset.cellDate = formatISO(d);
    headerCell.textContent = `${formatDowLabel(i, locale, FIRST_DAY_OF_WEEK)} ${d.getUTCDate()}`;
    headerRow.appendChild(headerCell);
  }
  gridEl.appendChild(headerRow);

  // --- Hour rows ---
  for (const h of WEEK_HOURS) {
    const hourRow = document.createElement('div');
    hourRow.className = 'calendar-week-hour-row';

    // Hour label cell
    const hourLabel = document.createElement('div');
    hourLabel.className = 'calendar-week-hour-label';
    const ampm = h < 12 ? 'am' : 'pm';
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    hourLabel.textContent = `${displayH}${ampm}`;
    hourRow.appendChild(hourLabel);

    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStartDate, i);
      const isoDate = formatISO(d);

      const cell = document.createElement('div');
      cell.className = 'calendar-week-cell';
      if (isSameDay(d, todayDate)) cell.classList.add('cell-today');
      cell.dataset.cellDate = isoDate;
      cell.dataset.hour = String(h);

      // Items for this day+hour
      const slotItems = items.filter((item) => {
        if (item.due !== isoDate) return false;
        if (item.dueDateTime) {
          try {
            const dt = new Date(item.dueDateTime);
            return !isNaN(dt.getTime()) && dt.getUTCHours() === h;
          } catch {
            return false;
          }
        }
        // All-day items shown in hour=0 row
        return h === 0;
      });

      for (const item of slotItems) {
        const pill = buildWeekPill(item, coachItemIds, handleDnD, d);
        cell.appendChild(pill);
      }

      // DnD
      cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('cell-drop-target'); });
      cell.addEventListener('dragleave', () => cell.classList.remove('cell-drop-target'));
      cell.addEventListener('drop', (e) => {
        e.preventDefault();
        cell.classList.remove('cell-drop-target');
        const itemId = e.dataTransfer ? e.dataTransfer.getData('text/plain') : null;
        if (itemId && handleDnD) handleDnD(itemId, d);
      });

      hourRow.appendChild(cell);
    }

    gridEl.appendChild(hourRow);
  }

  // Wrap in scroll container
  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'calendar-week-scroll';
  scrollWrapper.appendChild(gridEl);
  board.appendChild(scrollWrapper);

  // Scroll to 8am by default
  setTimeout(() => {
    const hour8Row = gridEl.querySelectorAll('.calendar-week-hour-row')[8];
    if (hour8Row) hour8Row.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 0);
}

// ------------------------------------------------------------------
// Week item pill with coach marker
// ------------------------------------------------------------------

/**
 * @param {object} item
 * @param {Set<string>} coachItemIds
 * @param {Function|null} handleDnD
 * @param {Date} targetDate
 * @returns {HTMLElement}
 */
function buildWeekPill(item, coachItemIds, handleDnD, targetDate) {
  const pill = buildItemPill(item, null, null);
  pill.classList.add('calendar-item-week');

  if (coachItemIds.has(item.id)) {
    const marker = document.createElement('span');
    marker.className = 'coach-overlay-marker';
    marker.textContent = '🤖';
    marker.setAttribute('aria-label', 'Coach active on this item');
    pill.appendChild(marker);
  }

  if (handleDnD) {
    pill.addEventListener('dragstart', (e) => {
      if (e.dataTransfer) e.dataTransfer.setData('text/plain', item.id);
    });
  }

  return pill;
}
