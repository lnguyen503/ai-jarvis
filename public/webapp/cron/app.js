/**
 * Cron builder — Jarvis v1.20.0
 *
 * Vanilla JS, no framework, no bundler. ES module.
 * CSP: script-src 'self' https://telegram.org — no inline JS.
 *
 * Security invariants (ADR 017 D2 + R8):
 *  - task.action, task.description, task.expr rendered via textContent ONLY.
 *  - Status enum values (active/paused) use textContent for the value itself;
 *    badge wrapper structure may use createElement (not innerHTML from user content).
 *  - Textarea/input values set via DOM property .value — never setAttribute.
 *  - No native confirm() — inline "tap again" pattern.
 *
 * R5 binding: _cronSubmitInFlight flag + AbortController + CRON_SUBMIT_TIMEOUT_MS.
 * W2 binding: cronToPreset recognizes both 1-5 and 1,2,3,4,5 weekday forms.
 * W2 binding: presetToCron emits shorter form (1-5 for weekdays, 0,6 for weekend).
 * Live preview: debounced 400ms fetch to GET /api/webapp/scheduled/preview?expr=...
 *
 * v1.18.0 ADR 018: coach badge on __coach__ task, coach setup section,
 *   Reset Memory two-tap button.
 * v1.20.0 ADR 020 D18: multi-profile coach UI (morning/midday/evening/weekly),
 *   profile picker form, POST /api/webapp/coach/setup with {profile, hhmm, weekday?}.
 */

'use strict';

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** R5: AbortController timeout for create/update submissions (mirrors v1.14.6 D15+R6). */
const CRON_SUBMIT_TIMEOUT_MS = 30_000;

/** Live preview debounce window (ms) — matches v1.14.6 char-counter precedent. */
const PREVIEW_DEBOUNCE_MS = 400;

const TOAST_DEFAULT_MS = 3000;
const TOAST_LONG_MS = 5000;

/** R5: double-submit guard. Shared by create + update (one mutation at a time). */
let _cronSubmitInFlight = false;

/**
 * Sentinel description for the legacy v1.18.0 coach task (ADR 018 D9).
 * Retained for migration display; new code uses profile-specific markers (ADR 020 D2).
 * @deprecated Use COACH_MARKER_BY_PROFILE for new profiles.
 */
const COACH_TASK_DESCRIPTION = '__coach__';

/**
 * v1.20.0 ADR 020 D2: Multi-profile marker prefix + per-profile markers.
 * Mirror of src/coach/index.ts COACH_MARKER_BY_PROFILE (client-side; excluded from
 * static single-source test by source-tree scope — see ADR 020 D2).
 */
const COACH_MARKER_PREFIX = '__coach_';
const COACH_MARKER_SUFFIX = '__';

/** Closed set of profile names (ADR 020 D1). */
const COACH_PROFILES = ['morning', 'midday', 'evening', 'weekly'];

/** Per-profile description markers (ADR 020 D2). */
const COACH_MARKER_BY_PROFILE = {
  morning: '__coach_morning__',
  midday: '__coach_midday__',
  evening: '__coach_evening__',
  weekly: '__coach_weekly__',
};

/** Human-readable profile labels (ADR 020 D18 badge table). */
const COACH_PROFILE_LABELS = {
  morning: 'Coach (morning)',
  midday: 'Coach (midday)',
  evening: 'Coach (evening)',
  weekly: 'Coach (weekly)',
};

/** Weekday names for the weekly profile picker (Mon=1 .. Sun=0). */
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Returns true if this task description is any of the v1.20.0 profile markers.
 * @param {string} description
 * @returns {boolean}
 */
function isCoachProfileMarker(description) {
  if (!description) return false;
  return description.startsWith(COACH_MARKER_PREFIX) &&
    description.endsWith(COACH_MARKER_SUFFIX) &&
    description.length > COACH_MARKER_PREFIX.length + COACH_MARKER_SUFFIX.length;
}

/**
 * Extract profile name from a marker description.
 * @param {string} description
 * @returns {string|null}
 */
function profileFromMarker(description) {
  if (!isCoachProfileMarker(description)) return null;
  const profile = description.slice(COACH_MARKER_PREFIX.length, -COACH_MARKER_SUFFIX.length);
  return COACH_PROFILES.includes(profile) ? profile : null;
}

/**
 * Returns true if the description is the legacy __coach__ sentinel OR any profile marker.
 * @param {string} description
 * @returns {boolean}
 */
function isAnyCoachTask(description) {
  return description === COACH_TASK_DESCRIPTION || isCoachProfileMarker(description);
}

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

/** Task currently being edited (null = create mode). */
let _editingTask = null;

/** All tasks from last fetch. */
let _tasks = [];

/** Current initData for auth. */
let _initData = '';

/** Debounce timer for preview fetch. */
let _previewDebounceTimer = null;

// ------------------------------------------------------------------
// DOM refs (populated in DOMContentLoaded)
// ------------------------------------------------------------------

