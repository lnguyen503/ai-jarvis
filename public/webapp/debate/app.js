/**
 * Debate webapp — Jarvis v1.16.0
 *
 * Vanilla JS, no framework, no bundler. ES module loaded via <script type="module" defer>.
 * Same-origin module imports under CSP `script-src 'self' https://telegram.org`.
 *
 * Security invariants (ADR 009, decision 6 — same as organize):
 *  - ALL user-authored content uses textContent ONLY — never innerHTML.
 *  - No native confirm() — toast + button pattern only.
 *  - No inline event handlers in HTML (CSP blocks them).
 *
 * SSE client (ADR 016 D3 — W4 + R1 cooperation):
 *  - Uses fetch() + response.body.getReader() (EventSource API lacks custom header support).
 *  - Reconnects with exponential backoff (1→30s) on connection drop.
 *  - Re-fetches snapshot first, then resumes streaming.
 *  - Closes SSE stream on detail view exit.
 *
 * Auth: HMAC chain via Authorization: tma <initData> header (ADR 016 D3 / ADR 008 R5).
 *
 * Views:
 *  - List view: list of past debates from GET /api/webapp/debates
 *  - Detail view: side-by-side debater columns + SSE streaming for running debates
 *
 * Pagination: GET /api/webapp/debates?limit=50 (ADR 016 D11 default).
 * Per-user scope: server filters by authenticated userId (no cross-user data).
 *
 * v1.16.0 — ADR 016 D1/D3/D4/D5/D11/D12/D13/D14.
 */

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Exponential backoff base/cap for SSE reconnect (D4). */
const SSE_BACKOFF_BASE_MS  = 1000;
const SSE_BACKOFF_CAP_MS   = 30000;

/** List page size (D11 default). */
const DEBATE_LIST_LIMIT = 50;

/** Toast duration. */
const TOAST_MS = 3000;

// ------------------------------------------------------------------
// Module-level state
// ------------------------------------------------------------------

/** Telegram initData string — populated at boot. */
let initData = '';

/** Current SSE stream reader (if any) — closed on detail exit. */
let _sseReader = null;

/** Whether the SSE stream is intentionally closed (no reconnect). */
let _sseClosed = false;

/** Current reconnect backoff in ms. */
let _sseBackoff = SSE_BACKOFF_BASE_MS;

/** Reconnect timeout handle. */
let _sseReconnectTimer = null;

/** The currently-viewed debate run ID (null when in list view). */
let _currentRunId = null;

/** Map of debaterName → { el: HTMLElement (turns container), count: number } */
let _debaterCols = {};

// ------------------------------------------------------------------
// Telegram WebApp initialization
// ------------------------------------------------------------------

const twa = window.Telegram?.WebApp;

function applyTheme() {
  const tp = twa?.themeParams || {};
  const root = document.documentElement;
  if (tp.bg_color)             root.style.setProperty('--bg-color', tp.bg_color);
  if (tp.text_color)           root.style.setProperty('--text-color', tp.text_color);
  if (tp.hint_color)           root.style.setProperty('--hint-color', tp.hint_color);
  if (tp.button_color)         root.style.setProperty('--button-bg', tp.button_color);
  if (tp.button_text_color)    root.style.setProperty('--button-text', tp.button_text_color);
  if (tp.secondary_bg_color)   root.style.setProperty('--secondary-bg', tp.secondary_bg_color);
}

// ------------------------------------------------------------------
// DOM element cache
// ------------------------------------------------------------------

let listViewEl, listLoadingEl, debateListEl, listEmptyEl, listErrorEl, listRetryEl;
let detailViewEl, detailBackEl, liveIndicatorEl, detailTopicEl, detailMetaEl;
let debaterColumnsEl, verdictSectionEl, verdictContentEl, toastEl;

// ------------------------------------------------------------------
// Toast
// ------------------------------------------------------------------

let _toastTimer = null;

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message; // textContent — never innerHTML
  toastEl.hidden = false;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (toastEl) toastEl.hidden = true;
  }, TOAST_MS);
}

// ------------------------------------------------------------------
// View transitions
// ------------------------------------------------------------------

function showListView() {
  if (listViewEl) listViewEl.hidden = false;
  if (detailViewEl) detailViewEl.hidden = true;
  if (twa?.BackButton) {
    twa.BackButton.hide();
  }
}

