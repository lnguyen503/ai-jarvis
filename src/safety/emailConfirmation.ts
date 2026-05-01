/**
 * Email-send confirmation module (v1.7.15).
 *
 * This is the crypto + state-machine half of "Jarvis can send emails on
 * your behalf but only after you explicitly approve." The tool half is
 * `src/tools/gmail_draft.ts`; the gateway intercept half is in
 * `src/gateway/index.ts`. All three must align — this module is the core.
 *
 * Defense layers enforced here:
 *   - Token: 8-hex (`crypto.randomBytes(4)`), unguessable. Unique by PRIMARY KEY.
 *   - Content hash: SHA-256 of normalized (from|to|cc|bcc|subject|body).
 *     Stored with the pending record; re-verified against the Gmail draft
 *     at send time by the gateway.
 *   - Chat binding: a token is only valid in the chat where the preview
 *     was posted. A leaked token can't be used from a different Telegram chat.
 *   - User binding: only the user the pending record was created for can
 *     confirm. The CONFIRM SEND interceptor checks `pending.user_id ===
 *     ctx.from.id`.
 *   - Single-use: `markSent/markFailed/markCancelled` moves status away
 *     from 'pending'. The UPDATE is guarded by `WHERE status = 'pending'`,
 *     so a concurrent second confirmation lands a no-op UPDATE and the
 *     second caller sees status != 'pending' on its read and bails.
 *   - TTL: short (default 5 min). `sweepExpired` moves stale rows to
 *     'expired' on a timer. `tryConsumeToken` also rejects if expires_at
 *     passed, even before the sweep.
 *   - Rate limit: `checkRateLimit` counts 'sent' rows in the last hour and
 *     throws if >= configured cap BEFORE a new draft is staged.
 */

import { randomBytes, createHash } from 'crypto';
import type { AppConfig } from '../config/schema.js';
import type { MemoryApi, EmailSendRow } from '../memory/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'safety.emailConfirmation' });