let listViewEl = null;
let taskFormEl = null;
let formTitleEl = null;
let newTaskBtnEl = null;
let taskListEl = null;
let listLoadingEl = null;
let listEmptyEl = null;
let listErrorEl = null;
let listRetryEl = null;
let taskDescEl = null;
let taskActionEl = null;
let taskExprEl = null;
let taskActiveEl = null;
let formSubmitEl = null;
let formCancelEl = null;
let formErrorEl = null;
let previewBlockEl = null;
let previewListEl = null;
let previewWarningEl = null;
let previewErrorEl = null;
let paramEveryNEl = null;
let paramTimeEl = null;
let paramIntervalEl = null;
let paramHourEl = null;
let paramMinuteEl = null;
let toastEl = null;

// v1.18.0 ADR 018: coach section DOM refs
let coachSectionEl = null;
let coachTimeInputEl = null;
let coachSetupBtnEl = null;
let coachSetupErrorEl = null;
let coachStatusEl = null;
let coachResetBtnEl = null;

// v1.20.0 ADR 020 D18: multi-profile coach UI DOM refs
let coachMultiProfileSetupEl = null;
let coachProfileSaveEl = null;
let coachProfileSaveErrorEl = null;
let coachProfileTimeEl = null;
let coachWeekdayPickerEl = null;

/** Currently selected profile in the picker. */
let _selectedProfile = 'morning';

/** Currently selected weekday (0=Sun, 1=Mon ... 6=Sat) for weekly profile. */
let _selectedWeekday = 1; // default Monday

/** Two-tap state for Reset Memory button. */
let _resetMemoryArmed = false;
let _resetMemoryTimer = null;

// ------------------------------------------------------------------
// Toast
// ------------------------------------------------------------------

let _toastTimer = null;

function showToast(msg, durationMs) {
  if (!toastEl) return;
  const dur = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : TOAST_DEFAULT_MS;
  if (_toastTimer) clearTimeout(_toastTimer);
  toastEl.textContent = msg; // textContent only
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
// cron-builder pure functions (W2 binding)
// ------------------------------------------------------------------

/**
 * Normalize a day-of-week field value to a canonical sorted string
 * so that 1-5, 1,2,3,4,5 etc. can be compared.
 * Expands ranges, sorts, then re-compresses.
 * @param {string} dowField
 * @returns {number[]} sorted unique integers 0..7 (7 = Sunday alias)
 */
function expandDowField(dowField) {
  const nums = new Set();
  const parts = dowField.split(',');
  for (const part of parts) {
    const t = part.trim();
    if (t.includes('-')) {
      const [a, b] = t.split('-').map(Number);
      for (let i = a; i <= b; i++) nums.add(i);
    } else {
      const n = Number(t);
      if (!isNaN(n)) nums.add(n);
    }
  }
  // Normalize 7 → 0 (Sunday alias)
  if (nums.has(7)) { nums.delete(7); nums.add(0); }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Convert a raw cron expression to {presetKey, params} if it matches one of
 * the 5 visual presets. Returns null on no match (→ Custom mode).
 *
 * W2: recognizes both 1-5 and 1,2,3,4,5 for weekdays; 0,6 and 6,0 for weekend.
 *
 * @param {string} expr  5-field cron expression
 * @returns {{presetKey: string, params: object}|null}
 */
export function cronToPreset(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min, hour, dom, month, dow] = fields;

  // every_n_minutes: */N * * * *
  const everyNMatch = min.match(/^\*\/(\d+)$/);
  if (everyNMatch && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(everyNMatch[1], 10);
    if (n === 5 || n === 10 || n === 15 || n === 30) {
      return { presetKey: 'every_n_minutes', params: { interval: n } };
    }
  }

  // Time-based presets: need numeric min + hour, dom=*, month=*
  const minNum = parseInt(min, 10);
  const hourNum = parseInt(hour, 10);
  const validMinutes = [0, 15, 30, 45];
  if (
    String(minNum) === min &&
    String(hourNum) === hour &&
    minNum >= 0 && minNum <= 59 &&
    hourNum >= 0 && hourNum <= 23 &&
    dom === '*' && month === '*'
  ) {
    const timeParams = { hour: hourNum, minute: minNum };

    // every_day: MM HH * * *
    if (dow === '*') {
      return { presetKey: 'every_day', params: timeParams };
    }

    // Expand DOW field and compare sets
    const dowNums = expandDowField(dow);
    const dowStr = dowNums.join(',');

    // every_weekday: Mon-Fri (1,2,3,4,5)
    if (dowStr === '1,2,3,4,5') {
      return { presetKey: 'every_weekday', params: timeParams };
    }

    // every_mwf: Mon,Wed,Fri (1,3,5)
    if (dowStr === '1,3,5') {
      return { presetKey: 'every_mwf', params: timeParams };
    }

    // every_weekend: Sat,Sun (0,6)
    if (dowStr === '0,6') {
      return { presetKey: 'every_weekend', params: timeParams };
    }
  }

  return null; // Custom
}

/**
 * Convert a preset key + params to a raw cron expression.
 * W2: emits shorter form — 1-5 for weekdays, 0,6 for weekend.
 *
 * @param {string} presetKey
 * @param {object} params
 * @returns {string}
 */
export function presetToCron(presetKey, params) {
  switch (presetKey) {
    case 'every_n_minutes':
      return `*/${params.interval} * * * *`;
    case 'every_day':
      return `${params.minute} ${params.hour} * * *`;
    case 'every_weekday':
      return `${params.minute} ${params.hour} * * 1-5`; // W2: shorter form
    case 'every_mwf':
      return `${params.minute} ${params.hour} * * 1,3,5`;
    case 'every_weekend':
      return `${params.minute} ${params.hour} * * 0,6`; // W2: shorter form (sorted)
    case 'custom':
      return params.expr || '';
    default:
      throw new Error(`Unknown preset key: ${presetKey}`);
  }
}

// ------------------------------------------------------------------
// UI — preset selection
// ------------------------------------------------------------------

let _activePreset = null;

function selectPreset(presetKey) {
  _activePreset = presetKey;

  // Update button active states
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === presetKey);
  });

  // Show/hide param panels
  if (paramEveryNEl) paramEveryNEl.hidden = (presetKey !== 'every_n_minutes');
  if (paramTimeEl) paramTimeEl.hidden = (
    presetKey !== 'every_day' &&
    presetKey !== 'every_weekday' &&
    presetKey !== 'every_mwf' &&
    presetKey !== 'every_weekend'
  );

  // Update raw expression from preset (unless custom)
  if (presetKey !== 'custom') {
    const params = readPresetParams(presetKey);
    if (params && taskExprEl) {
      taskExprEl.value = presetToCron(presetKey, params);
    }
    schedulePreviewFetch();
  }
}

