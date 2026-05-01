/**
 * Avengers Operations Dashboard — app logic (v1.22.27)
 *
 * Vanilla JS, ES module. No bundler.
 *
 * Flow:
 *   1. Telegram WebApp SDK init → grab initData for HMAC auth
 *   2. Read URL params: ?planId=N&chatId=M
 *   3. If planId set → render single plan view; else render plan list
 *   4. Single plan view: poll /api/webapp/avengers/plans/:id every 2s while active
 *   5. Steps: click row → expand/collapse with animated max-height transition
 *   6. Deliverable: when plan.status==='delivered', show "Open Deliverable" CTA
 *
 * Security:
 *   - All user-authored content rendered via textContent (never innerHTML)
 *   - Auth: Authorization: tma <initData> header, exact match to /organize chain
 */

'use strict';

/* ========================================================================== */
/* Telegram WebApp init (optional — dashboard works in external browser too)  */
/* ========================================================================== */

// v1.22.29 — when opened from a `url` button in a supergroup, the page loads
// in the user's external browser (Telegram doesn't allow `web_app` buttons in
// groups). In that case there's no Telegram.WebApp SDK; we fall back to the
// chatId+planId query-param auth path on the backend.
const tg = window.Telegram?.WebApp;
if (tg) {
  try { tg.ready(); tg.expand(); } catch { /* ignore */ }
}
const initData = (tg && tg.initData) || '';

/* ========================================================================== */
/* URL params                                                                 */
/* ========================================================================== */

function readUrlParams() {
  // Telegram Web Apps strip query strings in some clients; use both ? and # fallbacks.
  const search = new URLSearchParams(window.location.search || '');
  const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const planId = parseInt(search.get('planId') ?? hash.get('planId') ?? '', 10);
  const chatId = parseInt(search.get('chatId') ?? hash.get('chatId') ?? '', 10);
  return {
    planId: Number.isFinite(planId) ? planId : null,
    chatId: Number.isFinite(chatId) ? chatId : null,
  };
}

const params = readUrlParams();

/* ========================================================================== */
/* DOM refs                                                                   */
/* ========================================================================== */

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  hdrStatus: $('hdr-status'),
  hdrTitle: $('hdr-title'),
  hdrTask: $('hdr-task'),
  hdrTaskText: $('hdr-task-text'),
  hdrMeta: $('hdr-meta'),
  loading: $('state-loading'),
  errorState: $('state-error'),
  errorText: $('error-text'),
  emptyState: $('state-empty'),
  listState: $('state-list'),
  detailState: $('state-detail'),
  planList: $('plan-list'),
  stepList: $('step-list'),
  deliverable: $('deliverable'),
  deliverableSub: $('deliverable-sub'),
  deliverableBtn: $('deliverable-btn'),
  deliverablePreview: $('deliverable-preview'),
  deliverableIframe: $('deliverable-iframe'),
  deliverablePreviewOpen: $('deliverable-preview-open'),
  backBtn: $('back-btn'),
  ftrPoll: $('ftr-poll'),
};

/* ========================================================================== */
/* Constants — bot display + role labels                                      */
/* ========================================================================== */

const BOT_DISPLAY = {
  'ai-jarvis':  'Jarvis',
  'ai-tony':    'Tony',
  'ai-natasha': 'Natasha',
  'ai-bruce':   'Bruce',
};

const BOT_ROLE = {
  'ai-jarvis':  'Orchestrator',
  'ai-tony':    'Engineering',
  'ai-natasha': 'Research',
  'ai-bruce':   'Analysis',
};

const STATUS_GLYPH = {
  pending:     '·',
  in_progress: '⟳',
  done:        '✓',
  failed:      '×',
};

const STATUS_LABEL = {
  active:       'In progress',
  synthesizing: 'Synthesizing',
  delivered:    'Delivered',
  closed:       'Closed',
  aborted:      'Aborted',
};

const STATUS_LIVE = new Set(['active', 'synthesizing']);

const POLL_INTERVAL_MS = 2000;

/* ========================================================================== */
/* State                                                                      */
/* ========================================================================== */

