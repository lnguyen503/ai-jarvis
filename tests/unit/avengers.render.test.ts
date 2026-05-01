/**
 * Avengers plan render tests (v1.22.19).
 *
 * Verifies the renderer produces well-formed Telegram HTML with the
 * expected status emojis, expandable blockquotes for done steps, and the
 * deliverable HTML shape for the final upload.
 */

import { describe, it, expect } from 'vitest';
import { renderTodoMessage, renderHtmlDeliverable, htmlEscape, formatElapsed } from '../../src/avengers/render.js';
import { isSubstantiveWorkReply } from '../../src/avengers/lifecycle.js';
import type { PlanRow, PlanStepRow } from '../../src/memory/plans.js';

function plan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 1,
    chat_id: -1001,
    task: 'Plan a 4-bot deployment to AWS',
    status: 'active',
    todo_message_id: 100,
    deliverable_path: null,
    deliverable_message_id: null,
    created_at: new Date(Date.now() - 30_000).toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    ...overrides,
  };
}

function step(overrides: Partial<PlanStepRow> = {}): PlanStepRow {
  return {
    id: 10,
    plan_id: 1,
    step_order: 1,
    bot_name: 'ai-tony',
    request: 'Audit current infra',
    summary: null,
    detail: null,
    status: 'pending',
    expanded: 0,
    started_at: null,
    completed_at: null,
    delegate_message_id: 200,
    reply_message_id: null,
    ...overrides,
  };
}

describe('renderTodoMessage', () => {
  it('renders header, task, and step rows', () => {
    const html = renderTodoMessage(plan(), [
      step({ step_order: 1, bot_name: 'ai-tony', status: 'in_progress' }),
      step({ step_order: 2, bot_name: 'ai-natasha', status: 'pending' }),
    ]);
    expect(html).toContain('🛡️ <b>AVENGERS</b> · Operation #1');
    expect(html).toContain('Plan a 4-bot deployment to AWS');
    expect(html).toContain('🔄');
    expect(html).toContain('Tony');
    expect(html).toContain('Natasha');
    expect(html).toContain('0/2 done');
  });

  it('emits expandable blockquote for done steps with detail', () => {
    const html = renderTodoMessage(plan(), [
      step({
        step_order: 1,
        bot_name: 'ai-tony',
        status: 'done',
        summary: 'Audited infra, found 4 EC2 instances',
        detail: 'Region us-east-1.\nMonthly cost ~$120.\nBackups OK.',
        completed_at: new Date().toISOString(),
      }),
    ]);
    expect(html).toContain('<blockquote expandable>');
    expect(html).toContain('Region us-east-1.');
    expect(html).toContain('1/1 done');
  });

  it('escapes HTML special characters in task and step content', () => {
    const html = renderTodoMessage(plan({ task: 'Compare <foo> & "bar"' }), [
      step({
        status: 'done',
        summary: 'Found <script>alert(1)</script>',
        detail: 'Body & detail',
        completed_at: new Date().toISOString(),
      }),
    ]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;foo&gt;');
    expect(html).toContain('&amp;');
  });

  it('uses delivered footer once status is delivered', () => {
    const html = renderTodoMessage(
      plan({ status: 'delivered', deliverable_path: '/tmp/x.html' }),
      [step({ status: 'done', summary: 'done', detail: 'ok', completed_at: new Date().toISOString() })],
    );
    expect(html).toContain('Deliverable uploaded above');
    expect(html).toContain('Delivered');
  });
});

describe('renderHtmlDeliverable', () => {
  it('produces a complete HTML document with per-bot sections', () => {
    const html = renderHtmlDeliverable({
      plan: plan(),
      steps: [
        step({
          step_order: 1,
          bot_name: 'ai-tony',
          status: 'done',
          summary: 'Audited infra',
          detail: '4 EC2 instances on us-east-1.',
          completed_at: new Date().toISOString(),
        }),
        step({
          step_order: 2,
          bot_name: 'ai-natasha',
          status: 'done',
          summary: 'Pricing research',
          detail: 'Lightsail vs EC2 comparison.',
          completed_at: new Date().toISOString(),
        }),
      ],
      intro: 'Intro paragraph.',
      conclusion: 'Wrap-up.',
    });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Avengers Operation #1');
    expect(html).toContain('class="contribution tony"');
    expect(html).toContain('class="contribution natasha"');
    expect(html).toContain('Engineering');
    expect(html).toContain('Research / Intelligence');
    expect(html).toContain('Intro paragraph');
    expect(html).toContain('Wrap-up');
  });

  it('escapes user content in HTML deliverable', () => {
    const html = renderHtmlDeliverable({
      plan: plan({ task: '<evil> & "bar"' }),
      steps: [step({ status: 'done', summary: '<x>', detail: 'a & b', completed_at: new Date().toISOString() })],
      intro: '<intro>',
      conclusion: '<conclusion>',
    });
    expect(html).not.toMatch(/<x>(?!\/)/); // raw <x> not present
    expect(html).toContain('&lt;evil&gt;');
    expect(html).toContain('&lt;intro&gt;');
    expect(html).toContain('&lt;conclusion&gt;');
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45)).toBe('45s');
    expect(formatElapsed(59.9)).toBe('59s');
  });
  it('formats minutes with zero-padded seconds', () => {
    expect(formatElapsed(60)).toBe('1m 00s');
    expect(formatElapsed(125)).toBe('2m 05s');
  });
  it('formats hours and minutes', () => {
    expect(formatElapsed(3700)).toBe('1h 01m');
  });
});

