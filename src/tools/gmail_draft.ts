/**
 * Tool: gmail_draft (v1.7.15)
 *
 * Compose an outgoing email and stage it for user approval. Admin-only.
 *
 * CRITICAL: There is NO `gmail_send` tool in the registry. The ONLY way an
 * email ever leaves the user's Gmail account is:
 *
 *   1. The agent calls `gmail_draft` (this tool), which:
 *        - validates recipients + rate limit
 *        - creates a Gmail draft via `drafts.create`
 *        - stores a pending row in `email_sends` with an 8-hex token + SHA-256
 *          hash of the exact content
 *        - posts a full preview of the email to the admin user's Telegram chat
 *          DIRECTLY via `ctx.telegram.sendMessage` — NOT through the agent's
 *          reply path (so the LLM cannot forge or hide what the user sees)
 *   2. The user reads the preview and types `CONFIRM SEND <token>` in DM.
 *   3. The gateway (not the agent) matches the pattern BEFORE the agent loop
 *      runs, looks up the pending row, re-verifies the Gmail draft's content
 *      hash matches, and only then calls `drafts.send`.
 *
 * If any single layer is bypassed, the others still block the send. This is
 * the defense-in-depth mandate the user asked for.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { GmailApi } from '../google/gmail.js';
import {
  stageEmailSend,
  checkRateLimit,
  RateLimitExceededError,
} from '../safety/emailConfirmation.js';
import type { OAuth2Client } from 'google-auth-library';

const emailArray = z.array(z.string().email()).default([]);

const parameters = z.object({
  to: z.array(z.string().email()).min(1).describe('Recipient email addresses. At least one required.'),
  cc: emailArray.describe('Carbon-copy recipients.'),
  bcc: emailArray.describe('Blind carbon-copy recipients.'),
  subject: z.string().min(1).max(500).describe('Email subject line.'),
  body: z
    .string()
    .min(1)
    .max(100_000)
    .describe('Email body — plain text. Markdown will be sent as-is (no HTML conversion).'),
  inReplyToMessageId: z
    .string()
    .optional()
    .describe(
      'RFC 2822 Message-ID of the email this is a reply to (from gmail_read data.headers). ' +
        'Sets In-Reply-To + References headers so Gmail threads the reply.',
    ),
  threadId: z
    .string()
    .optional()
    .describe(
      'Gmail thread id from gmail_read — if set, the draft attaches to that thread ' +
        'so the reply appears in the existing conversation.',
    ),
});

type GmailDraftInput = z.infer<typeof parameters>;

export function buildGmailDraftTool(deps: ToolDeps): Tool<GmailDraftInput> {
  let cachedAuth: OAuth2Client | null = null;
  let triedLoad = false;

  async function getAuth(): Promise<OAuth2Client | null> {
    if (cachedAuth) return cachedAuth;
    if (triedLoad) {
      cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
      return cachedAuth;
    }
    triedLoad = true;
    cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
    return cachedAuth;
  }

  return {
    name: 'gmail_draft',
    description:
      'Draft an outgoing email and stage it for the user\'s approval. ' +
      'This tool ONLY creates a draft — it does NOT send. The user must ' +
      'explicitly confirm with a token in Telegram before anything goes out. ' +
      'Use this when the user asks you to write, reply to, or forward an email. ' +
      'The full preview (to, cc, subject, body) is posted to the chat ' +
      'automatically; you do not need to repeat it in your reply.',
    parameters,
    adminOnly: true,

    async execute(input: GmailDraftInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.gmail_draft' });
      const cfg = ctx.config.google.gmail.send;

      // --- Layer: master feature flag ----------------------------------------
      if (!cfg.enabled) {
        return {
          ok: false,
          output:
            'Email sending is disabled. The owner must set ' +
            'config.google.gmail.send.enabled=true and restart Jarvis before ' +
            'drafts can be staged.',
          error: { code: 'GMAIL_SEND_DISABLED', message: 'send.enabled=false' },
        };
      }

      // --- Layer: recipient count cap (cheap — before auth round-trip) -----
      const recipientCount = input.to.length + input.cc.length + input.bcc.length;
      if (recipientCount > cfg.maxRecipientsPerSend) {
        return {
          ok: false,
          output:
            `Refused: ${recipientCount} total recipients exceeds the configured ` +
            `cap of ${cfg.maxRecipientsPerSend}. Split the email or raise ` +
            `config.google.gmail.send.maxRecipientsPerSend.`,
          error: { code: 'TOO_MANY_RECIPIENTS', message: `count=${recipientCount}` },
        };
      }

      // --- Layer: thread-only policy (optional) -----------------------------
      if (cfg.requireReplyToThread && !input.threadId) {
        return {
          ok: false,
          output:
            'This Jarvis is configured to only send replies to existing ' +
            'threads (send.requireReplyToThread=true). Include a threadId from ' +
            'a prior gmail_read or gmail_search result.',
          error: { code: 'REPLY_ONLY', message: 'threadId missing' },
        };
      }

      // --- Layer: rate limit (per-hour sent cap) ----------------------------
      try {
        checkRateLimit(ctx.memory, ctx.config);
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          log.warn(
            { sent: err.sentInWindow, cap: err.cap },
            'Draft refused by rate limit',
          );
          return {
            ok: false,
            output: err.message,
            error: { code: 'RATE_LIMIT_EXCEEDED', message: err.message },
          };
        }
        throw err;
      }

      // --- Layer: auth -------------------------------------------------------
      const auth = await getAuth();
      if (!auth) {
        return {
          ok: false,
          output:
            'Gmail is not authorised. Re-run `npm run google-auth` to grant ' +
            'the gmail.compose scope (required for drafts + send), then restart Jarvis.',
          error: { code: 'GOOGLE_NOT_AUTHORISED', message: 'no oauth credentials' },
        };
      }

      // --- Layer: fetch sender's own email ---------------------------------
      const api = new GmailApi(auth);
      let from: string;
      try {
        from = await api.getSelfEmail();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          output: `Couldn't read Gmail profile: ${message}`,
          error: { code: 'GMAIL_PROFILE_ERROR', message },
        };
      }

      // --- Layer: create the Gmail draft ------------------------------------
      let draft;
      try {
        draft = await api.createDraft({
          from,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          body: input.body,
          threadId: input.threadId,
          inReplyToMessageId: input.inReplyToMessageId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, 'Gmail drafts.create failed');
        return {
          ok: false,
          output: `Couldn't create draft: ${message}`,
          error: { code: 'GMAIL_DRAFT_FAILED', message },
        };
      }

      // --- Layer: stage pending confirmation (token + hash + TTL) -----------
      const staged = stageEmailSend(ctx.memory, ctx.config, {
        draftId: draft.draftId,
        sessionId: ctx.sessionId,
        chatId: ctx.chatId,
        userId: ctx.config.telegram.allowedUserIds[0] ?? 0,
        from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
      });

      // --- Layer: post preview DIRECTLY to chat (bypasses agent reply path) -
      // This is deliberate: if we returned the preview as tool output, the
      // agent could summarize/modify it before the user sees it. Posting via
      // ctx.telegram puts the exact preview in front of the user, word for
      // word, before the agent writes its own reply.
      const preview = formatPreview({
        from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
        token: staged.token,
        expiresAt: staged.expiresAt,
      });

      if (ctx.telegram) {
        try {
          await ctx.telegram.sendMessage(ctx.chatId, preview);
        } catch (err) {
          // Preview delivery failed. Cancel the staged record + delete the
          // Gmail draft so we don't leave a ticking confirmation behind that
          // the user never saw.
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'Preview delivery failed — cancelling staged draft',
          );
          ctx.memory.emailSends.markCancelled(staged.rowId, 'preview-delivery-failed');
          try {
            await api.deleteDraft(draft.draftId);
          } catch {
            // best-effort
          }
          return {
            ok: false,
            output: 'Could not post the confirmation preview to Telegram. Draft cancelled.',
            error: { code: 'PREVIEW_DELIVERY_FAILED', message: 'telegram.sendMessage threw' },
          };
        }
      } else {
        // No adapter (test path or unexpected production state). Without a
        // way to show the preview we must refuse — the whole defense rests
        // on the user seeing the preview.
        ctx.memory.emailSends.markCancelled(staged.rowId, 'no-telegram-adapter');
        try {
          await api.deleteDraft(draft.draftId);
        } catch {
          // best-effort
        }
        return {
          ok: false,
          output: 'Cannot stage email send: no Telegram adapter available to post the preview.',
          error: { code: 'NO_TELEGRAM_ADAPTER', message: 'ctx.telegram undefined' },
        };
      }

      log.info(
        {
          draftId: draft.draftId,
          token: staged.token,
          rowId: staged.rowId,
          recipientCount,
          chatId: ctx.chatId,
        },
        'Email draft staged for approval',
      );

      // Minimal agent-visible output — the real preview is already in front
      // of the user. Don't ask the LLM to re-narrate; don't give it the
      // chance to tamper with what the user sees.
      return {
        ok: true,
        output:
          `Draft staged. A preview was posted to the chat with confirmation ` +
          `token \`${staged.token}\`. The user must reply with ` +
          `"CONFIRM SEND ${staged.token}" within ${cfg.confirmationTtlSeconds}s ` +
          `to send. Do NOT repeat the full content in your reply — it's already ` +
          `been shown.`,
        data: {
          draftId: draft.draftId,
          token: staged.token,
          expiresAt: staged.expiresAt.toISOString(),
          recipientCount,
        },
      };
    },
  };
}

function formatPreview(opts: {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  token: string;
  expiresAt: Date;
}): string {
  // Plain text — no HTML, no Markdown — so Telegram doesn't parse anything
  // in the body as formatting. The preview should be LITERAL.
  const lines: string[] = [];
  lines.push('📧 EMAIL DRAFT — awaiting your approval');
  lines.push('');
  lines.push(`From:    ${opts.from}`);
  lines.push(`To:      ${opts.to.join(', ')}`);
  if (opts.cc.length > 0) lines.push(`Cc:      ${opts.cc.join(', ')}`);
  if (opts.bcc.length > 0) lines.push(`Bcc:     ${opts.bcc.join(', ')}`);
  lines.push(`Subject: ${opts.subject}`);
  lines.push('');
  lines.push('---');
  lines.push(opts.body);
  lines.push('---');
  lines.push('');
  lines.push(`To SEND, reply exactly:   CONFIRM SEND ${opts.token}`);
  lines.push('To CANCEL, reply:         CANCEL   (or just ignore — it expires)');
  lines.push('');
  lines.push(
    `Token expires at ${opts.expiresAt.toISOString().replace('T', ' ').slice(0, 19)} UTC. ` +
      `If you do nothing, nothing gets sent.`,
  );
  return lines.join('\n');
}
