/**
 * Avengers plan render — pure HTML composition for the live TODO message
 * and the per-bot section of the final HTML deliverable (v1.22.19).
 *
 * Telegram message uses parse_mode='HTML' and these tags:
 *   <b> <i> <code> <a href> <blockquote> <blockquote expandable>
 *
 * `<blockquote expandable>` is the native collapsible primitive — default
 * collapsed, tap to expand. Boss asked for a Manus-style accordion; this is
 * the cleanest Telegram-native equivalent and avoids per-step callback infra.
 *
 * Bot brand colors / icons are kept restrained — one icon per step, no
 * gratuitous emoji decoration. Production-grade visual.
 */

import type { PlanRow, PlanStepRow } from '../memory/plans.js';

/** Status emoji shown next to each step row. */
const STATUS_EMOJI: Record<PlanStepRow['status'], string> = {
  pending: '⬜',
  in_progress: '🔄',
  done: '✅',
  failed: '❌',
};

/** Plan-level status emoji shown in the header. */
const PLAN_HEADER_EMOJI: Record<PlanRow['status'], string> = {
  active: '🔄',
  synthesizing: '✨',
  delivered: '✅',
  closed: '✅',
  aborted: '✕',
};

/** Display name for each bot. */
const BOT_DISPLAY: Record<string, string> = {
  'ai-jarvis': 'Jarvis',
  'ai-tony': 'Tony',
  'ai-natasha': 'Natasha',
  'ai-bruce': 'Bruce',
};

function botDisplayName(botName: string): string {
  return BOT_DISPLAY[botName] ?? botName;
}

/**
 * HTML-escape a string for safe inclusion in a Telegram parse_mode='HTML' message.
 * Telegram only requires escaping `<`, `>`, `&` (and `"` inside attribute values).
 */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Truncate a string to maxChars with an ellipsis if needed. */
function clip(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trimEnd() + '…';
}

/** Format an elapsed-seconds duration as "12s" / "1m 04s" / "1h 02m". */
export function formatElapsed(seconds: number): string {
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

/** Format the elapsed time since createdAt (ISO 8601). */
function elapsedSince(createdAtIso: string, nowMs: number = Date.now()): string {
  const createdMs = new Date(createdAtIso).getTime();
  if (Number.isNaN(createdMs)) return '—';
  return formatElapsed((nowMs - createdMs) / 1000);
}

/**
 * Render the Avengers TODO message as Telegram HTML.
 *
 * Layout:
 *   🛡️ AVENGERS · Operation #<id>
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   Task: <task>
 *
 *   <statusEmoji> <doneCount>/<total> done · <elapsed> elapsed
 *
 *   <step rows — each: emoji, num, bot, headline; expandable blockquote with detail>
 *
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   <plan-status footer line>
 */
export function renderTodoMessage(
  plan: PlanRow,
  steps: PlanStepRow[],
  opts: { nowMs?: number } = {},
): string {
  const nowMs = opts.nowMs ?? Date.now();
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'done').length;

  const headerEmoji = PLAN_HEADER_EMOJI[plan.status];
  const headerStatusLabel: Record<PlanRow['status'], string> = {
    active: 'In progress',
    synthesizing: 'Synthesizing deliverable',
    delivered: 'Delivered',
    closed: 'Closed',
    aborted: 'Aborted',
  };

  const lines: string[] = [];
  lines.push(`🛡️ <b>AVENGERS</b> · Operation #${plan.id}`);
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`<b>Task:</b> ${htmlEscape(clip(plan.task, 240))}`);
  lines.push('');
  lines.push(
    `${headerEmoji} <b>${headerStatusLabel[plan.status]}</b> · ${done}/${total} done · ${elapsedSince(plan.created_at, nowMs)} elapsed`,
  );
  lines.push('');

  for (const step of steps) {
    lines.push(renderStepRow(step));
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (plan.status === 'delivered' && plan.deliverable_path) {
    lines.push(`📎 Deliverable uploaded above.`);
  } else if (plan.status === 'synthesizing') {
    lines.push(`✨ Jarvis is composing the final deliverable.`);
  } else if (plan.status === 'aborted') {
    lines.push(`✕ Plan was closed before completion.`);
  } else {
    lines.push(`<i>Tap any step's quote bar to expand its detail.</i>`);
  }

  return lines.join('\n');
}

