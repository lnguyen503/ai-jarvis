/**
 * Google Gmail API wrapper.
 *
 * Thin layer on top of googleapis: takes a pre-authenticated OAuth2Client
 * (from `loadGoogleAuth`), exposes the operations Jarvis tools need, and
 * normalises responses into plain objects so tools don't have to know about
 * googleapis internals or Gmail's MIME-part tree.
 *
 * MVP surface: searchMessages, getMessage. Send/modify are separate (future
 * tools) and will need the `gmail.send` / `gmail.modify` scopes added to
 * `GOOGLE_SCOPES` plus a re-consent via `npm run google-auth`.
 */

import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface GmailSearchOptions {
  query: string;      // Gmail search syntax, e.g. 'from:sam@x.com is:unread after:2026/04/01'
  maxResults: number; // capped in tools, but enforced here too
  labelIds?: string[]; // optional label filter (applied alongside q)
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;        // raw Date header, not parsed — UI can display as-is
  snippet: string;     // Gmail's own snippet, already truncated to ~200 chars
  labelIds: string[];
}

export interface GmailAttachmentSummary {
  filename: string;
  mimeType: string;
  size: number;         // bytes, from Gmail's metadata
  attachmentId: string; // for future download tool; not used by gmail_read
}

export interface GmailMessageDetail {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;                       // decoded text/plain if present, else stripped HTML
  bodyKind: 'plain' | 'html' | 'empty'; // what we pulled the body from
  attachments: GmailAttachmentSummary[];
}

export interface DraftComposeOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** The user's own email, used in the From: header. Passed from caller. */
  from: string;
  /** If set, threads the draft onto an existing conversation. */
  threadId?: string;
  /** RFC 2822 Message-ID of the message this is a reply to (for threading headers). */
  inReplyToMessageId?: string;
}

export interface DraftCreated {
  /** Gmail's draft id — used with sendDraft / deleteDraft / getDraft. */
  draftId: string;
  /** The draft's Gmail message id. */
  messageId: string;
  /** Thread id (matches threadId input if provided, else a new thread id). */
  threadId: string;
}