let pollTimer = null;
let currentPlanId = null;
const expandedSteps = new Set();
const expandedDebates = new Set(); // step ids whose debate panel is expanded
let lastDebatesByStep = new Map(); // stepId -> { rounds, debateStatus, debateRounds }

/* ========================================================================== */
/* Utility                                                                    */
/* ========================================================================== */

function setState(state) {
  els.app.dataset.state = state;
  for (const [name, el] of Object.entries({
    loading: els.loading,
    error: els.errorState,
    empty: els.emptyState,
    list: els.listState,
    detail: els.detailState,
  })) {
    el.hidden = name !== state;
  }
}

function showError(message) {
  if (!els.errorText) return;
  els.errorText.textContent = message;
  setState('error');
}

function authedFetch(path) {
  // v1.22.29 — when running inside Telegram (initData present), use the tma
  // header. When opened in an external browser (url button from a group),
  // append ?chatId=N so the backend's fallback-auth path accepts the request.
  const headers = initData ? { Authorization: `tma ${initData}` } : {};
  let finalPath = path;
  if (!initData && params.chatId != null) {
    const sep = path.includes('?') ? '&' : '?';
    if (!/[?&]chatId=/.test(path)) {
      finalPath = `${path}${sep}chatId=${params.chatId}`;
    }
  }
  return fetch(finalPath, { headers });
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatRelative(iso) {
  const t = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.text != null) node.textContent = opts.text;
  if (opts.cls) node.className = opts.cls;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, String(v));
  if (opts.children) for (const c of opts.children) if (c) node.appendChild(c);
  return node;
}

/* ========================================================================== */
/* Minimal Markdown → HTML renderer                                           */
/* ========================================================================== */
/**
 * Lightweight, safe markdown renderer for specialist work output (v1.22.32).
 * Supports: headers, bold, italic, code (inline + block), tables, lists,
 * blockquotes, horizontal rules, autolinks, paragraph breaks.
 *
 * Security: HTML-escapes input first, then applies markdown patterns. Output
 * is set via innerHTML, but only on already-escaped + transformed text we
 * generated — no unescaped user content reaches the DOM.
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(src) {
  if (typeof src !== 'string' || src.length === 0) return '';
  // Normalize line endings
  let text = src.replace(/\r\n?/g, '\n');

  // Extract fenced code blocks first (so their contents aren't markdown-processed)
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    codeBlocks.push({ lang, code: escapeHtml(code) });
    return ` CODEBLOCK${codeBlocks.length - 1} `;
  });

  // Escape rest
  text = escapeHtml(text);

  // Headers (## Header)
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule
  text = text.replace(/^---+$/gm, '<hr>');

  // Tables — | header | header |
  //          | --- | --- |
  //          | row | row |
  text = text.replace(/((?:^\|.*\|\s*\n)+)/gm, (block) => {
    const lines = block.trim().split('\n');
    if (lines.length < 2) return block;
    const isAlignmentRow = (s) => /^\|[\s\-:|]+\|$/.test(s.trim());
    if (!isAlignmentRow(lines[1])) return block;
    const splitRow = (line) =>
      line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const headers = splitRow(lines[0]);
    const bodyLines = lines.slice(2);
    const head = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
    const body = bodyLines.length === 0
      ? ''
      : `<tbody>${bodyLines.map((l) => `<tr>${splitRow(l).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
    return `<table>${head}${body}</table>`;
  });

  // Unordered lists — group consecutive `- ` or `* ` lines
  text = text.replace(/(?:^[\-*]\s+.+(?:\n|$))+/gm, (block) => {
    const items = block.trim().split(/\n/).map((l) => l.replace(/^[\-*]\s+/, ''));
    return `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  });

  // Ordered lists — group consecutive `1. `, `2. `, etc.
  text = text.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm, (block) => {
    const items = block.trim().split(/\n/).map((l) => l.replace(/^\d+\.\s+/, ''));
    return `<ol>${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
  });

  // Blockquotes — `> ` lines
  text = text.replace(/(?:^&gt;\s+.+(?:\n|$))+/gm, (block) => {
    const inner = block.trim().split(/\n/).map((l) => l.replace(/^&gt;\s+/, '')).join(' ');
    return `<blockquote>${inner}</blockquote>`;
  });

  // Bold (**text**)  — must run BEFORE italic so ** isn't grabbed by single *
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic (*text*) — single-asterisk
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Inline code (`code`)
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Autolinks — http(s) URLs that aren't already in a tag
  text = text.replace(/(^|[^"'\w])(https?:\/\/[^\s<]+)/g, (_m, lead, url) => {
    return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // Paragraphs — group consecutive non-block lines into <p>
  const paragraphed = text.split(/\n\n+/).map((para) => {
    const trimmed = para.trim();
    if (trimmed.length === 0) return '';
    // Already-block content: leave alone
    if (/^<(h\d|ul|ol|table|blockquote|pre|hr|p)/i.test(trimmed)) return trimmed;
    // Single-line content with hard breaks → join with <br>
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Restore code blocks
  return paragraphed.replace(/ CODEBLOCK(\d+) /g, (_m, idx) => {
    const cb = codeBlocks[parseInt(idx, 10)];
    const langClass = cb.lang ? ` class="language-${cb.lang}"` : '';
    return `<pre><code${langClass}>${cb.code}</code></pre>`;
  });
}

/* ========================================================================== */
/* Plan list view (?chatId=N, no planId)                                      */
/* ========================================================================== */