function readPresetParams(presetKey) {
  if (presetKey === 'every_n_minutes') {
    const interval = parseInt(paramIntervalEl ? paramIntervalEl.value : '5', 10);
    return { interval };
  }
  if (
    presetKey === 'every_day' || presetKey === 'every_weekday' ||
    presetKey === 'every_mwf' || presetKey === 'every_weekend'
  ) {
    const hour = parseInt(paramHourEl ? paramHourEl.value : '9', 10);
    const minute = parseInt(paramMinuteEl ? paramMinuteEl.value : '0', 10);
    return { hour, minute };
  }
  if (presetKey === 'custom') {
    return { expr: taskExprEl ? taskExprEl.value.trim() : '' };
  }
  return null;
}

/** Populate hour select with 0..23. */
function populateHourSelect() {
  if (!paramHourEl) return;
  paramHourEl.innerHTML = ''; // safe clear — server-controlled content, not user input
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = h < 10 ? `0${h}` : String(h);
    paramHourEl.appendChild(opt);
  }
  paramHourEl.value = '9'; // default 09:00
}

// ------------------------------------------------------------------
// Live preview fetch (debounced 400ms)
// ------------------------------------------------------------------

function schedulePreviewFetch() {
  if (_previewDebounceTimer) clearTimeout(_previewDebounceTimer);
  _previewDebounceTimer = setTimeout(fetchPreview, PREVIEW_DEBOUNCE_MS);
}

async function fetchPreview() {
  const expr = taskExprEl ? taskExprEl.value.trim() : '';
  if (!expr) {
    hidePreview();
    return;
  }
  if (!_initData) return;

  try {
    const res = await fetch(
      `/api/webapp/scheduled/preview?expr=${encodeURIComponent(expr)}`,
      { headers: { Authorization: `tma ${_initData}` } },
    );
    const data = await res.json();
    if (res.status === 200 && data.ok === true) {
      showPreviewResult(data.fireTimes, data.warning);
      if (previewErrorEl) previewErrorEl.hidden = true;
    } else {
      hidePreview();
      if (previewErrorEl) {
        // Safe: error comes from server validation, not user-authored content
        previewErrorEl.textContent = data.error || `Invalid expression (${data.code || 'INVALID_EXPR'})`;
        previewErrorEl.hidden = false;
      }
    }
  } catch (_err) {
    hidePreview();
  }
}

function showPreviewResult(fireTimes, warning) {
  if (!previewBlockEl || !previewListEl) return;
  previewListEl.innerHTML = ''; // safe clear
  if (Array.isArray(fireTimes)) {
    for (const t of fireTimes) {
      const li = document.createElement('li');
      li.textContent = t; // textContent — server-formatted ISO timestamp
      previewListEl.appendChild(li);
    }
  }
  if (previewWarningEl) {
    if (warning) {
      previewWarningEl.textContent = warning; // textContent — server message
      previewWarningEl.hidden = false;
    } else {
      previewWarningEl.hidden = true;
    }
  }
  previewBlockEl.hidden = (Array.isArray(fireTimes) && fireTimes.length === 0 && !warning);
  if (Array.isArray(fireTimes) && fireTimes.length === 0 && warning) {
    previewBlockEl.hidden = false;
  } else if (Array.isArray(fireTimes) && fireTimes.length > 0) {
    previewBlockEl.hidden = false;
  }
}

