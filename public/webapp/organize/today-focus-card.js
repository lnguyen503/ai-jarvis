/**
 * Today focus card — Jarvis v1.20.0 (commit 14)
 *
 * Renders a card at the top of the Calendar view showing:
 *  - Coach picks (items from coach memory with lastNudge matching today)
 *  - Due today (items with dueDate matching today)
 *  - Recent coach activity (v1.20.0 ADR 020 D19): last 3 spontaneous trigger nudges
 *
 * Data flow (ADR 019 D11 + D4 + ADR 020 D19):
 *  - Items: READ from GET /api/webapp/items (existing endpoint); filter client-side.
 *  - Coach picks: READ from GET /api/webapp/memory (existing endpoint); filter by prefix
 *    `coach.` and `lastNudge` sub-key; no new endpoint required.
 *  - Coach memory entry key pattern: `coach.<itemId>.lastNudge.<timestamp>`
 *  - The entry body has shape: { at: '<ISO>', wording: '<nudge text>' }
 *  - Spontaneous activity: READ from same GET /api/webapp/memory; filter by sub-key
 *    `.lastSpontaneousAt`. Entry body shape: { at: '<ISO>', triggerType: '<...>' }
 *
 * Security invariants (ADR 009, decision 6):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *
 * Collapsible: default expanded; sessionStorage flag `today-focus-card-collapsed`.
 *
 * Engaged state: if item.progress field updated since 8am today, show engaged visual.
 *
 * ES module; no framework; no bundler; no new npm deps.
 */

import { formatISO, today } from './dates.js';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------
const COLLAPSE_KEY = 'today-focus-card-collapsed';
const COACH_MEMORY_PREFIX = 'coach.';
const LAST_NUDGE_SUBKEY = '.lastNudge.';
const LAST_SPONTANEOUS_SUBKEY = '.lastSpontaneousAt';
const ENGAGED_SINCE_HOUR_UTC = 8; // 8am UTC

/**
 * Maps trigger type strings to display icons (ADR 020 D19).
 * Using safe ASCII icons to avoid emoji display issues across platforms.
 */
const TRIGGER_TYPE_ICONS = {
  'item-state': '🎯',
  'due-in-24h-no-progress': '🎯',
  'goal-stale-14d': '🎯',
  'persistent-zero-engagement-7d': '🎯',
  'new-vague-goal': '🎯',
  'chat': '💬',
  'commitment': '💬',
  'blocker': '💬',
  'procrastination': '💬',
  'done-signal-confirmation': '💬',
  'calendar': '📅',
  'recurring-meeting-detected': '📅',
  'standalone-meaningful-event': '📅',
};

// ------------------------------------------------------------------
// Module state
// ------------------------------------------------------------------
let _container = null;
let _getInitData = null;
let _getRenderedItems = null;

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

/**
 * Initialize the Today focus card.
 *
 * @param {HTMLElement} container
 * @param {object} cbs
 * @param {Function} cbs.getInitData   - () => string (auth token)
 * @param {Function} cbs.getRenderedItems - () => item[]
 */
export function initTodayFocusCard(container, cbs) {
  _container = container;
  _getInitData = cbs.getInitData;
  _getRenderedItems = cbs.getRenderedItems;
}

// ------------------------------------------------------------------
// Render
// ------------------------------------------------------------------

/**
 * Render the Today focus card.
 * Fetches coach memory and filters items for today.
 * Called whenever the calendar view is rendered.
 */