function showDetailView() {
  if (listViewEl) listViewEl.hidden = true;
  if (detailViewEl) detailViewEl.hidden = false;
  if (twa?.BackButton) {
    twa.BackButton.show();
  }
}

// ------------------------------------------------------------------
// List view — fetch and render
// ------------------------------------------------------------------

async function loadDebateList() {
  if (!initData) {
    if (listErrorEl) {
      listErrorEl.textContent = 'Not authenticated. Open from a /webapp button in Telegram.';
      listErrorEl.hidden = false;
    }
    if (listLoadingEl) listLoadingEl.hidden = true;
    return;
  }

  if (listLoadingEl) listLoadingEl.hidden = false;
  if (listErrorEl)   listErrorEl.hidden = true;
  if (debateListEl)  debateListEl.hidden = true;
  if (listEmptyEl)   listEmptyEl.hidden = true;
  if (listRetryEl)   listRetryEl.hidden = true;

  try {
    const res = await fetch(`/api/webapp/debates?limit=${DEBATE_LIST_LIMIT}`, {
      method: 'GET',
      headers: { Authorization: `tma ${initData}` },
    });
    const data = await res.json();

    if (listLoadingEl) listLoadingEl.hidden = true;

    if (!data.ok) {
      const msg = data.error || `Error ${data.code || res.status}`;
      if (listErrorEl) {
        listErrorEl.textContent = msg; // textContent only
        listErrorEl.hidden = false;
      }
      if (listRetryEl) listRetryEl.hidden = false;
      return;
    }

    const debates = data.debates || [];
    if (debates.length === 0) {
      if (listEmptyEl) listEmptyEl.hidden = false;
      return;
    }

    renderDebateList(debates);
    if (debateListEl) debateListEl.hidden = false;
  } catch (err) {
    if (listLoadingEl) listLoadingEl.hidden = true;
    if (listErrorEl) {
      listErrorEl.textContent = `Failed to load debates: ${err.message}`;
      listErrorEl.hidden = false;
    }
    if (listRetryEl) listRetryEl.hidden = false;
  }
}

/**
 * Render the list of debate rows.
 * All user-authored text uses textContent — never innerHTML.
 *
 * @param {Array} debates
 */
function renderDebateList(debates) {
  if (!debateListEl) return;
  debateListEl.innerHTML = ''; // safe clear of our own container

  for (const debate of debates) {
    const li = document.createElement('li');
    li.className = 'debate-row';
    li.setAttribute('role', 'listitem');
    li.setAttribute('tabindex', '0');

    // Main content
    const main = document.createElement('div');
    main.className = 'debate-row-main';

    const topicEl = document.createElement('div');
    topicEl.className = 'debate-topic';
    topicEl.textContent = debate.topic || '(no topic)'; // textContent — user-authored

    const metaEl = document.createElement('div');
    metaEl.className = 'debate-meta';
    const date = debate.createdAt ? new Date(debate.createdAt).toLocaleDateString() : '';
    const rounds = `${debate.roundsCompleted}/${debate.roundsTarget} rounds`;
    const participants = `${debate.participantCount} debaters`;
    metaEl.textContent = [date, rounds, participants].filter(Boolean).join(' · ');

    main.appendChild(topicEl);
    main.appendChild(metaEl);

    // Status badge
    const badge = document.createElement('span');
    badge.className = `debate-status-badge ${debate.status || ''}`;
    badge.textContent = debate.status || '';

    li.appendChild(main);
    li.appendChild(badge);

    // Click / keyboard handler
    const openDebate = () => openDetailView(debate.id, debate.status);
    li.addEventListener('click', openDebate);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDebate();
      }
    });

    debateListEl.appendChild(li);
  }
}

// ------------------------------------------------------------------
// Detail view — open, fetch snapshot, start SSE
// ------------------------------------------------------------------

/**
 * Open the detail view for a debate.
 * Fetches the snapshot, renders columns, then starts SSE if running.
 *
 * @param {string} runId
 * @param {string} [status]
 */