function hidePreview() {
  if (previewBlockEl) previewBlockEl.hidden = true;
  if (previewErrorEl) previewErrorEl.hidden = true;
}

// ------------------------------------------------------------------
// View switching
// ------------------------------------------------------------------

function showListView() {
  if (listViewEl) listViewEl.hidden = false;
  if (taskFormEl) taskFormEl.hidden = true;
  _editingTask = null;
}

function showFormView(task) {
  _editingTask = task || null;
  if (listViewEl) listViewEl.hidden = true;
  if (taskFormEl) taskFormEl.hidden = false;

  // Reset form
  if (formTitleEl) formTitleEl.textContent = task ? 'Edit scheduled task' : 'New scheduled task';
  if (taskDescEl) taskDescEl.value = task ? (task.description || '') : '';
  if (taskActionEl) taskActionEl.value = task ? (task.action || '') : '';
  if (taskExprEl) taskExprEl.value = task ? (task.expr || '') : '*/5 * * * *';
  if (taskActiveEl) taskActiveEl.checked = task ? (task.status === 'active') : true;
  if (formErrorEl) formErrorEl.hidden = true;
  hidePreview();

  // Detect preset from existing expression
  const expr = task ? (task.expr || '') : '*/5 * * * *';
  const presetMatch = cronToPreset(expr);
  if (presetMatch) {
    selectPreset(presetMatch.presetKey);
    // Apply params to selects
    const p = presetMatch.params;
    if (p.interval && paramIntervalEl) paramIntervalEl.value = String(p.interval);
    if (p.hour !== undefined && paramHourEl) paramHourEl.value = String(p.hour);
    if (p.minute !== undefined && paramMinuteEl) paramMinuteEl.value = String(p.minute);
  } else {
    selectPreset('custom');
  }

  schedulePreviewFetch();
}

// ------------------------------------------------------------------
// Render task list
// ------------------------------------------------------------------

function renderTaskList(tasks) {
  if (!taskListEl) return;
  taskListEl.innerHTML = ''; // safe clear

  if (!tasks || tasks.length === 0) {
    taskListEl.hidden = true;
    if (listEmptyEl) listEmptyEl.hidden = false;
    return;
  }

  if (listEmptyEl) listEmptyEl.hidden = true;
  taskListEl.hidden = false;

  for (const task of tasks) {
    const isLegacyCoachTask = task.description === COACH_TASK_DESCRIPTION;
    const isProfileCoachTask = isCoachProfileMarker(task.description);
    const isCoachTask = isLegacyCoachTask || isProfileCoachTask;

    // Profile name for multi-profile tasks (null for legacy)
    const coachProfile = isProfileCoachTask ? profileFromMarker(task.description) : null;

    const li = document.createElement('li');
    li.className = 'task-item' + (isCoachTask ? ' task-item-coach' : '');
    li.dataset.taskId = task.id;

    // v1.20.0 ADR 020 D18: profile-specific badge for multi-profile coach tasks
    if (isProfileCoachTask && coachProfile) {
      const coachBadge = document.createElement('span');
      coachBadge.className = 'badge badge-coach badge-coach-profile';
      coachBadge.textContent = '🤖 ' + COACH_PROFILE_LABELS[coachProfile]; // textContent — our own label
      li.appendChild(coachBadge);
    } else if (isLegacyCoachTask) {
      // v1.18.0 ADR 018: legacy coach badge (will be migrated to __coach_morning__ on boot)
      const coachBadge = document.createElement('span');
      coachBadge.className = 'badge badge-coach';
      coachBadge.textContent = '🤖 Coach'; // textContent — our own label, not user content
      li.appendChild(coachBadge);
    }

    const descEl = document.createElement('span');
    descEl.className = 'task-desc';
    if (isProfileCoachTask && coachProfile) {
      // Show friendly profile-specific label; sentinel stays server-only
      descEl.textContent = COACH_PROFILE_LABELS[coachProfile] + ' session'; // R8: textContent
    } else if (isLegacyCoachTask) {
      descEl.textContent = 'Daily coach session'; // R8: textContent
    } else {
      descEl.textContent = task.description || '(no description)'; // R8: textContent
    }

    const exprEl = document.createElement('code');
    exprEl.className = 'task-expr';
    exprEl.textContent = task.expr || ''; // R8: textContent

    const actionEl = document.createElement('span');
    actionEl.className = 'task-action';
    // For coach task, do not expose the internal placeholder command to the user
    actionEl.textContent = isCoachTask ? '' : (task.action || ''); // R8: textContent — user-authored content

    const statusBadge = document.createElement('span');
    statusBadge.className = `badge badge-${task.status === 'active' ? 'active' : 'paused'}`;
    statusBadge.textContent = task.status === 'active' ? 'active' : 'paused'; // R8: enum value via textContent

    const actionsEl = document.createElement('div');
    actionsEl.className = 'task-actions';

    if (!isCoachTask) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-edit';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => showFormView(task));
      actionsEl.appendChild(editBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => handleDeleteTask(task.id, deleteBtn));

    actionsEl.appendChild(deleteBtn);

    li.appendChild(descEl);
    li.appendChild(exprEl);
    li.appendChild(actionEl);
    li.appendChild(statusBadge);
    li.appendChild(actionsEl);
    taskListEl.appendChild(li);
  }
}