async function loadPlanList(chatId) {
  setState('loading');
  try {
    const res = await authedFetch(`/api/webapp/avengers/plans?chatId=${chatId}`);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      showError(`Failed to load operations (${res.status}). ${txt.slice(0, 120)}`);
      return;
    }
    const json = await res.json();
    const plans = Array.isArray(json.plans) ? json.plans : [];
    if (plans.length === 0) {
      setState('empty');
      return;
    }
    renderPlanList(plans);
    setState('list');
  } catch (err) {
    showError(`Network error: ${err && err.message ? err.message : err}`);
  }
}

function renderPlanList(plans) {
  els.hdrTitle.textContent = 'Operations';
  els.hdrMeta.textContent = `${plans.length} recent operation${plans.length === 1 ? '' : 's'}`;
  els.hdrStatus.hidden = true;
  if (els.hdrTask) els.hdrTask.hidden = true;
  els.planList.replaceChildren();

  for (const p of plans) {
    const card = el('li', { cls: 'plan-card', attrs: { tabindex: 0, role: 'button', 'data-plan-id': p.id } });
    card.appendChild(
      el('div', {
        cls: 'plan-card-row',
        children: [
          el('div', { cls: 'plan-card-id', text: `Operation #${p.id}` }),
          el('div', {
            cls: 'plan-card-status',
            text: (STATUS_LABEL[p.status] || p.status).toUpperCase(),
            attrs: { 'data-status': p.status },
          }),
        ],
      }),
    );
    card.appendChild(el('div', { cls: 'plan-card-task', text: p.task }));
    card.appendChild(
      el('div', {
        cls: 'plan-card-meta',
        text: `${p.doneCount}/${p.stepCount} steps · ${formatRelative(p.updatedAt)}`,
      }),
    );

    const open = () => loadPlanDetail(p.id, /* fromList */ true);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });

    els.planList.appendChild(card);
  }

  // Color the status pills
  for (const pill of els.planList.querySelectorAll('.plan-card-status')) {
    const status = pill.getAttribute('data-status');
    const colors = {
      active:       ['rgba(245, 158, 11, 0.18)', '#f59e0b'],
      synthesizing: ['rgba(168, 85, 247, 0.18)', '#a855f7'],
      delivered:    ['rgba(34, 197, 94, 0.18)', '#22c55e'],
      closed:       ['rgba(107, 114, 128, 0.18)', '#9ca3af'],
      aborted:      ['rgba(239, 68, 68, 0.18)', '#ef4444'],
    }[status] || ['rgba(107, 114, 128, 0.18)', '#9ca3af'];
    pill.style.background = colors[0];
    pill.style.color = colors[1];
  }
}

/* ========================================================================== */
/* Plan detail view                                                           */
/* ========================================================================== */

async function loadPlanDetail(planId, fromList = false) {
  setState('loading');
  currentPlanId = planId;
  els.backBtn.hidden = !fromList;
  if (els.backBtn.dataset.wired !== '1') {
    els.backBtn.addEventListener('click', () => {
      stopPolling();
      currentPlanId = null;
      if (params.chatId != null) loadPlanList(params.chatId);
    });
    els.backBtn.dataset.wired = '1';
  }

  await fetchAndRenderPlan(planId);
}