export class GmailApi {
  private readonly _api: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this._api = google.gmail({ version: 'v1', auth });
  }

  /**
   * Look up the authenticated user's own email address. Uses the Gmail
   * profile endpoint (covered by gmail.readonly). Cheap — one GET.
   */
  async getSelfEmail(): Promise<string> {
    const res = await this._api.users.getProfile({ userId: 'me' });
    const addr = res.data.emailAddress;
    if (!addr) throw new Error('Gmail profile has no emailAddress');
    return addr;
  }

  /**
   * Create a draft. Does NOT send — that's a separate step (sendDraft).
   *
   * The draft appears in the user's Gmail Drafts folder so they can also
   * review/send from Gmail directly if they want. The id returned here is
   * the key we store in the pending_email_sends table for the confirmation
   * flow to send later.
   */
  async createDraft(opts: DraftComposeOptions): Promise<DraftCreated> {
    const mime = buildMimeMessage(opts);
    const raw = toBase64Url(mime);
    const res = await this._api.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw,
          threadId: opts.threadId,
        },
      },
    });
    const draftId = res.data.id;
    const messageId = res.data.message?.id;
    const threadId = res.data.message?.threadId;
    if (!draftId || !messageId || !threadId) {
      throw new Error('Gmail drafts.create returned an incomplete response');
    }
    return { draftId, messageId, threadId };
  }

  /**
   * Send a previously-created draft. Discards the draft after send (Gmail's
   * normal behavior — the message moves to Sent Mail). Returns the sent
   * message id.
   */
  async sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }> {
    const res = await this._api.users.drafts.send({
      userId: 'me',
      requestBody: { id: draftId },
    });
    const messageId = res.data.id;
    const threadId = res.data.threadId;
    if (!messageId || !threadId) {
      throw new Error('Gmail drafts.send returned an incomplete response');
    }
    return { messageId, threadId };
  }

  /**
   * Delete a draft without sending it. Used when the user cancels or the
   * confirmation expires. Idempotent — 404s are swallowed.
   */
  async deleteDraft(draftId: string): Promise<void> {
    try {
      await this._api.users.drafts.delete({ userId: 'me', id: draftId });
    } catch (err) {
      // If the draft is already gone (e.g. user deleted from Gmail UI), ignore.
      const status = (err as { code?: number }).code;
      if (status !== 404) throw err;
    }
  }

  /**
   * Fetch the raw RFC 822 bytes of a draft — used at send-time to hash-
   * verify that the draft still contains exactly what was previewed.
   */
  async getDraftRawBytes(draftId: string): Promise<string> {
    const res = await this._api.users.drafts.get({
      userId: 'me',
      id: draftId,
      format: 'raw',
    });
    const raw = res.data.message?.raw;
    if (!raw) throw new Error(`Gmail draft ${draftId} has no raw content`);
    // Gmail returns base64url — decode back to RFC 822 string.
    return decodeBase64Url(raw);
  }

  /**
   * Search messages by Gmail query syntax and return lightweight summaries.
   *
   * Gmail's list endpoint returns only id+threadId, so we do a parallel
   * metadata fetch per message to pick up From/Subject/Date/snippet. The
   * metadata format is cheap (no body payload); we cap fan-out at
   * `maxResults`.
   */
  async searchMessages(opts: GmailSearchOptions): Promise<GmailMessageSummary[]> {
    const listRes = await this._api.users.messages.list({
      userId: 'me',
      q: opts.query || undefined,
      maxResults: opts.maxResults,
      labelIds: opts.labelIds,
    });

    const ids = (listRes.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
    if (ids.length === 0) return [];

    const details = await Promise.all(
      ids.map((id) =>
        this._api.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        }),
      ),
    );

    return details.map((res) => {
      const msg = res.data;
      const headers = msg.payload?.headers ?? [];
      return {
        id: msg.id ?? '',
        threadId: msg.threadId ?? '',
        from: extractHeader(headers, 'From') ?? '(unknown sender)',
        subject: extractHeader(headers, 'Subject') ?? '(no subject)',
        date: extractHeader(headers, 'Date') ?? '',
        snippet: msg.snippet ?? '',
        labelIds: msg.labelIds ?? [],
      };
    });
  }

  /**
   * Fetch a single message with full body and attachment metadata.
   *
   * Prefers `text/plain`; falls back to `text/html` with tags stripped.
   * Attachments are listed but not downloaded — tools that need the bytes
   * would call `users.messages.attachments.get` separately.
   */
  async getMessage(id: string): Promise<GmailMessageDetail> {
    const res = await this._api.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });
    const msg = res.data;
    const headers = msg.payload?.headers ?? [];

    const { text, kind } = extractBody(msg.payload);

    return {
      id: msg.id ?? '',
      threadId: msg.threadId ?? '',
      labelIds: msg.labelIds ?? [],
      from: extractHeader(headers, 'From') ?? '(unknown sender)',
      to: extractHeader(headers, 'To') ?? '',
      cc: extractHeader(headers, 'Cc'),
      bcc: extractHeader(headers, 'Bcc'),
      replyTo: extractHeader(headers, 'Reply-To'),
      subject: extractHeader(headers, 'Subject') ?? '(no subject)',
      date: extractHeader(headers, 'Date') ?? '',
      snippet: msg.snippet ?? '',
      body: text,
      bodyKind: kind,
      attachments: extractAttachments(msg.payload),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit testing. Not part of the public API surface.
// ---------------------------------------------------------------------------

/**
 * Case-insensitive header lookup. Gmail's API returns headers as
 * `{ name, value }` pairs; names arrive in their original case which varies
 * across senders (From, FROM, from).
 */
export function extractHeader(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === lower) return h.value ?? undefined;
  }
  return undefined;
}