async function openDetailView(runId, status) {
  _currentRunId = runId;
  _debaterCols = {};
  closeSse(); // close any previous stream

  // Clear previous content
  if (debaterColumnsEl) debaterColumnsEl.innerHTML = ''; // safe clear of our own container
  if (verdictSectionEl) verdictSectionEl.hidden = true;
  if (verdictContentEl) verdictContentEl.textContent = '';
  if (liveIndicatorEl)  liveIndicatorEl.hidden = true;
  if (detailTopicEl)    detailTopicEl.textContent = '';
  if (detailMetaEl)     detailMetaEl.textContent = '';

  showDetailView();

  // Fetch snapshot
  try {
    const res = await fetch(`/api/webapp/debates/${encodeURIComponent(runId)}`, {
      method: 'GET',
      headers: { Authorization: `tma ${initData}` },
    });
    const data = await res.json();

    if (!data.ok) {
      showToast(data.error || 'Failed to load debate');
      showListView();
      return;
    }

    renderDetailSnapshot(data.debate);

    // If running, start SSE
    if (data.debate.status === 'running') {
      startSse(runId);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
    showListView();
  }
}

/**
 * Render the full debate snapshot into the detail view.
 * All user-authored content uses textContent — never innerHTML.
 *
 * @param {object} debate — debate snapshot from GET /api/webapp/debates/:id
 */
function renderDetailSnapshot(debate) {
  if (!debate) return;

  // Topic + meta
  if (detailTopicEl) detailTopicEl.textContent = debate.topic || '(no topic)';
  if (detailMetaEl) {
    const date = debate.createdAt ? new Date(debate.createdAt).toLocaleDateString() : '';
    const rounds = `${debate.roundsCompleted}/${debate.roundsTarget} rounds`;
    const participants = `${debate.participantCount} debaters`;
    detailMetaEl.textContent = [date, rounds, participants].filter(Boolean).join(' · ');
  }

  // Build debater columns from model lineup
  if (debaterColumnsEl && Array.isArray(debate.modelLineup)) {
    debaterColumnsEl.innerHTML = ''; // safe clear
    _debaterCols = {};

    for (const debater of debate.modelLineup) {
      const colEl = buildDebaterColumn(debater.debaterName, debater.modelName);
      debaterColumnsEl.appendChild(colEl);
    }
  }

  // Populate rounds into the appropriate columns
  if (Array.isArray(debate.rounds)) {
    for (const round of debate.rounds) {
      appendTurnToColumn(round.debaterName, round.roundNumber, round.content);
    }
  }

  // Verdict
  if (debate.status !== 'running' && debate.verdict) {
    renderVerdict(debate.verdict, debate.reasoning);
  }
}

/**
 * Build a debater column element (collapsible on mobile, visible on desktop).
 *
 * @param {string} debaterName
 * @param {string} modelName
 * @returns {HTMLElement}
 */
function buildDebaterColumn(debaterName, modelName) {
  const details = document.createElement('details');
  details.className = 'debater-column';
  details.open = true; // open by default; CSS grid handles layout on desktop
  details.setAttribute('role', 'listitem');
  details.dataset.debater = debaterName;

  const summary = document.createElement('summary');
  summary.className = 'debater-column-header';

  const nameEl = document.createElement('span');
  nameEl.className = 'debater-name';
  nameEl.textContent = debaterName; // textContent — user-authored

  const modelEl = document.createElement('span');
  modelEl.className = 'debater-model';
  modelEl.textContent = modelName; // textContent

  const roundsEl = document.createElement('span');
  roundsEl.className = 'debater-rounds';
  roundsEl.textContent = '0 turns';
  roundsEl.dataset.rounds = '0';

  summary.appendChild(nameEl);
  summary.appendChild(modelEl);
  summary.appendChild(roundsEl);
  details.appendChild(summary);

  const turnsEl = document.createElement('div');
  turnsEl.className = 'debater-turns';
  details.appendChild(turnsEl);

  _debaterCols[debaterName] = { el: turnsEl, roundsEl, count: 0 };

  return details;
}

/**
 * Append a turn (round content) to the appropriate debater column.
 * textContent only — never innerHTML.
 *
 * @param {string} debaterName
 * @param {number} roundNumber
 * @param {string} content
 */
function appendTurnToColumn(debaterName, roundNumber, content) {
  const col = _debaterCols[debaterName];
  if (!col) return;

  const item = document.createElement('div');
  item.className = 'turn-item';

  const label = document.createElement('div');
  label.className = 'turn-round-label';
  label.textContent = `Round ${roundNumber}`; // not user-authored (integer)

  const text = document.createElement('div');
  text.textContent = content; // textContent — user-authored debate text

  item.appendChild(label);
  item.appendChild(text);
  col.el.appendChild(item);

  // Update turn count
  col.count++;
  if (col.roundsEl) {
    col.roundsEl.textContent = `${col.count} turn${col.count !== 1 ? 's' : ''}`;
    col.roundsEl.dataset.rounds = String(col.count);
  }

  // Scroll to bottom of this column's turns container
  col.el.scrollTop = col.el.scrollHeight;
}

/**
 * Render the verdict section.
 * textContent only — never innerHTML.
 *
 * @param {object|string} verdict
 * @param {string|null} reasoning
 */
function renderVerdict(verdict, reasoning) {
  if (!verdictSectionEl || !verdictContentEl) return;

  verdictContentEl.textContent = ''; // safe clear

  if (typeof verdict === 'string') {
    const p = document.createElement('p');
    p.textContent = verdict; // textContent
    verdictContentEl.appendChild(p);
  } else if (verdict && typeof verdict === 'object') {
    const p = document.createElement('p');
    p.textContent = JSON.stringify(verdict, null, 2); // structured verdict
    verdictContentEl.appendChild(p);
  }

  if (reasoning) {
    const reasoningHeader = document.createElement('p');
    reasoningHeader.style.fontWeight = '600';
    reasoningHeader.style.marginTop = '0.75rem';
    reasoningHeader.textContent = 'Reasoning:';
    verdictContentEl.appendChild(reasoningHeader);

    const reasoningText = document.createElement('p');
    reasoningText.textContent = reasoning; // textContent — never innerHTML
    verdictContentEl.appendChild(reasoningText);
  }

  verdictSectionEl.hidden = false;
}

// ------------------------------------------------------------------
// SSE client — fetch() + ReadableStream (D3)
// Reconnect with exponential backoff (D4).
// ------------------------------------------------------------------

/**
 * Start streaming SSE events for a debate run.
 * Uses fetch() + response.body.getReader() — EventSource API lacks custom header support.
 *
 * @param {string} runId
 */
function startSse(runId) {
  _sseClosed = false;
  _sseBackoff = SSE_BACKOFF_BASE_MS;
  connectSse(runId);
}

/**
 * Connect (or reconnect) the SSE stream.
 * Re-fetches the snapshot first (idempotent rounds via UNIQUE constraint),
 * then opens the stream.
 *
 * @param {string} runId
 */
async function connectSse(runId) {
  if (_sseClosed || _currentRunId !== runId) return;

  if (liveIndicatorEl) liveIndicatorEl.hidden = false;

  try {
    const res = await fetch(`/api/webapp/debates/${encodeURIComponent(runId)}/stream`, {
      method: 'GET',
      headers: {
        Authorization: `tma ${initData}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });

    if (!res.ok) {
      scheduleReconnect(runId);
      return;
    }

    if (!res.body) {
      scheduleReconnect(runId);
      return;
    }

    // Reset backoff on successful connection
    _sseBackoff = SSE_BACKOFF_BASE_MS;

    _sseReader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Read loop
    while (true) {
      let readResult;
      try {
        readResult = await _sseReader.read();
      } catch {
        // Stream broken — schedule reconnect
        break;
      }

      if (readResult.done) break;
      if (_sseClosed || _currentRunId !== runId) break;

      buffer += decoder.decode(readResult.value, { stream: true });

      // Process complete SSE messages (separated by double newline)
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || ''; // last part may be incomplete

      for (const block of parts) {
        if (!block.trim()) continue;
        processSseBlock(block, runId);
      }
    }
  } catch {
    // fetch error — schedule reconnect
  }

  if (_sseReader) {
    try { _sseReader.cancel(); } catch { /* ignore */ }
    _sseReader = null;
  }

  if (!_sseClosed && _currentRunId === runId) {
    scheduleReconnect(runId);
  } else {
    if (liveIndicatorEl) liveIndicatorEl.hidden = true;
  }
}

/**
 * Parse and dispatch a single SSE message block.
 *
 * @param {string} block — raw SSE block (one or more "field: value" lines)
 * @param {string} runId
 */
function processSseBlock(block, runId) {
  if (_currentRunId !== runId) return;

  // Parse SSE fields
  let eventType = 'message';
  let dataStr = '';

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataStr = line.slice(5).trim();
    }
    // Ignore ':' comment lines (keepalive)
  }

  if (!dataStr) return;

  let payload;
  try { payload = JSON.parse(dataStr); } catch { return; }

  if (eventType === 'round' && payload) {
    appendTurnToColumn(payload.debaterName, payload.roundNumber, payload.content);
  } else if (eventType === 'verdict' && payload) {
    renderVerdict(payload.verdict, payload.reasoning);
  } else if (eventType === 'complete') {
    // Terminal event — stop streaming
    // NOTE: server never emits 'aborted'; both abort paths emit 'error' (debates.stream.ts).
    // The dead 'aborted' branch was removed in v1.16.0 fix loop (F3).
    closeSse();
    if (liveIndicatorEl) liveIndicatorEl.hidden = true;
  } else if (eventType === 'error') {
    closeSse();
    if (liveIndicatorEl) liveIndicatorEl.hidden = true;
    showToast('Streaming error');
  }
}

/**
 * Schedule a reconnect with exponential backoff.
 *
 * @param {string} runId
 */
function scheduleReconnect(runId) {
  if (_sseClosed || _currentRunId !== runId) return;

  if (_sseReconnectTimer) clearTimeout(_sseReconnectTimer);
  _sseReconnectTimer = setTimeout(() => {
    _sseReconnectTimer = null;
    connectSse(runId);
  }, _sseBackoff);

  // Double backoff, cap at 30s
  _sseBackoff = Math.min(_sseBackoff * 2, SSE_BACKOFF_CAP_MS);
}

/**
 * Close the SSE stream intentionally (no reconnect).
 */
function closeSse() {
  _sseClosed = true;
  if (_sseReconnectTimer) {
    clearTimeout(_sseReconnectTimer);
    _sseReconnectTimer = null;
  }
  if (_sseReader) {
    try { _sseReader.cancel(); } catch { /* ignore */ }
    _sseReader = null;
  }
}

// ------------------------------------------------------------------
// Back button — return from detail to list
// ------------------------------------------------------------------

function handleDetailBack() {
  closeSse();
  _currentRunId = null;
  _debaterCols = {};
  showListView();
  // Reload list to pick up any status changes
  loadDebateList();
}

// ------------------------------------------------------------------
// DOMContentLoaded — initialization
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Cache DOM elements
  listViewEl       = document.getElementById('list-view');
  listLoadingEl    = document.getElementById('list-loading');
  debateListEl     = document.getElementById('debate-list');
  listEmptyEl      = document.getElementById('list-empty');
  listErrorEl      = document.getElementById('list-error');
  listRetryEl      = document.getElementById('list-retry');
  detailViewEl     = document.getElementById('detail-view');
  detailBackEl     = document.getElementById('detail-back');
  liveIndicatorEl  = document.getElementById('live-indicator');
  detailTopicEl    = document.getElementById('detail-topic');
  detailMetaEl     = document.getElementById('detail-meta');
  debaterColumnsEl = document.getElementById('debater-columns');
  verdictSectionEl = document.getElementById('verdict-section');
  verdictContentEl = document.getElementById('verdict-content');
  toastEl          = document.getElementById('toast');

  // Apply Telegram theme
  if (twa) {
    applyTheme();
    twa.onEvent('themeChanged', applyTheme);
    twa.ready();
    twa.expand();
  }

  // Wire back buttons
  if (detailBackEl) {
    detailBackEl.addEventListener('click', handleDetailBack);
  }

  // Telegram BackButton (R7 pattern — stable handler)
  if (twa?.BackButton) {
    twa.BackButton.onClick(handleDetailBack);
  }

  // Wire list retry
  if (listRetryEl) {
    listRetryEl.addEventListener('click', loadDebateList);
  }

  // Auth check
  const twaData = twa?.initData || '';
  if (!twaData) {
    if (listLoadingEl) listLoadingEl.hidden = true;
    if (listErrorEl) {
      listErrorEl.textContent = 'Open this from a /webapp button in Telegram.';
      listErrorEl.hidden = false;
    }
    return;
  }

  initData = twaData;

  // Initial list load
  loadDebateList();
});