async function fetchAndRenderPlan(planId) {
  try {
    const [planRes, debatesRes] = await Promise.all([
      authedFetch(`/api/webapp/avengers/plans/${planId}`),
      authedFetch(`/api/webapp/avengers/plans/${planId}/debates`),
    ]);
    if (!planRes.ok) {
      const txt = await planRes.text().catch(() => '');
      showError(`Failed to load operation #${planId} (${planRes.status}). ${txt.slice(0, 120)}`);
      stopPolling();
      return;
    }
    const json = await planRes.json();
    if (!json.ok || !json.plan) {
      showError(json.error || 'Plan not found.');
      stopPolling();
      return;
    }

    // Best-effort debates fetch — page still renders if it fails.
    try {
      if (debatesRes.ok) {
        const debJson = await debatesRes.json();
        if (debJson.ok && Array.isArray(debJson.debates)) {
          lastDebatesByStep = new Map(
            debJson.debates.map((d) => [d.stepId, d]),
          );
        }
      }
    } catch { /* best-effort */ }

    renderPlan(json.plan, json.steps || []);
    setState('detail');

    // Live polling: keep fetching while plan is active or synthesizing.
    if (STATUS_LIVE.has(json.plan.status)) {
      startPolling();
    } else {
      stopPolling();
    }
  } catch (err) {
    showError(`Network error: ${err && err.message ? err.message : err}`);
    stopPolling();
  }
}

function renderPlan(plan, steps) {
  // Header — v1.22.33: "Operation #N" is the H1, user request is a styled
  // quote card below. Long prompts no longer get rendered as awkward H1s.
  els.hdrTitle.textContent = `Operation #${plan.id}`;
  if (els.hdrTask && els.hdrTaskText) {
    els.hdrTask.hidden = false;
    els.hdrTaskText.textContent = plan.task;
  }
  const elapsedSec = Math.max(0, (Date.now() - new Date(plan.createdAt).getTime()) / 1000);
  els.hdrMeta.textContent = `${plan.doneCount}/${plan.stepCount} steps · ${formatElapsed(elapsedSec)} elapsed`;

  els.hdrStatus.hidden = false;
  els.hdrStatus.dataset.status = plan.status;
  els.hdrStatus.replaceChildren();
  if (STATUS_LIVE.has(plan.status)) {
    els.hdrStatus.appendChild(el('span', { cls: 'pulse' }));
  }
  els.hdrStatus.appendChild(document.createTextNode(STATUS_LABEL[plan.status] || plan.status));

  // Steps
  els.stepList.replaceChildren();
  for (const s of steps) {
    els.stepList.appendChild(renderStepCard(s));
  }

  // Deliverable
  if (plan.status === 'delivered' && plan.deliverableFilename) {
    els.deliverable.hidden = false;
    els.deliverableSub.textContent = `Operation #${plan.id} · ${plan.deliverableFilename}`;
    // v1.22.30 — when running outside Telegram (no initData), append ?chatId
    // so the backend's fallback-auth path accepts the link click. Browser
    // navigation doesn't carry the Authorization header, only the URL.
    let href = `/api/webapp/avengers/plans/${plan.id}/deliverable`;
    if (!initData && params.chatId != null) {
      href += `?chatId=${params.chatId}`;
    }
    els.deliverableBtn.href = href;
    // v1.22.32 — embedded iframe preview of the deliverable HTML so users
    // see the polished output inline without an extra tab-switch. Same URL
    // as the Open button; iframe sandbox allows-same-origin so styles render.
    if (els.deliverableIframe && els.deliverablePreview) {
      // Only set src if it changed, to avoid re-loading the iframe on every poll.
      if (els.deliverableIframe.dataset.currentHref !== href) {
        els.deliverableIframe.src = href;
        els.deliverableIframe.dataset.currentHref = href;
      }
      if (els.deliverablePreviewOpen) els.deliverablePreviewOpen.href = href;
      els.deliverablePreview.hidden = false;
    }
  } else {
    els.deliverable.hidden = true;
    if (els.deliverablePreview) els.deliverablePreview.hidden = true;
    if (els.deliverableIframe) {
      els.deliverableIframe.removeAttribute('src');
      delete els.deliverableIframe.dataset.currentHref;
    }
  }

  // Footer poll indicator
  els.ftrPoll.hidden = !STATUS_LIVE.has(plan.status);
}

