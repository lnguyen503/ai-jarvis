/**
 * ConversationArchiveRepo — persistent storage for pre-compaction history (v1.4).
 *
 * Rows are inserted by compactSession() before history is deleted.
 * The full_history_json must be scrubbed before calling insert().
 *
 * v1.4.1: added first_message_id / last_message_id (migration 005) and search().
 */

import type { DbHandle } from './dbDriver.js';
import type { Message } from './messages.js';

export interface ConversationArchiveRow {
  id: number;
  session_id: number;
  compacted_at: string;
  trigger: 'auto' | 'manual';
  provider: string;
  model: string;
  original_tokens: number;
  compressed_tokens: number;
  original_message_count: number;
  full_history_json: string;
  summary_text: string;
  first_message_id: number | null;
  last_message_id: number | null;
}

export interface InsertArchiveParams {
  session_id: number;
  trigger: 'auto' | 'manual';
  provider: string;
  model: string;
  original_tokens: number;
  compressed_tokens: number;
  original_message_count: number;
  full_history_json: string;
  summary_text: string;
  first_message_id?: number | null;
  last_message_id?: number | null;
}

export interface SearchHit {
  message_id: number;
  role: string;
  created_at: string;
  snippet: string;
  archive_id: number;
}

// Stopwords to exclude from token matching
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in',
  'on', 'for', 'and', 'or', 'but', 'at', 'by', 'with',
]);

/** Extract meaningful search tokens from a raw query string. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Count how many tokens from `tokens` appear in `text` (case-insensitive). */
function countMatches(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.filter((t) => lower.includes(t)).length;
}

/** Find the character offset of the first token match in `text`. */
function firstMatchOffset(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const t of tokens) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best === -1 ? 0 : best;
}

/** Extract a window of `windowChars` centered on the best match offset. */
function extractWindow(text: string, offset: number, windowChars: number): string {
  const half = Math.floor(windowChars / 2);
  const start = Math.max(0, offset - half);
  const end = Math.min(text.length, start + windowChars);
  const snippet = text.slice(start, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + snippet + suffix;
}

export class ConversationArchiveRepo {
  constructor(private readonly db: DbHandle) {}

  insert(params: InsertArchiveParams): number {
    const result = this.db
      .prepare(
        `INSERT INTO conversation_archive
           (session_id, trigger, provider, model, original_tokens, compressed_tokens,
            original_message_count, full_history_json, summary_text,
            first_message_id, last_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.session_id,
        params.trigger,
        params.provider,
        params.model,
        params.original_tokens,
        params.compressed_tokens,
        params.original_message_count,
        params.full_history_json,
        params.summary_text,
        params.first_message_id ?? null,
        params.last_message_id ?? null,
      );
    return result.lastInsertRowid as number;
  }

  listForSession(sessionId: number): ConversationArchiveRow[] {
    return this.db
      .prepare(
        `SELECT * FROM conversation_archive
          WHERE session_id = ?
          ORDER BY compacted_at DESC, id DESC`,
      )
      .all(sessionId) as ConversationArchiveRow[];
  }

  latestForSession(sessionId: number): ConversationArchiveRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM conversation_archive
          WHERE session_id = ?
          ORDER BY compacted_at DESC, id DESC
          LIMIT 1`,
      )
      .get(sessionId) as ConversationArchiveRow | undefined;
  }

  getById(id: number, sessionId: number): ConversationArchiveRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM conversation_archive
          WHERE id = ? AND session_id = ?`,
      )
      .get(id, sessionId) as ConversationArchiveRow | undefined;
  }

  /**
   * Search archived message history for a session.
   *
   * - If archiveId is provided, searches only that archive row.
   * - Otherwise searches all archives for the session.
   * - Splits query into tokens (dropping stopwords and tokens < 3 chars).
   * - Returns hits ranked by number of matching tokens, then recency (higher message_id = more recent).
   * - Each hit includes a surrounding window of text centered on the best match.
   *
   * NOTE: Callers are responsible for scrubbing returned snippets via ctx.safety.scrub().
   */
  search(
    sessionId: number,
    archiveId: number | null,
    query: string,
    opts: { maxMatches?: number; windowChars?: number } = {},
  ): SearchHit[] {
    const { maxMatches = 5, windowChars = 400 } = opts;

    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    // Load the relevant archive rows
    const rows: ConversationArchiveRow[] = archiveId !== null
      ? (() => {
          const row = this.getById(archiveId, sessionId);
          return row ? [row] : [];
        })()
      : this.listForSession(sessionId);

    if (rows.length === 0) return [];

    // Accumulate scored hits
    interface ScoredHit {
      score: number;
      recency: number; // message_id — higher = more recent
      hit: SearchHit;
    }

    const scored: ScoredHit[] = [];

    for (const row of rows) {
      let messages: Message[];
      try {
        messages = JSON.parse(row.full_history_json) as Message[];
      } catch {
        continue;
      }

      for (const msg of messages) {
        // Build a combined searchable text from all relevant fields
        const fields: string[] = [];
        if (msg.content) fields.push(msg.content);
        if (msg.tool_input) fields.push(msg.tool_input);
        if (msg.tool_output) fields.push(msg.tool_output);
        const combined = fields.join('\n');

        const score = countMatches(combined, tokens);
        if (score === 0) continue;

        const offset = firstMatchOffset(combined, tokens);
        const snippet = extractWindow(combined, offset, windowChars);

        scored.push({
          score,
          recency: msg.id ?? 0,
          hit: {
            message_id: msg.id ?? 0,
            role: msg.tool_name ? `tool ${msg.tool_name}` : msg.role,
            created_at: msg.created_at ?? '',
            snippet,
            archive_id: row.id,
          },
        });
      }
    }

    // Sort: primary = score desc, secondary = recency desc
    scored.sort((a, b) => b.score - a.score || b.recency - a.recency);

    return scored.slice(0, maxMatches).map((s) => s.hit);
  }
}