/** Render a single step row including its (expandable) detail block. */
function renderStepRow(step: PlanStepRow): string {
  const emoji = STATUS_EMOJI[step.status];
  const bot = botDisplayName(step.bot_name);
  const headlineText = step.summary && step.summary.trim().length > 0
    ? step.summary
    : step.request;
  const headline = htmlEscape(clip(headlineText, 160));

  const row = `${emoji} <b>${step.step_order}.</b> ${bot} — ${headline}`;

  // v1.22.25 — cap per-step detail at 400 chars (down from 1500). With 3+
  // specialists each producing long replies, the composed TODO message
  // exceeded Telegram's 4096-char message limit, causing edit failures.
  // The full content still lives in the HTML deliverable; the TODO is just
  // a status preview, not the deliverable itself.
  const TODO_DETAIL_CAP = 400;

  if (step.status === 'done' && step.detail && step.detail.trim().length > 0) {
    const detailHtml = htmlEscape(clip(step.detail, TODO_DETAIL_CAP));
    return `${row}\n<blockquote expandable>${detailHtml}</blockquote>`;
  }
  if (step.status === 'in_progress') {
    return `${row}\n<i>working on it…</i>`;
  }
  if (step.status === 'failed' && step.detail && step.detail.trim().length > 0) {
    const detailHtml = htmlEscape(clip(step.detail, TODO_DETAIL_CAP));
    return `${row}\n<blockquote expandable>${detailHtml}</blockquote>`;
  }
  return row;
}

/**
 * Render the Avengers HTML deliverable — a standalone styled HTML document
 * that gets uploaded to the chat at plan completion. Production-grade visual:
 * brand colors, system-font typography, mobile-responsive, no external assets.
 *
 * Each specialist's contribution gets its own section in their brand color.
 * The deliverable is composed AFTER all specialist steps complete — Jarvis
 * passes in the synthesized intro/outro, and per-step contributions come
 * straight from each step's detail field.
 */