function avatarSlug(botName) {
  // 'ai-tony' -> 'tony'
  return botName.replace(/^ai-/, '');
}

function renderStepCard(step) {
  const card = el('li', {
    cls: 'step-card',
    attrs: {
      'data-bot': step.botName,
      'data-status': step.status,
      'data-expanded': expandedSteps.has(step.id) ? 'true' : 'false',
      'data-step-id': step.id,
    },
  });

  const summary = step.summary && step.summary.trim().length > 0 ? step.summary : null;
  const placeholderText = step.status === 'in_progress'
    ? 'Working on it…'
    : step.status === 'pending'
      ? 'Pending — waiting to start'
      : step.status === 'failed'
        ? 'Step failed'
        : '';

  // Avatar: round portrait + tiny status indicator dot bottom-right (v1.22.32).
  const avatarSrc = `./avatars/${avatarSlug(step.botName)}.png`;
  const avatar = el('div', {
    cls: 'step-avatar',
    children: [
      el('img', { attrs: { src: avatarSrc, alt: BOT_DISPLAY[step.botName] || step.botName, loading: 'lazy' } }),
      el('span', {
        cls: 'step-status-dot',
        attrs: { 'data-status': step.status, 'aria-hidden': 'true' },
        text: STATUS_GLYPH[step.status] || '·',
      }),
    ],
  });

  const head = el('button', {
    cls: 'step-head',
    attrs: { type: 'button', 'aria-expanded': expandedSteps.has(step.id) ? 'true' : 'false' },
    children: [
      avatar,
      el('div', {
        cls: 'step-body',
        children: [
          el('div', {
            cls: 'step-title-row',
            children: [
              el('span', { cls: 'step-num', text: `${step.stepOrder}.` }),
              el('span', { cls: 'step-bot', text: BOT_DISPLAY[step.botName] || step.botName }),
              el('span', { cls: 'step-role', text: BOT_ROLE[step.botName] || '' }),
            ],
          }),
          summary
            ? el('div', { cls: 'step-summary', text: summary })
            : el('div', { cls: 'step-summary placeholder', text: placeholderText }),
        ],
      }),
      el('span', { cls: 'step-chevron', text: '›', attrs: { 'aria-hidden': 'true' } }),
    ],
  });

  head.addEventListener('click', () => {
    const isExpanded = card.dataset.expanded === 'true';
    const next = !isExpanded;
    card.dataset.expanded = next ? 'true' : 'false';
    head.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) expandedSteps.add(step.id);
    else expandedSteps.delete(step.id);
  });

  card.appendChild(head);

  // Detail body — markdown rendered if specialist gave us markdown content (v1.22.32).
  const detail = el('div', { cls: 'step-detail' });
  detail.appendChild(
    el('div', {
      cls: 'request-line',
      children: [
        el('strong', { text: 'Asked: ' }),
        document.createTextNode(step.request),
      ],
    }),
  );
  const bodyText = (step.detail && step.detail.trim().length > 0)
    ? step.detail
    : (step.summary && step.summary.trim().length > 0)
      ? step.summary
      : (placeholderText || '(no contribution yet)');
  const bodyEl = el('div', { cls: 'body' });
  bodyEl.innerHTML = renderMarkdown(bodyText);
  detail.appendChild(bodyEl);
  if (step.startedAt || step.completedAt) {
    const times = el('div', { cls: 'timestamps' });
    if (step.startedAt) times.appendChild(el('span', { text: `Started ${formatRelative(step.startedAt)}` }));
    if (step.completedAt) times.appendChild(el('span', { text: `Done ${formatRelative(step.completedAt)}` }));
    detail.appendChild(times);
  }

  // v1.22.35 — debate transcript section. Only render when a debate ran
  // for this step (debateStatus !== 'none' and rounds exist).
  const debateData = lastDebatesByStep.get(step.id);
  if (debateData && debateData.debateStatus && debateData.debateStatus !== 'none' && Array.isArray(debateData.rounds) && debateData.rounds.length > 0) {
    detail.appendChild(renderDebateSection(step, debateData));
  }

  card.appendChild(detail);

  return card;
}