// ------------------------------------------------------------------
// Coach setup and reset-memory (v1.18.0 ADR 018 + v1.20.0 ADR 020 D18)
// ------------------------------------------------------------------

/** Update coach section UI based on coach tasks in _tasks. */
function updateCoachSection() {
  if (!coachSectionEl) return;

  // v1.18.0 legacy status (still shown for back-compat; migration rewrites it on boot)
  const legacyCoachTask = _tasks.find((t) => t.description === COACH_TASK_DESCRIPTION);
  if (coachStatusEl) {
    const activeProfileTasks = _tasks.filter((t) => isCoachProfileMarker(t.description));
    if (activeProfileTasks.length > 0) {
      // v1.20.0: show multi-profile summary
      coachStatusEl.textContent = `${activeProfileTasks.length} profile${activeProfileTasks.length !== 1 ? 's' : ''} active`;
    } else if (legacyCoachTask) {
      coachStatusEl.textContent = `Active — fires daily at ${legacyCoachTask.expr || '(unknown)'}`;
    } else {
      coachStatusEl.textContent = 'Not set up';
    }
  }
}

/**
 * Select a profile in the multi-profile picker.
 * Updates button states, shows/hides weekday picker.
 * @param {string} profile — one of COACH_PROFILES
 */
function selectCoachProfile(profile) {
  if (!COACH_PROFILES.includes(profile)) return;
  _selectedProfile = profile;

  // Update profile button active states
  if (coachMultiProfileSetupEl) {
    coachMultiProfileSetupEl.querySelectorAll('.coach-profile-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.profile === profile);
      btn.setAttribute('aria-pressed', btn.dataset.profile === profile ? 'true' : 'false');
    });

    // Show/hide weekday picker
    if (coachWeekdayPickerEl) {
      coachWeekdayPickerEl.hidden = (profile !== 'weekly');
    }
  }
}

/**
 * Select a weekday for the weekly profile picker.
 * @param {number} dow — 0=Sun, 1=Mon ... 6=Sat
 */
function selectCoachWeekday(dow) {
  _selectedWeekday = dow;
  if (coachWeekdayPickerEl) {
    coachWeekdayPickerEl.querySelectorAll('.coach-weekday-btn').forEach((btn) => {
      const btnDow = parseInt(btn.dataset.dow, 10);
      btn.classList.toggle('active', btnDow === dow);
      btn.setAttribute('aria-pressed', btnDow === dow ? 'true' : 'false');
    });
  }
}