/** Gmail uses base64url (RFC 4648 §5) with no padding. */
export function decodeBase64Url(data: string): string {
  // Convert base64url to standard base64, then decode as UTF-8.
  const std = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Walk the MIME-part tree and extract the best-available body text.
 *
 * Prefer `text/plain`; fall back to `text/html` with a naive tag strip.
 * Ignore inline attachments (parts with filename + content-disposition).
 */
export function extractBody(
  payload: gmail_v1.Schema$MessagePart | undefined,
): { text: string; kind: 'plain' | 'html' | 'empty' } {
  if (!payload) return { text: '', kind: 'empty' };

  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) {
    return { text: decodeBase64Url(plain.body.data), kind: 'plain' };
  }

  const html = findPart(payload, 'text/html');
  if (html?.body?.data) {
    const rawHtml = decodeBase64Url(html.body.data);
    return { text: stripHtml(rawHtml), kind: 'html' };
  }

  // Some senders put the body directly on the root payload with no parts.
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    const isHtml = (payload.mimeType ?? '').toLowerCase().includes('html');
    return { text: isHtml ? stripHtml(decoded) : decoded, kind: isHtml ? 'html' : 'plain' };
  }

  return { text: '', kind: 'empty' };
}

/**
 * Depth-first search for the first part whose mimeType matches.
 * Skips parts that look like attachments (have a filename).
 */
export function findPart(
  part: gmail_v1.Schema$MessagePart,
  mimeType: string,
): gmail_v1.Schema$MessagePart | null {
  const isAttachment = Boolean(part.filename && part.filename.length > 0);
  if (!isAttachment && part.mimeType?.toLowerCase() === mimeType.toLowerCase()) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

export function extractAttachments(
  payload: gmail_v1.Schema$MessagePart | undefined,
): GmailAttachmentSummary[] {
  if (!payload) return [];
  const out: GmailAttachmentSummary[] = [];
  walkParts(payload, (part) => {
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      out.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
  });
  return out;
}

function walkParts(
  part: gmail_v1.Schema$MessagePart,
  visit: (p: gmail_v1.Schema$MessagePart) => void,
): void {
  visit(part);
  for (const child of part.parts ?? []) walkParts(child, visit);
}

/**
 * Naive HTML-to-text: drop script/style blocks, strip tags, decode a handful
 * of common entities, collapse whitespace. Not a parser — emails from marketing
 * systems will still read roughly. Good enough for "what did Sam say?"
 */
/**
 * Build an RFC 5322 MIME message from plain-text compose options.
 *
 * Plain-text only for now — no HTML body, no attachments. Keeps the
 * preview + hash match simple (what the user saw is exactly what
 * gets sent).
 *
 * Exported for testing.
 */
export function buildMimeMessage(opts: DraftComposeOptions): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to.join(', ')}`);
  if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(', ')}`);
  if (opts.bcc && opts.bcc.length > 0) lines.push(`Bcc: ${opts.bcc.join(', ')}`);
  lines.push(`Subject: ${encodeHeaderValue(opts.subject)}`);
  if (opts.inReplyToMessageId) {
    lines.push(`In-Reply-To: ${opts.inReplyToMessageId}`);
    lines.push(`References: ${opts.inReplyToMessageId}`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  // Normalize line endings to CRLF per RFC 5322.
  const body = opts.body.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  lines.push(body);
  return lines.join('\r\n');
}

/**
 * Encode a header value using RFC 2047 "encoded-word" syntax ONLY if it
 * contains non-ASCII characters. ASCII subjects pass through unchanged so
 * the preview the user sees matches the wire bytes.
 */
function encodeHeaderValue(value: string): string {
  // Plain ASCII — no encoding needed.
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/** Base64url-encode a string (Gmail's drafts.create format). */
function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