function renderDebateSection(step, debateData) {
  const isExpanded = expandedDebates.has(step.id);
  const wrap = el('div', {
    cls: 'step-debate',
    attrs: { 'data-expanded': isExpanded ? 'true' : 'false' },
  });

  const statusLabel = debateData.debateStatus === 'approved'
    ? `Approved · ${debateData.debateRounds} round${debateData.debateRounds === 1 ? '' : 's'}`
    : debateData.debateStatus === 'contested'
      ? `Contested · ${debateData.debateRounds} rounds`
      : 'Aborted';

  const head = el('button', {
    cls: 'step-debate-header',
    attrs: { type: 'button', 'aria-expanded': isExpanded ? 'true' : 'false' },
    children: [
      el('span', { cls: 'step-debate-icon', text: '🔬', attrs: { 'aria-hidden': 'true' } }),
      el('span', { cls: 'step-debate-title', text: 'Debate transcript' }),
      el('span', {
        cls: 'step-debate-badge',
        attrs: { 'data-status': debateData.debateStatus },
        text: statusLabel,
      }),
      el('span', { cls: 'step-debate-chevron', text: '›', attrs: { 'aria-hidden': 'true' } }),
    ],
  });
  // Style override: head needs to look button-y but be flex
  head.style.background = 'transparent';
  head.style.border = '0';
  head.style.color = 'inherit';
  head.style.font = 'inherit';
  head.style.width = '100%';
  head.style.textAlign = 'left';

  head.addEventListener('click', () => {
    const next = !(wrap.dataset.expanded === 'true');
    wrap.dataset.expanded = next ? 'true' : 'false';
    head.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) expandedDebates.add(step.id);
    else expandedDebates.delete(step.id);
  });

  wrap.appendChild(head);

  // Rounds container
  const roundsContainer = el('div', { cls: 'step-debate-rounds' });
  for (const round of debateData.rounds) {
    roundsContainer.appendChild(renderDebateRound(round));
  }
  wrap.appendChild(roundsContainer);

  return wrap;
}

function renderDebateRound(round) {
  const speakerLabel = round.speaker === 'specialist' ? 'Specialist' : 'Critic (Jarvis)';
  const card = el('div', {
    cls: 'debate-round',
    attrs: { 'data-speaker': round.speaker },
  });

  const head = el('div', {
    cls: 'debate-round-head',
    children: [
      el('span', { cls: 'debate-round-num', text: `Round ${round.round}` }),
      el('span', { cls: 'debate-round-speaker', text: speakerLabel }),
      el('span', { cls: 'debate-round-model', text: round.model }),
    ],
  });
  if (round.verdict) {
    head.appendChild(el('span', {
      cls: 'debate-round-verdict',
      attrs: { 'data-verdict': round.verdict },
      text: round.verdict,
    }));
  }
  card.appendChild(head);

  const body = el('div', { cls: 'debate-round-body' });
  body.innerHTML = renderMarkdown(round.text);
  card.appendChild(body);

  return card;
}

/* ========================================================================== */
/* Polling                                                                    */
/* ========================================================================== */

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (currentPlanId != null) fetchAndRenderPlan(currentPlanId);
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

window.addEventListener('beforeunload', stopPolling);

/* ========================================================================== */
/* Boot                                                                       */
/* ========================================================================== */

// v1.22.29 — accept either (a) Telegram WebApp initData (in-Telegram open),
// or (b) ?chatId=N URL param (external-browser open via url button). One of
// the two MUST be present for the backend to authenticate.
if (!initData && params.chatId == null) {
  showError('Open this from the Avengers dashboard button in your group chat.');
} else if (params.planId != null) {
  loadPlanDetail(params.planId, /* fromList */ false);
} else if (params.chatId != null) {
  loadPlanList(params.chatId);
} else {
  showError('No planId or chatId in URL. Open this from the Avengers dashboard button.');
}
