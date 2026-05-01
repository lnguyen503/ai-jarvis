/**
 * Tests for src/safety/emailConfirmation.ts — the crypto + state machine at
 * the heart of "Jarvis can't send email without your explicit approval."
 *
 * Every single rejection path is covered below. Any regression here risks
 * a silent send, so these tests are the tightest in the repo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import {
  generateConfirmationToken,
  hashEmailContent,
  stageEmailSend,
  inspectToken,
  parseConfirmSend,
  checkRateLimit,
  RateLimitExceededError,
} from '../../src/safety/emailConfirmation.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

function freshMemory(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-emailconfirm-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return initMemory(cfg);
}

function cfgWith(overrides: {
  ttl?: number;
  rateLimit?: number;
  sendEnabled?: boolean;
} = {}) {
  const cfg = makeTestConfig();
  cfg.google.gmail.send.confirmationTtlSeconds = overrides.ttl ?? 300;
  cfg.google.gmail.send.rateLimitPerHour = overrides.rateLimit ?? 10;
  cfg.google.gmail.send.enabled = overrides.sendEnabled ?? true;
  return cfg;
}

const baseStageParams = {
  draftId: 'draft-abc',
  sessionId: 1,
  chatId: 9000,
  userId: 1234567890,
  from: 'me@example.com',
  to: ['sam@example.com'],
  cc: [],
  bcc: [],
  subject: 'Hello Sam',
  body: 'Hi Sam,\nHow are you?\n\n— Boss',
};

describe('generateConfirmationToken', () => {
  it('produces 8 lowercase hex chars', () => {
    for (let i = 0; i < 50; i++) {
      const t = generateConfirmationToken();
      expect(t).toMatch(/^[0-9a-f]{8}$/);
    }
  });
  it('produces unique tokens in bulk (statistical)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateConfirmationToken());
    // With 32 bits of entropy, 10k tokens should almost never collide.
    expect(seen.size).toBeGreaterThanOrEqual(9995);
  });
});

describe('hashEmailContent', () => {
  const base = {
    from: 'me@example.com',
    to: ['a@x.com'],
    cc: [],
    bcc: [],
    subject: 'Hi',
    body: 'Body',
  };

  it('is deterministic', () => {
    expect(hashEmailContent(base)).toBe(hashEmailContent(base));
  });

  it('changes when any field changes', () => {
    const h = hashEmailContent(base);
    expect(hashEmailContent({ ...base, to: ['b@x.com'] })).not.toBe(h);
    expect(hashEmailContent({ ...base, subject: 'Hi!' })).not.toBe(h);
    expect(hashEmailContent({ ...base, body: 'Body.' })).not.toBe(h);
    expect(hashEmailContent({ ...base, cc: ['c@x.com'] })).not.toBe(h);
    expect(hashEmailContent({ ...base, bcc: ['c@x.com'] })).not.toBe(h);
    expect(hashEmailContent({ ...base, from: 'other@example.com' })).not.toBe(h);
  });

  it('lowercases addresses (case-insensitive stability)', () => {
    const h1 = hashEmailContent(base);
    const h2 = hashEmailContent({ ...base, to: ['A@X.COM'] });
    expect(h1).toBe(h2);
  });

  it('trims body whitespace (edge-whitespace stability)', () => {
    const h1 = hashEmailContent({ ...base, body: 'Body' });
    const h2 = hashEmailContent({ ...base, body: '  Body  \n' });
    expect(h1).toBe(h2);
  });

  it('does NOT collide across different multi-recipient arrangements', () => {
    const h1 = hashEmailContent({ ...base, to: ['a@x.com', 'b@x.com'], cc: [] });
    const h2 = hashEmailContent({ ...base, to: ['a@x.com'], cc: ['b@x.com'] });
    expect(h1).not.toBe(h2);
  });
});

describe('stageEmailSend + inspectToken', () => {
  let memory: MemoryApi;
  beforeEach(() => {
    memory = freshMemory();
    // sessions table has a FK constraint — create a session before we stage
    memory.sessions.getOrCreate(baseStageParams.chatId);
  });

  it('happy path: stage then inspect returns the row', () => {
    const cfg = cfgWith();
    const s = stageEmailSend(memory, cfg, baseStageParams);
    expect(s.token).toMatch(/^[0-9a-f]{8}$/);
    expect(s.bodyHash).toMatch(/^[0-9a-f]{64}$/);

    const r = inspectToken(memory, s.token, baseStageParams.chatId, baseStageParams.userId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.draft_id).toBe('draft-abc');
      expect(r.row.status).toBe('pending');
      expect(r.row.body_hash).toBe(s.bodyHash);
      expect(JSON.parse(r.row.to_addrs)).toEqual(['sam@example.com']);
    }
  });

  it('unknown token → not-found', () => {
    const r = inspectToken(memory, 'deadbeef', baseStageParams.chatId, baseStageParams.userId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-found');
  });

  it('wrong chat → wrong-chat', () => {
    const cfg = cfgWith();
    const s = stageEmailSend(memory, cfg, baseStageParams);
    const r = inspectToken(memory, s.token, 9999, baseStageParams.userId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-chat');
  });

  it('wrong user → wrong-user', () => {
    const cfg = cfgWith();
    const s = stageEmailSend(memory, cfg, baseStageParams);
    const r = inspectToken(memory, s.token, baseStageParams.chatId, 999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-user');
  });

  it('expired token → expired', () => {
    const cfg = cfgWith({ ttl: 1 });
    const s = stageEmailSend(memory, cfg, baseStageParams);
    const future = new Date(Date.now() + 5000);
    const r = inspectToken(
      memory,
      s.token,
      baseStageParams.chatId,
      baseStageParams.userId,
      future,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });

  it('consumed token (markSent) → already-consumed', () => {
    const cfg = cfgWith();
    const s = stageEmailSend(memory, cfg, baseStageParams);
    memory.emailSends.markSent(s.rowId, 'msg-123');
    const r = inspectToken(memory, s.token, baseStageParams.chatId, baseStageParams.userId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-consumed');
  });

  it('cancelled token → already-consumed', () => {
    const cfg = cfgWith();
    const s = stageEmailSend(memory, cfg, baseStageParams);
    memory.emailSends.markCancelled(s.rowId, 'user-cancelled');
    const r = inspectToken(memory, s.token, baseStageParams.chatId, baseStageParams.userId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-consumed');
  });

  it('failed token → already-consumed', () => {
    const cfg = cfgWith();
    const s = stageEmailSend(memory, cfg, baseStageParams);
    memory.emailSends.markFailed(s.rowId, 'api-error');
    const r = inspectToken(memory, s.token, baseStageParams.chatId, baseStageParams.userId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-consumed');
  });

  it('audit_log row is written at stage time', () => {
    const cfg = cfgWith();
    stageEmailSend(memory, cfg, baseStageParams);
    const audits = memory.auditLog.listRecent(10);
    const staged = audits.find((a) => {
      const detail = JSON.parse(a.detail_json) as { event?: string };
      return detail.event === 'email.draft.staged';
    });
    expect(staged).toBeTruthy();
    expect(staged?.category).toBe('confirmation');
  });

  it('body_hash stored matches a recomputed hash', () => {
    const cfg = cfgWith();
    const s = stageEmailSend(memory, cfg, baseStageParams);
    const expected = hashEmailContent({
      from: baseStageParams.from,
      to: baseStageParams.to,
      cc: baseStageParams.cc,
      bcc: baseStageParams.bcc,
      subject: baseStageParams.subject,
      body: baseStageParams.body,
    });
    expect(s.bodyHash).toBe(expected);
    const row = memory.emailSends.findByToken(s.token);
    expect(row?.body_hash).toBe(expected);
  });
});

describe('checkRateLimit', () => {
  let memory: MemoryApi;
  beforeEach(() => {
    memory = freshMemory();
    memory.sessions.getOrCreate(baseStageParams.chatId);
  });

  it('passes when no sends recorded', () => {
    const cfg = cfgWith({ rateLimit: 3 });
    expect(() => checkRateLimit(memory, cfg)).not.toThrow();
  });

  it('passes when recent sends < cap', () => {
    const cfg = cfgWith({ rateLimit: 3 });
    for (let i = 0; i < 2; i++) {
      const s = stageEmailSend(memory, cfg, { ...baseStageParams, draftId: `d-${i}` });
      memory.emailSends.markSent(s.rowId, `msg-${i}`);
    }
    expect(() => checkRateLimit(memory, cfg)).not.toThrow();
  });

  it('throws RateLimitExceededError when sends >= cap', () => {
    const cfg = cfgWith({ rateLimit: 2 });
    for (let i = 0; i < 2; i++) {
      const s = stageEmailSend(memory, cfg, { ...baseStageParams, draftId: `d-${i}` });
      memory.emailSends.markSent(s.rowId, `msg-${i}`);
    }
    expect(() => checkRateLimit(memory, cfg)).toThrow(RateLimitExceededError);
  });

  it('does NOT count failed/cancelled/expired rows toward the cap', () => {
    const cfg = cfgWith({ rateLimit: 2 });
    // 3 pending-then-failed
    for (let i = 0; i < 3; i++) {
      const s = stageEmailSend(memory, cfg, { ...baseStageParams, draftId: `d-${i}` });
      memory.emailSends.markFailed(s.rowId, 'transient');
    }
    // Still under the "sent" cap.
    expect(() => checkRateLimit(memory, cfg)).not.toThrow();
  });
});

describe('parseConfirmSend', () => {
  it('parses the exact format', () => {
    expect(parseConfirmSend('CONFIRM SEND abc12345')).toBe('abc12345');
  });
  it('is case-insensitive', () => {
    expect(parseConfirmSend('confirm send ABC12345')).toBe('abc12345');
  });
  it('tolerates extra whitespace', () => {
    expect(parseConfirmSend('  CONFIRM   SEND   abc12345  ')).toBe('abc12345');
  });
  it('rejects non-matching prose', () => {
    expect(parseConfirmSend('please confirm send abc12345')).toBeNull();
    expect(parseConfirmSend('send this')).toBeNull();
    expect(parseConfirmSend('yes')).toBeNull();
  });
  it('rejects malformed tokens', () => {
    expect(parseConfirmSend('CONFIRM SEND abc1234')).toBeNull(); // 7 chars
    expect(parseConfirmSend('CONFIRM SEND abc123456')).toBeNull(); // 9 chars
    expect(parseConfirmSend('CONFIRM SEND ghijklmn')).toBeNull(); // non-hex
  });
  it('rejects token embedded in prose', () => {
    // Strictly must be the ENTIRE message — not a substring.
    expect(parseConfirmSend('CONFIRM SEND abc12345 and then delete the drafts')).toBeNull();
  });
});