describe('htmlEscape', () => {
  it('escapes <, >, &', () => {
    expect(htmlEscape('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });
});

describe('isSubstantiveWorkReply (v1.22.20)', () => {
  it('rejects short acks and pure punctuation', () => {
    expect(isSubstantiveWorkReply('.')).toBe(false);
    expect(isSubstantiveWorkReply('Copy.')).toBe(false);
    expect(isSubstantiveWorkReply('On it.')).toBe(false);
    expect(isSubstantiveWorkReply('Understood.')).toBe(false);
    expect(isSubstantiveWorkReply('—')).toBe(false);
    expect(isSubstantiveWorkReply('...')).toBe(false);
  });

  it('rejects sync-noise patterns even when long', () => {
    expect(
      isSubstantiveWorkReply(
        "I've already delivered my piece — rollout effort and risk. This one's for @your_tony_bot to weigh in on next.",
      ),
    ).toBe(false);
    expect(
      isSubstantiveWorkReply(
        "Already shipped this one — full implementation sketch is in the plan we just delivered earlier in the thread above.",
      ),
    ).toBe(false);
    expect(
      isSubstantiveWorkReply(
        "My piece is already done. If the tracker still shows me as pending, that's a sync issue on your side, not mine.",
      ),
    ).toBe(false);
    expect(
      isSubstantiveWorkReply(
        "Tony/Bruce — you're holding the Jarvis. Drop your files when ready. I'm cleared hot and standing by for the next round.",
      ),
    ).toBe(false);
  });

  it('accepts substantive work replies (≥100 chars, no sync-noise)', () => {
    const reply =
      'Audited current setup: 4 EC2 instances on us-east-1 (t3.medium), monthly cost ~$120 for compute. ' +
      'RDS db.t3.micro for shared SQLite-replacement. Backups OK. Suggest scaling assessment for 4-bot load.';
    expect(isSubstantiveWorkReply(reply)).toBe(true);
  });

  it('accepts a single-paragraph deliverable that looks like real work', () => {
    const reply =
      'Team Standup Digest — implementation approach.\n\n' +
      'Touch: src/coach/standupDigest.ts (new), src/scheduler/index.ts (cron entry), ' +
      'config/config.json (add coach.standupDigest section). Build steps: schema migration ' +
      'for digest_history table, then daily cron at 09:00 local time.';
    expect(isSubstantiveWorkReply(reply)).toBe(true);
  });
});