/** Handle "Save profile" button click — multi-profile setup. */
async function handleCoachProfileSave() {
  if (!_initData) return;
  const timeVal = coachProfileTimeEl ? coachProfileTimeEl.value.trim() : '';
  if (!timeVal || !/^\d{2}:\d{2}$/.test(timeVal)) {
    if (coachProfileSaveErrorEl) {
      coachProfileSaveErrorEl.textContent = 'Enter a valid time (HH:MM).';
      coachProfileSaveErrorEl.hidden = false;
    }
    return;
  }
  if (_selectedProfile === 'weekly' && (_selectedWeekday === null || _selectedWeekday === undefined)) {
    if (coachProfileSaveErrorEl) {
      coachProfileSaveErrorEl.textContent = 'Select a weekday for weekly profile.';
      coachProfileSaveErrorEl.hidden = false;
    }
    return;
  }
  if (coachProfileSaveErrorEl) coachProfileSaveErrorEl.hidden = true;
  if (coachProfileSaveEl) coachProfileSaveEl.disabled = true;

  // chatId: read from Telegram WebApp init data
  const twa = window.Telegram && window.Telegram.WebApp;
  const chatId = twa && twa.initDataUnsafe && twa.initDataUnsafe.user
    ? twa.initDataUnsafe.user.id
    : 0;

  const body = {
    profile: _selectedProfile,
    hhmm: timeVal,
    chatId,
  };
  if (_selectedProfile === 'weekly') {
    body.weekday = _selectedWeekday;
  }

  try {
    const res = await fetch('/api/webapp/coach/setup', {
      method: 'POST',
      headers: {
        Authorization: `tma ${_initData}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.status === 200 && data.ok === true) {
      const profileLabel = COACH_PROFILE_LABELS[_selectedProfile] || _selectedProfile;
      showToast(`Coach Jarvis (${profileLabel}) set up!`, TOAST_DEFAULT_MS);
      await fetchTasks();
    } else {
      if (coachProfileSaveErrorEl) {
        coachProfileSaveErrorEl.textContent = data.error || `Error ${data.code || res.status}`;
        coachProfileSaveErrorEl.hidden = false;
      }
    }
  } catch (err) {
    if (coachProfileSaveErrorEl) {
      coachProfileSaveErrorEl.textContent = `Network error: ${err.message}`;
      coachProfileSaveErrorEl.hidden = false;
    }
  } finally {
    if (coachProfileSaveEl) coachProfileSaveEl.disabled = false;
  }
}

/** Handle legacy "Set up Coach Jarvis" button click (v1.18.0 back-compat). */
async function handleCoachSetup() {
  if (!_initData) return;
  const timeVal = coachTimeInputEl ? coachTimeInputEl.value.trim() : '';
  if (!timeVal || !/^\d{1,2}:\d{2}$/.test(timeVal)) {
    if (coachSetupErrorEl) {
      coachSetupErrorEl.textContent = 'Enter a valid time (HH:MM).';
      coachSetupErrorEl.hidden = false;
    }
    return;
  }
  if (coachSetupErrorEl) coachSetupErrorEl.hidden = true;
  if (coachSetupBtnEl) coachSetupBtnEl.disabled = true;

  // chatId: read from Telegram WebApp init data
  const twa = window.Telegram && window.Telegram.WebApp;
  const chatId = twa && twa.initDataUnsafe && twa.initDataUnsafe.user
    ? twa.initDataUnsafe.user.id
    : 0;

  try {
    const res = await fetch('/api/webapp/coach/setup', {
      method: 'POST',
      headers: {
        Authorization: `tma ${_initData}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ time: timeVal, chatId }),
    });
    const data = await res.json();
    if (res.status === 200 && data.ok === true) {
      showToast('Coach Jarvis set up!', TOAST_DEFAULT_MS);
      await fetchTasks();
    } else {
      if (coachSetupErrorEl) {
        coachSetupErrorEl.textContent = data.error || `Error ${data.code || res.status}`;
        coachSetupErrorEl.hidden = false;
      }
    }
  } catch (err) {
    if (coachSetupErrorEl) {
      coachSetupErrorEl.textContent = `Network error: ${err.message}`;
      coachSetupErrorEl.hidden = false;
    }
  } finally {
    if (coachSetupBtnEl) coachSetupBtnEl.disabled = false;
  }
}

/** Handle "Reset Memory" button — two-tap pattern. */
async function handleResetMemory() {
  if (!_initData) return;

  if (!_resetMemoryArmed) {
    // First tap — arm
    _resetMemoryArmed = true;
    if (coachResetBtnEl) {
      coachResetBtnEl.textContent = 'Confirm reset?';
      coachResetBtnEl.classList.add('confirming');
    }
    _resetMemoryTimer = setTimeout(() => {
      _resetMemoryArmed = false;
      if (coachResetBtnEl) {
        coachResetBtnEl.textContent = 'Reset Memory';
        coachResetBtnEl.classList.remove('confirming');
      }
    }, 6000);
    return;
  }

  // Second tap — commit
  clearTimeout(_resetMemoryTimer);
  _resetMemoryArmed = false;
  if (coachResetBtnEl) {
    coachResetBtnEl.textContent = 'Reset Memory';
    coachResetBtnEl.classList.remove('confirming');
    coachResetBtnEl.disabled = true;
  }

  try {
    const res = await fetch('/api/webapp/coach/reset-memory?confirm=1', {
      method: 'POST',
      headers: { Authorization: `tma ${_initData}` },
    });
    const data = await res.json();
    if (res.status === 200 && data.ok === true) {
      showToast(`Memory reset (${data.deletedCount} entries removed).`, TOAST_DEFAULT_MS);
    } else {
      showToast(data.error || 'Reset failed.', TOAST_LONG_MS);
    }
  } catch (err) {
    showToast(`Reset failed: ${err.message}`, TOAST_LONG_MS);
  } finally {
    if (coachResetBtnEl) coachResetBtnEl.disabled = false;
  }
}

// ------------------------------------------------------------------
// API calls
// ------------------------------------------------------------------

