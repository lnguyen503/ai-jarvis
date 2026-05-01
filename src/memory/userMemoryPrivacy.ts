/**
 * Privacy filter for persistent user memory (v1.8.5).
 *
 * Every fact written to a user's memory file flows through here first.
 * The goal is "do not capture sensitive private information" per the
 * user's explicit ask — this layer enforces it deterministically so
 * model judgment alone isn't the only defense.
 *
 * What we reject (with a reason the tool can show the user):
 *   - Phone numbers (US + international shapes)
 *   - SSN-shape "###-##-####"
 *   - Credit-card-shape 13-19 digit runs
 *   - Email addresses (might be benign, but defaults to NO — users can
 *     opt back in by rephrasing)
 *   - Anything the existing safety/scrubber.ts would scrub (API keys,
 *     tokens, AWS/Anthropic/OpenAI/GitHub/Google secrets)
 *   - "password is …" / "pin is …" / "my pin/password/passcode is" patterns
 *   - URLs containing query params with token-like values
 *   - Health/medical specifics ("HIV", "cancer", "depression", "diabetes")
 *     — these are sensitive AND not useful for tailoring Jarvis's responses
 *   - Financial specifics ("$X salary", "bank account #")
 *   - Long alphanumeric strings (≥40 chars no spaces) — heuristic for
 *     opaque tokens
 *
 * What we ALLOW (the whole point of memory):
 *   - "prefer brief replies" / "use Sonnet for code" / "no apologies"
 *   - "works on rehearse-sales" / "Windows 11 + WSL" / "deploys to Cloud Run"
 *   - "uses Vim" / "data-scientist by training" / "writes mostly Go"
 *   - Time zone / language / project paths
 *   - "Kim is my sister" — relationship label, no contact info
 *
 * Length cap: 500 chars per fact. Long pastes are almost always either
 * data dumps (don't belong in a preference file) or attempts to smuggle
 * a wall of context that's better suited to the chat history.
 */

import { scrub } from '../safety/scrubber.js';

const MAX_FACT_CHARS = 500;
const MAX_OPAQUE_TOKEN_CHARS = 40;

interface RejectPattern {
  name: string;
  pattern: RegExp;
  reason: string;
}

const REJECT_PATTERNS: RejectPattern[] = [
  {
    name: 'phone-us-international',
    // +1 555-555-5555, (555) 555-5555, 555.555.5555, etc.
    pattern: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
    reason: 'looks like a phone number',
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    reason: 'looks like a Social Security number',
  },
  {
    name: 'credit-card-shape',
    // 13-19 digit runs, optionally separated by spaces/dashes in groups of 4.
    pattern: /\b(?:\d{4}[\s-]?){3,4}\d{1,4}\b/,
    reason: 'looks like a credit card number',
  },
  {
    name: 'email-address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    reason: 'contains an email address (skip — Jarvis can use your Telegram identity instead)',
  },
  {
    name: 'password-like',
    pattern: /\b(?:password|passcode|passphrase|pin|secret|api[\s_-]?key|token|bearer)\s*(?:is|=|:)\s*\S+/i,
    reason: 'looks like a credential ("password is X" / "api key: ...")',
  },
  {
    name: 'url-with-token',
    pattern: /https?:\/\/[^\s]*[?&](?:token|access_token|api_key|key|auth)=[^\s&]+/i,
    reason: 'URL contains an auth token in the query string',
  },
  {
    name: 'health-specific',
    pattern: /\b(?:HIV|AIDS|cancer|diabetes|depression|anxiety|bipolar|schizophrenia|tumor|chemotherapy|prescription)\b/i,
    reason: 'health-specific terms — out of scope for memory; tell Jarvis directly each session if relevant',
  },
  {
    name: 'financial-specific',
    pattern: /\b(?:salary|bank\s+account|routing\s+number|account\s+number|net\s+worth)\b/i,
    reason: 'financial specifics — out of scope for memory',
  },
];

export interface FilterResult {
  ok: boolean;
  reason?: string;
  /** Sanitized fact (whitespace trimmed, control chars removed). Only set on ok=true. */
  fact?: string;
}

/**
 * Apply the privacy filter. On rejection, returns a short reason string
 * suitable for the agent to relay to the user — e.g. "Refused: looks
 * like a phone number." On accept, returns the normalized fact.
 */
export function filterMemoryFact(rawFact: string): FilterResult {
  if (typeof rawFact !== 'string') {
    return { ok: false, reason: 'fact must be a string' };
  }

  // Strip ASCII control chars (other than tab/newline) and trim. Codepoints:
  // 0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f, 0x7f.
  const controlCharRegex = new RegExp(
    '[' +
      '\\u0000-\\u0008' +
      '\\u000b\\u000c' +
      '\\u000e-\\u001f' +
      '\\u007f' +
      ']',
    'g',
  );
  const trimmed = rawFact.replace(controlCharRegex, '').trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'fact is empty after sanitization' };
  }
  if (trimmed.length > MAX_FACT_CHARS) {
    return {
      ok: false,
      reason: `fact too long (${trimmed.length} chars; cap is ${MAX_FACT_CHARS}). Shorten to a single declarative sentence.`,
    };
  }

  // Reject if the safety scrubber would have rewritten it (catches every
  // known API-key shape we already defend against in tool outputs).
  const scrubbed = scrub(trimmed);
  if (scrubbed !== trimmed) {
    return {
      ok: false,
      reason: 'looks like it contains a credential or API key',
    };
  }

  // Heuristic: a single non-whitespace run of >=40 alphanumeric chars is
  // almost always a token / hash / opaque id. Reject.
  const longTokenMatch = /[A-Za-z0-9_+/=-]{40,}/.exec(trimmed);
  if (longTokenMatch) {
    return {
      ok: false,
      reason: `contains a long opaque token (${longTokenMatch[0].slice(0, 8)}...) — refused as a likely credential`,
    };
  }

  // Pattern-based rejections.
  for (const { pattern, reason } of REJECT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason };
    }
  }

  return { ok: true, fact: trimmed };
}

/** Re-exported for tests / future call-sites. */
export const _MAX_FACT_CHARS_FOR_TESTS = MAX_FACT_CHARS;
export const _MAX_OPAQUE_TOKEN_CHARS_FOR_TESTS = MAX_OPAQUE_TOKEN_CHARS;