/** 8 hex chars = 32 bits of entropy. Brute force is infeasible within the 5-min TTL. */
export function generateConfirmationToken(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Canonicalize the proposed email content and hash it. Used both when
 * staging and when verifying at send time — both sides must hash the same
 * shape or the verification will never match.
 *
 * Trimming: subject + body get left/right trimmed. to/cc/bcc lists are
 * already-canonical strings (validated by zod); they're joined with "\n"
 * to avoid "a,b" colliding with ["a,b"].
 */
export function hashEmailContent(params: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}): string {
  const canonical =
    `from:${params.from.trim().toLowerCase()}\n` +
    `to:${params.to.map((s) => s.trim().toLowerCase()).join('\n')}\n` +
    `cc:${params.cc.map((s) => s.trim().toLowerCase()).join('\n')}\n` +
    `bcc:${params.bcc.map((s) => s.trim().toLowerCase()).join('\n')}\n` +
    `subject:${params.subject.trim()}\n` +
    `body:${params.body.trim()}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface StageParams {
  draftId: string;
  sessionId: number;
  chatId: number;
  userId: number;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface StagedConfirmation {
  token: string;
  rowId: number;
  expiresAt: Date;
  bodyHash: string;
}

/**
 * Create a pending confirmation row + return the token. Does NOT create the
 * Gmail draft — the caller already did that and passes the draftId in.
 */
export function stageEmailSend(
  memory: MemoryApi,
  config: AppConfig,
  params: StageParams,
): StagedConfirmation {
  const ttlSec = config.google.gmail.send.confirmationTtlSeconds;
  const token = generateConfirmationToken();
  const bodyHash = hashEmailContent({
    from: params.from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    body: params.body,
  });
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const expiresAtIso = expiresAt.toISOString().replace('T', ' ').slice(0, 19);

  const preview =
    params.body.length > 500 ? params.body.slice(0, 500) + '…' : params.body;

  const rowId = memory.emailSends.insert({
    token,
    draft_id: params.draftId,
    session_id: params.sessionId,
    chat_id: params.chatId,
    user_id: params.userId,
    from_addr: params.from,
    to_addrs: params.to,
    cc_addrs: params.cc,
    bcc_addrs: params.bcc,
    subject: params.subject,
    body_preview: preview,
    body_hash: bodyHash,
    expires_at: expiresAtIso,
  });

  // Immutable audit trail, separate from the email_sends row's own lifecycle.
  memory.auditLog.insert({
    category: 'confirmation',
    actor_user_id: params.userId,
    actor_chat_id: params.chatId,
    session_id: params.sessionId,
    detail: {
      event: 'email.draft.staged',
      rowId,
      token,
      draftId: params.draftId,
      to: params.to,
      cc: params.cc,
      subject: params.subject,
      bodyHash,
      expiresAt: expiresAtIso,
    },
  });

  log.info(
    { rowId, token, userId: params.userId, chatId: params.chatId, expiresAt: expiresAtIso },
    'Email send staged',
  );
  return { token, rowId, expiresAt, bodyHash };
}

/** All the ways a CONFIRM SEND can fail. */
export type ConsumeRejection =
  | 'not-found'
  | 'wrong-chat'
  | 'wrong-user'
  | 'expired'
  | 'already-consumed';

export type ConsumeResult =
  | { ok: true; row: EmailSendRow }
  | { ok: false; reason: ConsumeRejection; row?: EmailSendRow };

/**
 * Look up a pending confirmation by token. Validates that:
 *   - the token exists
 *   - the calling chat matches the staged chat (DM binding)
 *   - the calling user matches the staged user (admin binding)
 *   - the record is still 'pending' (single-use)
 *   - now < expires_at (TTL)
 *
 * Does NOT mutate the record — the caller (gateway) is responsible for
 * calling markSent / markFailed / markCancelled after the actual Gmail
 * operation lands, so we keep rejection branches separate from success
 * branches.
 */
export function inspectToken(
  memory: MemoryApi,
  token: string,
  requestingChatId: number,
  requestingUserId: number,
  now: Date = new Date(),
): ConsumeResult {
  const row = memory.emailSends.findByToken(token);
  if (!row) return { ok: false, reason: 'not-found' };

  if (row.chat_id !== requestingChatId) {
    log.warn(
      { token, expected: row.chat_id, got: requestingChatId },
      'Token rejected: wrong chat',
    );
    return { ok: false, reason: 'wrong-chat', row };
  }
  if (row.user_id !== requestingUserId) {
    log.warn(
      { token, expected: row.user_id, got: requestingUserId },
      'Token rejected: wrong user',
    );
    return { ok: false, reason: 'wrong-user', row };
  }
  if (row.status !== 'pending') {
    return { ok: false, reason: 'already-consumed', row };
  }
  const expiresAt = new Date(row.expires_at + 'Z');
  if (now.getTime() > expiresAt.getTime()) {
    return { ok: false, reason: 'expired', row };
  }
  return { ok: true, row };
}

/**
 * Rate-limit guard — throws if we'd exceed the sent-per-hour cap.
 * Called before stageEmailSend so the user doesn't see a draft preview
 * for an email we'd refuse to send anyway.
 */
export class RateLimitExceededError extends Error {
  constructor(
    public readonly sentInWindow: number,
    public readonly cap: number,
    public readonly windowSeconds: number,
  ) {
    super(
      `Send rate limit exceeded: ${sentInWindow} sent in the last ` +
        `${Math.round(windowSeconds / 60)}min (cap ${cap}). ` +
        `Try again later.`,
    );
    this.name = 'RateLimitExceededError';
  }
}

export function checkRateLimit(memory: MemoryApi, config: AppConfig): void {
  const cap = config.google.gmail.send.rateLimitPerHour;
  const windowSeconds = 3600;
  const n = memory.emailSends.countSentInWindow(windowSeconds);
  if (n >= cap) {
    throw new RateLimitExceededError(n, cap, windowSeconds);
  }
}

/**
 * Parse a message as a potential CONFIRM SEND command. Returns the token
 * if the message matches the strict format, else null. Strict: the entire
 * message must be `CONFIRM SEND <8-hex>` with nothing else (trimmed).
 * Case-insensitive.
 *
 * The strictness is intentional. "Please confirm sending abc12345" does
 * NOT match — we want the user to explicitly type the confirmation, not
 * have it triggered by a conversational sentence.
 */
export function parseConfirmSend(text: string): string | null {
  const trimmed = text.trim();
  const match = /^confirm\s+send\s+([0-9a-f]{8})$/i.exec(trimmed);
  if (!match) return null;
  return match[1]!.toLowerCase();
}