async function fetchTasks() {
  if (!_initData) return;
  if (listLoadingEl) listLoadingEl.hidden = false;
  if (taskListEl) taskListEl.hidden = true;
  if (listErrorEl) listErrorEl.hidden = true;
  if (listRetryEl) listRetryEl.hidden = true;

  try {
    const res = await fetch('/api/webapp/scheduled', {
      headers: { Authorization: `tma ${_initData}` },
    });
    const data = await res.json();
    if (listLoadingEl) listLoadingEl.hidden = true;
    if (data.ok === true) {
      _tasks = data.tasks || [];
      renderTaskList(_tasks);
      updateCoachSection();
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

/** R5: double-submit guard + AbortController + 30s timeout. */
async function handleFormSubmit() {
  if (_cronSubmitInFlight) return; // R5 guard

  const description = taskDescEl ? taskDescEl.value.trim() : '';
  const action = taskActionEl ? taskActionEl.value.trim() : '';
  const expr = taskExprEl ? taskExprEl.value.trim() : '';
  const active = taskActiveEl ? taskActiveEl.checked : true;

  if (!expr) {
    if (formErrorEl) {
      formErrorEl.textContent = 'Cron expression is required.';
      formErrorEl.hidden = false;
    }
    return;
  }

  if (formErrorEl) formErrorEl.hidden = true;
  _cronSubmitInFlight = true;
  if (formSubmitEl) formSubmitEl.disabled = true;

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), CRON_SUBMIT_TIMEOUT_MS);

  try {
    const isEdit = _editingTask !== null;
    const url = isEdit
      ? `/api/webapp/scheduled/${encodeURIComponent(_editingTask.id)}`
      : '/api/webapp/scheduled';
    const method = isEdit ? 'PATCH' : 'POST';

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `tma ${_initData}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ description, action, expr, active }),
      signal: abortCtrl.signal,
    });

    const data = await res.json();
    if ((res.status === 200 || res.status === 201) && data.ok === true) {
      showToast(isEdit ? 'Task updated.' : 'Task created.', TOAST_DEFAULT_MS);
      showListView();
      await fetchTasks();
    } else {
      if (formErrorEl) {
        formErrorEl.textContent = data.error || `Error ${data.code || res.status}`;
        formErrorEl.hidden = false;
      }
    }
  } catch (err) {
    if (formErrorEl) {
      formErrorEl.textContent = err.name === 'AbortError'
        ? 'Request timed out. Please try again.'
        : `Network error: ${err.message}`;
      formErrorEl.hidden = false;
    }
  } finally {
    clearTimeout(timeoutId);
    _cronSubmitInFlight = false;
    if (formSubmitEl) formSubmitEl.disabled = false;
  }
}

let _deleteConfirmId = null;
let _deleteConfirmTimer = null;

function handleDeleteTask(taskId, btn) {
  if (_deleteConfirmId === taskId) {
    // Second tap — commit delete
    clearTimeout(_deleteConfirmTimer);
    _deleteConfirmId = null;
    _deleteConfirmTimer = null;
    btn.textContent = 'Delete';
    btn.classList.remove('confirming');
    commitDeleteTask(taskId);
    return;
  }

  // First tap — arm confirm
  if (_deleteConfirmId && _deleteConfirmTimer) {
    clearTimeout(_deleteConfirmTimer);
    // Reset previous button if any
    const prevBtn = taskListEl && taskListEl.querySelector('.btn-delete.confirming');
    if (prevBtn) {
      prevBtn.textContent = 'Delete';
      prevBtn.classList.remove('confirming');
    }
  }

  _deleteConfirmId = taskId;
  btn.textContent = 'Confirm?';
  btn.classList.add('confirming');

  _deleteConfirmTimer = setTimeout(() => {
    _deleteConfirmId = null;
    _deleteConfirmTimer = null;
    btn.textContent = 'Delete';
    btn.classList.remove('confirming');
  }, 6000);
}

async function commitDeleteTask(taskId) {
  try {
    const res = await fetch(`/api/webapp/scheduled/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      headers: { Authorization: `tma ${_initData}` },
    });
    const data = await res.json();
    if (res.status === 200 && data.ok === true) {
      showToast('Task deleted.', TOAST_DEFAULT_MS);
      await fetchTasks();
    } else {
      showToast(data.error || 'Delete failed.', TOAST_LONG_MS);
    }
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, TOAST_LONG_MS);
  }
}