export function renderHtmlDeliverable(params: {
  plan: PlanRow;
  steps: PlanStepRow[];
  intro: string;
  conclusion: string;
}): string {
  const { plan, steps, intro, conclusion } = params;
  const generatedAt = new Date().toISOString();

  const stepSections = steps
    .map((step) => renderHtmlStepSection(step))
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avengers Operation #${plan.id} — ${htmlEscape(clip(plan.task, 80))}</title>
<style>
  :root {
    --bg: #0b0e14;
    --surface: #131722;
    --surface-2: #1c2030;
    --border: #2a2f42;
    --text: #e6e8ee;
    --text-muted: #9aa0b4;
    --accent: #5fb3ff;
    --tony: #e63946;
    --tony-bg: rgba(230, 57, 70, 0.12);
    --tony-accent: #ffb84d;
    --natasha: #c2185b;
    --natasha-bg: rgba(194, 24, 91, 0.12);
    --natasha-accent: #ff6b6b;
    --bruce: #2ecc71;
    --bruce-bg: rgba(46, 204, 113, 0.12);
    --bruce-accent: #b2f2bb;
    --jarvis: #29b6f6;
    --jarvis-bg: rgba(41, 182, 246, 0.12);
    --jarvis-accent: #80d8ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    padding: 32px 16px;
  }
  .container { max-width: 760px; margin: 0 auto; }
  header {
    border-bottom: 1px solid var(--border);
    padding-bottom: 24px;
    margin-bottom: 32px;
  }
  .badge {
    display: inline-block;
    background: var(--surface-2);
    color: var(--text-muted);
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  h1 {
    font-size: 28px;
    margin: 0 0 8px;
    line-height: 1.15;
    letter-spacing: -0.02em;
    color: var(--text);
    font-weight: 700;
  }
  .meta {
    color: var(--text-muted);
    font-size: 12px;
    letter-spacing: 0.02em;
    margin-top: 8px;
  }
  /* v1.22.34 — request quote card matching the dashboard treatment */
  .request-card {
    margin: 14px 0 4px;
    background: linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 14px 18px 16px;
  }
  .request-label {
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .request-text {
    margin: 0;
    font-size: 14.5px;
    line-height: 1.55;
    color: var(--text);
    border-left: 3px solid var(--accent);
    padding: 2px 0 2px 14px;
    font-weight: 400;
  }
  .intro, .conclusion {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 24px;
    margin: 24px 0;
    color: var(--text);
  }
  .conclusion {
    border-left: 3px solid var(--accent);
  }
  section.contribution {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left-width: 4px;
    border-radius: 12px;
    padding: 20px 24px;
    margin: 16px 0;
  }
  section.contribution.tony { border-left-color: var(--tony); background: linear-gradient(180deg, var(--tony-bg) 0%, var(--surface) 60%); }
  section.contribution.natasha { border-left-color: var(--natasha); background: linear-gradient(180deg, var(--natasha-bg) 0%, var(--surface) 60%); }
  section.contribution.bruce { border-left-color: var(--bruce); background: linear-gradient(180deg, var(--bruce-bg) 0%, var(--surface) 60%); }
  section.contribution.jarvis { border-left-color: var(--jarvis); background: linear-gradient(180deg, var(--jarvis-bg) 0%, var(--surface) 60%); }
  section.contribution h2 {
    margin: 0 0 4px;
    font-size: 18px;
    font-weight: 600;
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  section.contribution h2 .role {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 13px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  section.contribution .step-num {
    color: var(--text-muted);
    font-weight: 400;
  }
  section.contribution .request {
    color: var(--text-muted);
    font-size: 14px;
    font-style: italic;
    margin: 4px 0 12px;
  }
  section.contribution .body {
    white-space: pre-wrap;
    color: var(--text);
  }
  footer {
    border-top: 1px solid var(--border);
    padding-top: 16px;
    margin-top: 40px;
    color: var(--text-muted);
    font-size: 12px;
    text-align: center;
  }
  @media (max-width: 600px) {
    body { padding: 16px 8px; font-size: 15px; }
    h1 { font-size: 22px; }
    section.contribution, .intro, .conclusion { padding: 16px 18px; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="badge">🛡️ Avengers</div>
    <h1>Operation #${plan.id}</h1>
    <div class="request-card">
      <div class="request-label">Request from Boss</div>
      <blockquote class="request-text">${htmlEscape(plan.task)}</blockquote>
    </div>
    <div class="meta">Generated ${htmlEscape(generatedAt)} · ${steps.length} contributors</div>
  </header>

  <div class="intro">${htmlEscape(intro).replace(/\n/g, '<br>')}</div>

  ${stepSections}

  <div class="conclusion"><strong>Conclusion.</strong> ${htmlEscape(conclusion).replace(/\n/g, '<br>')}</div>

  <footer>
    Composed by Jarvis · Avengers ensemble · v1.22.19
  </footer>
</div>
</body>
</html>`;
}

const ROLE_LABEL: Record<string, string> = {
  'ai-jarvis': 'Orchestrator',
  'ai-tony': 'Engineering',
  'ai-natasha': 'Research / Intelligence',
  'ai-bruce': 'Analysis / Reasoning',
};

const SECTION_CLASS: Record<string, string> = {
  'ai-jarvis': 'jarvis',
  'ai-tony': 'tony',
  'ai-natasha': 'natasha',
  'ai-bruce': 'bruce',
};

function renderHtmlStepSection(step: PlanStepRow): string {
  const cls = SECTION_CLASS[step.bot_name] ?? 'jarvis';
  const display = botDisplayName(step.bot_name);
  const role = ROLE_LABEL[step.bot_name] ?? '';
  const detail = step.detail && step.detail.trim().length > 0
    ? step.detail
    : (step.summary && step.summary.trim().length > 0 ? step.summary : '(no contribution recorded)');

  return `  <section class="contribution ${cls}">
    <h2><span class="step-num">${step.step_order}.</span> ${htmlEscape(display)} <span class="role">${htmlEscape(role)}</span></h2>
    <div class="request">Asked: ${htmlEscape(step.request)}</div>
    <div class="body">${htmlEscape(detail)}</div>
  </section>`;
}