export async function renderTodayFocusCard() {
  if (!_container) return;

  const todayIso = formatISO(today());
  const initData = _getInitData ? _getInitData() : '';
  const items = _getRenderedItems ? _getRenderedItems() : [];

  // Filter items due today
  const dueTodayItems = items.filter((i) => i.due === todayIso && i.status !== 'done' && i.status !== 'abandoned');

  // Fetch coach memory for coach picks + spontaneous activity (ADR 020 D19)
  let coachPicks = [];
  let spontaneousActivity = [];
  try {
    const res = await fetch('/api/webapp/memory', {
      headers: { 'Authorization': `tma ${initData}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.entries)) {
        coachPicks = extractCoachPicks(data.entries, items, todayIso);
        spontaneousActivity = extractSpontaneousActivity(data.entries, items);
      }
    }
  } catch {
    // Coach memory fetch failure is non-fatal; card shows due-today only
  }

  // Render the card
  renderCard(todayIso, coachPicks, dueTodayItems, spontaneousActivity, initData);
}

// ------------------------------------------------------------------
// Coach picks extraction
// ------------------------------------------------------------------

/**
 * Extract today's coach picks from memory entries.
 * A "coach pick" is a memory entry whose key matches:
 *   `coach.<itemId>.lastNudge.<timestamp>`
 * AND whose body.at date matches today.
 *
 * @param {Array<{key: string, body: object|string, etag: string, mtimeMs: number}>} entries
 * @param {object[]} items
 * @param {string} todayIso
 * @returns {Array<{item: object, wording: string}>}
 */
function extractCoachPicks(entries, items, todayIso) {
  const picks = [];

  for (const entry of entries) {
    if (!entry.key.startsWith(COACH_MEMORY_PREFIX)) continue;
    if (!entry.key.includes(LAST_NUDGE_SUBKEY.slice(0, -1))) continue;

    // Parse itemId from key: coach.<itemId>.lastNudge.<timestamp>
    // Pattern: coach. → remainder contains itemId up to .lastNudge.
    const afterCoach = entry.key.slice(COACH_MEMORY_PREFIX.length);
    const lastNudgeIdx = afterCoach.indexOf('.lastNudge.');
    if (lastNudgeIdx < 0) continue;

    const itemId = afterCoach.slice(0, lastNudgeIdx);
    const item = items.find((i) => i.id === itemId);
    if (!item) continue;

    // Check if the nudge was today
    let body = entry.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { continue; }
    }
    if (!body || typeof body !== 'object') continue;

    const atStr = body['at'];
    if (!atStr || !atStr.startsWith(todayIso)) continue; // 'at' should be ISO with YYYY-MM-DD prefix

    const wording = (typeof body['wording'] === 'string' && body['wording'].trim())
      ? body['wording']
      : 'Coach suggests working on this today.';

    picks.push({ item, wording });
  }

  // Deduplicate by itemId (keep first occurrence per item)
  const seen = new Set();
  return picks.filter(({ item }) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, 3); // max 3 coach picks shown (D11 spec)
}

// ------------------------------------------------------------------
// Spontaneous activity extraction (ADR 020 D19)
// ------------------------------------------------------------------

/**
 * Extract recent spontaneous coach activity from memory entries.
 *
 * A "spontaneous activity" entry is a memory entry whose key matches:
 *   `coach.<itemId>.lastSpontaneousAt`
 * AND whose body has shape: { at: '<ISO>', triggerType: '<...>' }
 *
 * Returns last 3 entries sorted most-recent-first.
 *
 * @param {Array<{key: string, body: object|string, etag: string, mtimeMs: number}>} entries
 * @param {object[]} items
 * @returns {Array<{item: object|null, at: string, triggerType: string}>}
 */
function extractSpontaneousActivity(entries, items) {
  const activity = [];

  for (const entry of entries) {
    if (!entry.key.startsWith(COACH_MEMORY_PREFIX)) continue;
    if (!entry.key.endsWith(LAST_SPONTANEOUS_SUBKEY)) continue;

    // Parse itemId from key: coach.<itemId>.lastSpontaneousAt
    const afterCoach = entry.key.slice(COACH_MEMORY_PREFIX.length);
    const itemId = afterCoach.slice(0, -LAST_SPONTANEOUS_SUBKEY.length);
    if (!itemId) continue;

    const item = items.find((i) => i.id === itemId) ?? null;

    let body = entry.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { continue; }
    }
    if (!body || typeof body !== 'object') continue;

    const at = body['at'];
    if (typeof at !== 'string') continue;

    const triggerType = (typeof body['triggerType'] === 'string' && body['triggerType'].trim())
      ? body['triggerType']
      : 'item-state'; // fallback for older entries

    activity.push({ item, itemId, at, triggerType });
  }

  // Sort most-recent-first, take last 3
  activity.sort((a, b) => {
    const ta = new Date(a.at).getTime();
    const tb = new Date(b.at).getTime();
    return tb - ta; // descending
  });

  return activity.slice(0, 3);
}

/**
 * Format an ISO timestamp as a relative time string.
 * Returns strings like "2h ago", "yesterday", "3d ago".
 *
 * @param {string} isoStr
 * @returns {string}
 */
function formatRelativeTime(isoStr) {
  try {
    const then = new Date(isoStr).getTime();
    const now = Date.now();
    const diffMs = now - then;
    if (diffMs < 0) return 'just now';
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 2) return 'just now';
    if (diffMins < 60) return diffMins + 'm ago';
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return diffHours + 'h ago';
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'yesterday';
    return diffDays + 'd ago';
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------
// Card DOM render
// ------------------------------------------------------------------

/**
 * Render the card element into _container.
 * Replaces any existing card content.
 *
 * @param {string} todayIso
 * @param {Array<{item: object, wording: string}>} coachPicks
 * @param {object[]} dueTodayItems
 * @param {Array<{item: object|null, itemId: string, at: string, triggerType: string}>} spontaneousActivity
 * @param {string} initData
 */
function renderCard(todayIso, coachPicks, dueTodayItems, spontaneousActivity, initData) {
  // Clear container
  _container.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'today-focus-card';
  card.id = 'today-focus-card';

  // Collapse toggle (sessionStorage flag)
  const isCollapsed = loadCollapseState();

  // Header row
  const header = document.createElement('div');
  header.className = 'today-focus-card-header';

  const titleEl = document.createElement('h2');
  titleEl.className = 'today-focus-title';
  // Format today's date for display (e.g. "Today — April 25")
  const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  let titleText = 'Today';
  try {
    const dateLabel = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${todayIso}T12:00:00Z`));
    titleText = `Today — ${dateLabel}`;
  } catch {
    titleText = `Today — ${todayIso}`;
  }
  titleEl.textContent = titleText; // textContent — never innerHTML
  header.appendChild(titleEl);

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'today-focus-collapse';
  collapseBtn.setAttribute('aria-label', isCollapsed ? 'Expand Today card' : 'Collapse Today card');
  collapseBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  collapseBtn.textContent = isCollapsed ? '▸' : '▾';
  header.appendChild(collapseBtn);
  card.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'today-focus-card-body';
  if (isCollapsed) body.hidden = true;

  if (coachPicks.length === 0 && dueTodayItems.length === 0) {
    // Empty state
    const emptyEl = document.createElement('p');
    emptyEl.className = 'today-focus-empty';
    emptyEl.textContent = "Nothing on the docket today. Want me to nudge you on a goal?";
    body.appendChild(emptyEl);
  } else {
    // Coach picks section
    if (coachPicks.length > 0) {
      const coachSection = document.createElement('section');
      coachSection.className = 'today-focus-section';

      const coachLabel = document.createElement('h3');
      coachLabel.className = 'today-focus-section-label';
      coachLabel.textContent = '🤖 Coach picks';
      coachSection.appendChild(coachLabel);

      for (const { item, wording } of coachPicks) {
        const row = buildPickRow(item, wording);
        coachSection.appendChild(row);
      }
      body.appendChild(coachSection);
    }

    // Due today section
    if (dueTodayItems.length > 0) {
      const dueSection = document.createElement('section');
      dueSection.className = 'today-focus-section';

      const dueLabel = document.createElement('h3');
      dueLabel.className = 'today-focus-section-label';
      dueLabel.textContent = '📅 Due today';
      dueSection.appendChild(dueLabel);

      for (const item of dueTodayItems) {
        const row = buildDueRow(item);
        dueSection.appendChild(row);
      }
      body.appendChild(dueSection);
    }
  }

  // v1.20.0 ADR 020 D19: Spontaneous activity section (only shown if entries exist)
  if (spontaneousActivity.length > 0) {
    const spontSection = buildSpontaneousSection(spontaneousActivity);
    body.appendChild(spontSection);
  }

  card.appendChild(body);

  // Collapse toggle handler
  collapseBtn.addEventListener('click', () => {
    const nowCollapsed = !body.hidden;
    body.hidden = nowCollapsed;
    collapseBtn.textContent = nowCollapsed ? '▸' : '▾';
    collapseBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
    collapseBtn.setAttribute('aria-label', nowCollapsed ? 'Expand Today card' : 'Collapse Today card');
    saveCollapseState(nowCollapsed);
  });

  _container.appendChild(card);
}

// ------------------------------------------------------------------
// Row builders (textContent only — never innerHTML)
// ------------------------------------------------------------------

/**
 * Build a coach pick row.
 * @param {object} item
 * @param {string} wording
 * @returns {HTMLElement}
 */
function buildPickRow(item, wording) {
  const row = document.createElement('div');
  row.className = 'today-pick-row';

  // Engaged state: progress updated since 8am today
  const engagedSince8am = isEngagedToday(item);
  if (engagedSince8am) row.classList.add('today-pick-engaged');

  const titleEl = document.createElement('span');
  titleEl.className = 'today-pick-title';
  titleEl.textContent = item.title || '(untitled)'; // textContent — never innerHTML
  row.appendChild(titleEl);

  const nudgeEl = document.createElement('span');
  nudgeEl.className = 'today-pick-wording';
  nudgeEl.textContent = wording; // textContent — never innerHTML
  row.appendChild(nudgeEl);

  if (engagedSince8am) {
    const engagedBadge = document.createElement('span');
    engagedBadge.className = 'today-pick-engaged-badge';
    engagedBadge.setAttribute('aria-label', 'In progress today');
    engagedBadge.textContent = '✓ In progress';
    row.appendChild(engagedBadge);
  }

  return row;
}

/**
 * Build a due-today row.
 * @param {object} item
 * @returns {HTMLElement}
 */
function buildDueRow(item) {
  const row = document.createElement('div');
  row.className = 'today-due-row';

  const titleEl = document.createElement('span');
  titleEl.className = 'today-due-title';
  titleEl.textContent = item.title || '(untitled)'; // textContent — never innerHTML
  row.appendChild(titleEl);

  if (item.type) {
    const typeEl = document.createElement('span');
    typeEl.className = 'today-due-type';
    typeEl.textContent = item.type; // textContent — never innerHTML
    row.appendChild(typeEl);
  }

  return row;
}

// ------------------------------------------------------------------
// Spontaneous activity section builder (ADR 020 D19)
// ------------------------------------------------------------------

/**
 * Build the "Recent coach activity" collapsible section.
 *
 * @param {Array<{item: object|null, itemId: string, at: string, triggerType: string}>} activity
 * @returns {HTMLElement}
 */
function buildSpontaneousSection(activity) {
  const SPONT_COLLAPSE_KEY = 'today-spont-activity-collapsed';

  const section = document.createElement('section');
  section.className = 'today-focus-section today-spont-section';

  // Header row with label + collapse toggle
  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'today-spont-header';

  const sectionLabel = document.createElement('h3');
  sectionLabel.className = 'today-focus-section-label';
  sectionLabel.textContent = 'Recent coach activity';
  sectionHeader.appendChild(sectionLabel);

  const isCollapsed = (() => {
    try { return sessionStorage.getItem(SPONT_COLLAPSE_KEY) === '1'; } catch { return false; }
  })();

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'today-focus-collapse today-spont-collapse';
  collapseBtn.setAttribute('aria-label', isCollapsed ? 'Expand recent activity' : 'Collapse recent activity');
  collapseBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  collapseBtn.textContent = isCollapsed ? '▸' : '▾';
  sectionHeader.appendChild(collapseBtn);

  section.appendChild(sectionHeader);

  // Activity rows container
  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'today-spont-rows';
  if (isCollapsed) rowsContainer.hidden = true;

  for (const entry of activity) {
    const row = buildSpontaneousRow(entry);
    rowsContainer.appendChild(row);
  }
  section.appendChild(rowsContainer);

  // Wire collapse toggle
  collapseBtn.addEventListener('click', () => {
    const nowCollapsed = !rowsContainer.hidden;
    rowsContainer.hidden = nowCollapsed;
    collapseBtn.textContent = nowCollapsed ? '▸' : '▾';
    collapseBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
    collapseBtn.setAttribute('aria-label', nowCollapsed ? 'Expand recent activity' : 'Collapse recent activity');
    try {
      if (nowCollapsed) {
        sessionStorage.setItem(SPONT_COLLAPSE_KEY, '1');
      } else {
        sessionStorage.removeItem(SPONT_COLLAPSE_KEY);
      }
    } catch { /* sessionStorage may be unavailable */ }
  });

  return section;
}

/**
 * Build a single spontaneous activity row.
 * Format: <icon> <relative-time> · <trigger-type> · <item-title>
 *
 * @param {{item: object|null, itemId: string, at: string, triggerType: string}} entry
 * @returns {HTMLElement}
 */
function buildSpontaneousRow(entry) {
  const row = document.createElement('div');
  row.className = 'today-spont-row';

  // Trigger type icon
  const icon = TRIGGER_TYPE_ICONS[entry.triggerType] || '🤖';
  const iconEl = document.createElement('span');
  iconEl.className = 'today-spont-icon';
  iconEl.setAttribute('aria-hidden', 'true');
  iconEl.textContent = icon; // our own mapping, not user content
  row.appendChild(iconEl);

  // Relative timestamp
  const timeEl = document.createElement('span');
  timeEl.className = 'today-spont-time';
  timeEl.textContent = formatRelativeTime(entry.at); // pure computed string
  row.appendChild(timeEl);

  // Item title (from item object if available; fallback to itemId)
  const titleEl = document.createElement('span');
  titleEl.className = 'today-spont-title';
  const title = (entry.item && typeof entry.item.title === 'string' && entry.item.title.trim())
    ? entry.item.title
    : entry.itemId;
  titleEl.textContent = title; // textContent — never innerHTML; user-authored content is safe via textContent
  row.appendChild(titleEl);

  return row;
}

// ------------------------------------------------------------------
// Engaged state detection
// ------------------------------------------------------------------

/**
 * Returns true if the item's progressUpdatedAt is after 8am UTC today.
 *
 * @param {object} item
 * @returns {boolean}
 */
function isEngagedToday(item) {
  if (!item.progressUpdatedAt && !item.mtimeMs) return false;
  try {
    const todayDate = today(); // UTC midnight today
    const engagedThreshold = new Date(todayDate.getTime());
    engagedThreshold.setUTCHours(ENGAGED_SINCE_HOUR_UTC, 0, 0, 0);

    const updatedAt = item.progressUpdatedAt
      ? new Date(item.progressUpdatedAt)
      : new Date(item.mtimeMs);

    return updatedAt >= engagedThreshold;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Collapse state persistence
// ------------------------------------------------------------------

function loadCollapseState() {
  try {
    return sessionStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveCollapseState(collapsed) {
  try {
    if (collapsed) {
      sessionStorage.setItem(COLLAPSE_KEY, '1');
    } else {
      sessionStorage.removeItem(COLLAPSE_KEY);
    }
  } catch {
    // sessionStorage may be unavailable in private mode
  }
}