// ------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  listViewEl = document.getElementById('list-view');
  taskFormEl = document.getElementById('task-form');
  formTitleEl = document.getElementById('form-title');
  newTaskBtnEl = document.getElementById('new-task-btn');
  taskListEl = document.getElementById('task-list');
  listLoadingEl = document.getElementById('list-loading');
  listEmptyEl = document.getElementById('list-empty');
  listErrorEl = document.getElementById('list-error');
  listRetryEl = document.getElementById('list-retry');
  taskDescEl = document.getElementById('task-description');
  taskActionEl = document.getElementById('task-action');
  taskExprEl = document.getElementById('task-expr');
  taskActiveEl = document.getElementById('task-active');
  formSubmitEl = document.getElementById('form-submit');
  formCancelEl = document.getElementById('form-cancel');
  formErrorEl = document.getElementById('form-error');
  previewBlockEl = document.getElementById('preview-block');
  previewListEl = document.getElementById('preview-list');
  previewWarningEl = document.getElementById('preview-warning');
  previewErrorEl = document.getElementById('preview-error');
  paramEveryNEl = document.getElementById('param-every-n');
  paramTimeEl = document.getElementById('param-time');
  paramIntervalEl = document.getElementById('param-interval');
  paramHourEl = document.getElementById('param-hour');
  paramMinuteEl = document.getElementById('param-minute');
  toastEl = document.getElementById('toast');

  populateHourSelect();

  if (!window.Telegram || !window.Telegram.WebApp) {
    if (listLoadingEl) {
      listLoadingEl.textContent = 'Open this from a /webapp button in Telegram.';
    }
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

  // Wire preset buttons
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectPreset(btn.dataset.preset);
    });
  });

  // Wire param selects to update raw expression + preview
  if (paramIntervalEl) {
    paramIntervalEl.addEventListener('change', () => {
      if (_activePreset === 'every_n_minutes') {
        const params = readPresetParams('every_n_minutes');
        if (taskExprEl) taskExprEl.value = presetToCron('every_n_minutes', params);
        schedulePreviewFetch();
      }
    });
  }

  if (paramHourEl) {
    paramHourEl.addEventListener('change', () => {
      if (_activePreset && _activePreset !== 'every_n_minutes' && _activePreset !== 'custom') {
        const params = readPresetParams(_activePreset);
        if (taskExprEl) taskExprEl.value = presetToCron(_activePreset, params);
        schedulePreviewFetch();
      }
    });
  }

  if (paramMinuteEl) {
    paramMinuteEl.addEventListener('change', () => {
      if (_activePreset && _activePreset !== 'every_n_minutes' && _activePreset !== 'custom') {
        const params = readPresetParams(_activePreset);
        if (taskExprEl) taskExprEl.value = presetToCron(_activePreset, params);
        schedulePreviewFetch();
      }
    });
  }

  // Wire raw expression field — updates preset detection + debounced preview
  if (taskExprEl) {
    taskExprEl.addEventListener('input', () => {
      const expr = taskExprEl.value.trim();
      const presetMatch = cronToPreset(expr);
      const targetPreset = presetMatch ? presetMatch.presetKey : 'custom';
      // Update preset buttons without triggering re-write of the raw field
      document.querySelectorAll('.preset-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.preset === targetPreset);
      });
      _activePreset = targetPreset;
      if (paramEveryNEl) paramEveryNEl.hidden = (targetPreset !== 'every_n_minutes');
      if (paramTimeEl) paramTimeEl.hidden = (
        targetPreset !== 'every_day' &&
        targetPreset !== 'every_weekday' &&
        targetPreset !== 'every_mwf' &&
        targetPreset !== 'every_weekend'
      );
      schedulePreviewFetch();
    });
  }

  // Wire form submit + cancel
  if (formSubmitEl) formSubmitEl.addEventListener('click', handleFormSubmit);
  if (formCancelEl) formCancelEl.addEventListener('click', showListView);

  // Wire new task button
  if (newTaskBtnEl) newTaskBtnEl.addEventListener('click', () => showFormView(null));

  // Wire retry button
  if (listRetryEl) listRetryEl.addEventListener('click', fetchTasks);

  // v1.18.0 ADR 018: coach section refs + wiring
  coachSectionEl = document.getElementById('coach-section');
  coachTimeInputEl = document.getElementById('coach-time-input');
  coachSetupBtnEl = document.getElementById('coach-setup-btn');
  coachSetupErrorEl = document.getElementById('coach-setup-error');
  coachStatusEl = document.getElementById('coach-status');
  coachResetBtnEl = document.getElementById('coach-reset-btn');

  if (coachSetupBtnEl) coachSetupBtnEl.addEventListener('click', handleCoachSetup);
  if (coachResetBtnEl) coachResetBtnEl.addEventListener('click', handleResetMemory);

  // v1.20.0 ADR 020 D18: multi-profile coach setup refs + wiring
  coachMultiProfileSetupEl = document.getElementById('coach-multi-profile-setup');
  coachProfileSaveEl = document.getElementById('coach-profile-save');
  coachProfileSaveErrorEl = document.getElementById('coach-profile-save-error');
  coachProfileTimeEl = document.getElementById('coach-profile-time');
  coachWeekdayPickerEl = document.getElementById('coach-weekday-picker');

  // Wire profile picker buttons
  if (coachMultiProfileSetupEl) {
    coachMultiProfileSetupEl.querySelectorAll('.coach-profile-btn').forEach((btn) => {
      btn.addEventListener('click', () => selectCoachProfile(btn.dataset.profile));
    });
  }

  // Wire weekday picker buttons
  if (coachWeekdayPickerEl) {
    coachWeekdayPickerEl.querySelectorAll('.coach-weekday-btn').forEach((btn) => {
      btn.addEventListener('click', () => selectCoachWeekday(parseInt(btn.dataset.dow, 10)));
    });
  }

  // Wire save button
  if (coachProfileSaveEl) coachProfileSaveEl.addEventListener('click', handleCoachProfileSave);

  // Initialize with default profile selected
  selectCoachProfile('morning');

  // Initial load
  fetchTasks();
});
