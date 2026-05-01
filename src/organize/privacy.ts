/**
 * Privacy filter for /organize fields (v1.8.6).
 *
 * Narrowed-health posture vs userMemoryPrivacy.ts — designed to allow
 * fitness/wellness goals while still rejecting disease-specific and
 * prescription-drug content. See ADR 003 §2 + CP1 revisions R4, R5.
 *
 * Field-level function: `filterOrganizeField(field, raw)`.
 * The filter is called per-field; any field rejection halts the operation
 * at the tool layer (reject-dominant per R4).
 *
 * CRITICAL: reject reasons name the CATEGORY only — they NEVER echo the
 * matched substring. Parallel to userMemoryPrivacy.ts:83-85.
 */

import { scrub } from '../safety/scrubber.js';

// ---------------------------------------------------------------------------
// Named constants (exported so tests and tooling can reference them)
// ---------------------------------------------------------------------------

export const MAX_TITLE = 500;
export const MAX_NOTES = 5000;
export const MAX_PROGRESS = 500;
export const MAX_TAG = 40;
export const MAX_TAGS = 10;

/**
 * Disease / prescription seed list. The privacy filter rejects any field
 * (except `attendee`) that contains one of these terms (case-insensitive,
 * word-boundary match).
 *
 * Tuning point: add/remove terms here only. Every call site references this
 * constant — no scattered duplicates.
 *
 * These terms are deliberately narrower than userMemoryPrivacy's health list:
 * fitness/nutrition/wellness terms are intentionally ABSENT so that goals like
 * "Lose 10 lbs by summer" or "30 min yoga M/W/F" pass the filter.
 */
export const HEALTH_REJECT_SEEDS: readonly string[] = [
  'HIV',
  'AIDS',
  'cancer',
  'tumor',
  'chemotherapy',
  'chemo',
  'radiation therapy',
  'diabetes',
  'insulin',
  'depression',
  'anxiety disorder',
  'bipolar',
  'schizophrenia',
  'prescription',
  'diagnosis',
  'diagnosed',
  // Named drugs
  'adderall',
  'xanax',
  'prozac',
  'zoloft',
  'lexapro',
  'oxycontin',
  'vicodin',
  'ativan',
  'klonopin',
  'ambien',
  'lithium',
  'ritalin',
];

// Pre-compile once at module load.
// Word-boundary match, case-insensitive. Each seed is escaped so special
// regex chars (e.g. spaces in "radiation therapy") don't break the pattern.
const _escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEALTH_REJECT_PATTERN = new RegExp(
  `\\b(?:${HEALTH_REJECT_SEEDS.map(_escapeRegex).join('|')})\\b`,
  'i',
);

// ---------------------------------------------------------------------------
// Filter result
// ---------------------------------------------------------------------------

export type FilterResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Reject patterns shared across all fields (minus email for attendee)
// ---------------------------------------------------------------------------

interface RejectPattern {
  name: string;
  pattern: RegExp;
  reason: string;
}

const CREDENTIAL_REJECT_PATTERNS: RejectPattern[] = [
  {
    name: 'phone-us-international',
    pattern: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
    reason: 'contains what looks like a phone number',
  },
  {
    name: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    reason: 'contains what looks like a Social Security number',
  },
  {
    name: 'credit-card-shape',
    pattern: /\b(?:\d{4}[\s-]?){3,4}\d{1,4}\b/,
    reason: 'contains what looks like a credit card number',
  },
  {
    name: 'password-like',
    pattern: /\b(?:password|passcode|passphrase|pin|secret|api[\s_-]?key|token|bearer)\s*(?:is|=|:)\s*\S+/i,
    reason: 'contains what looks like a credential phrase',
  },
  {
    name: 'url-with-token',
    pattern: /https?:\/\/[^\s]*[?&](?:token|access_token|api_key|key|auth)=[^\s&]+/i,
    reason: 'contains a URL with an embedded auth token',
  },
  {
    name: 'financial-specific',
    pattern: /\b(?:salary|bank\s+account|routing\s+number|account\s+number|net\s+worth)\b/i,
    reason: 'contains financial specifics',
  },
];

// Email pattern — used to REJECT in non-attendee fields and to ACCEPT shape
// in the attendee field.
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// Simple email-shape validator for the attendee field.
const EMAIL_SHAPE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

// Opaque token heuristic: single non-space run of ≥40 alphanumeric chars.
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_+/=-]{40,}/;

// ---------------------------------------------------------------------------
// Main exported filter function
// ---------------------------------------------------------------------------

/**
 * Apply field-level privacy filter for /organize.
 *
 * @param field - Which field is being filtered. Determines caps and exemptions.
 * @param raw   - The raw user-supplied string for that field.
 * @returns FilterResult — `{ok:true, value}` on accept or `{ok:false, reason}` on reject.
 *
 * CRITICAL: reason strings name the CATEGORY only. They NEVER echo the matched
 * substring. This invariant is test-asserted in organize.privacy.test.ts.
 */
export function filterOrganizeField(
  field: 'title' | 'notes' | 'progressEntry' | 'tag' | 'attendee',
  raw: string,
): FilterResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'field value must be a string' };
  }

  // Strip ASCII control chars (other than tab/newline) and trim.
  // Codepoints: 0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f, 0x7f.
  // Built via RegExp constructor (escape-sequence source) so the file
  // does not contain raw control chars — mirrors src/memory/userMemoryPrivacy.ts.
  const controlCharRegex = new RegExp(
    '[' +
      '\u0000-\u0008' +
      '\u000b\u000c' +
      '\u000e-\u001f' +
      '\u007f' +
      ']',
    'g',
  );
  const trimmed = raw.replace(controlCharRegex, '').trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'field value is empty after sanitization' };
  }

  // -------------------------------------------------------------------------
  // Per-field length caps (UTF-16 code units — JavaScript .length)
  // -------------------------------------------------------------------------
  if (field === 'title') {
    if (trimmed.length > MAX_TITLE) {
      return {
        ok: false,
        reason: `title is too long (${trimmed.length} chars; cap is ${MAX_TITLE})`,
      };
    }
  } else if (field === 'notes') {
    if (trimmed.length > MAX_NOTES) {
      return {
        ok: false,
        reason: `notes are too long (${trimmed.length} chars; cap is ${MAX_NOTES})`,
      };
    }
  } else if (field === 'progressEntry') {
    if (trimmed.length > MAX_PROGRESS) {
      return {
        ok: false,
        reason: `progress entry is too long (${trimmed.length} chars; cap is ${MAX_PROGRESS})`,
      };
    }
  } else if (field === 'tag') {
    if (trimmed.length > MAX_TAG) {
      return {
        ok: false,
        reason: `tag is too long (${trimmed.length} chars; cap is ${MAX_TAG})`,
      };
    }
  } else if (field === 'attendee') {
    // Attendees must be valid email shapes (≤254 chars per RFC 5321).
    if (trimmed.length > 254) {
      return { ok: false, reason: 'attendee email address is too long (cap is 254 chars)' };
    }
    if (!EMAIL_SHAPE.test(trimmed)) {
      return { ok: false, reason: 'attendee must be a valid email address' };
    }
  }

  // -------------------------------------------------------------------------
  // Credential scrubber (catches API key shapes)
  // -------------------------------------------------------------------------
  const scrubbed = scrub(trimmed);
  if (scrubbed !== trimmed) {
    return { ok: false, reason: 'contains what looks like a credential or API key' };
  }

  // -------------------------------------------------------------------------
  // Opaque token heuristic (≥40 alphanumeric chars)
  // Applied to title, notes, progressEntry only — not to tag (length ≤40, label)
  // or attendee (email shape already validated, scrubber catches known creds).
  // -------------------------------------------------------------------------
  if (field !== 'tag' && field !== 'attendee' && OPAQUE_TOKEN_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason: 'contains a long opaque token that looks like a credential',
    };
  }

  // -------------------------------------------------------------------------
  // Email address check — EXEMPT for attendee field, REJECT for everything else
  // -------------------------------------------------------------------------
  if (field !== 'attendee' && EMAIL_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason: 'contains an email address (use the attendees field for event emails)',
    };
  }

  // -------------------------------------------------------------------------
  // Credential / PII patterns (phone, SSN, CC, password, URL-with-token, financial)
  // -------------------------------------------------------------------------
  for (const { pattern, reason } of CREDENTIAL_REJECT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason };
    }
  }

  // -------------------------------------------------------------------------
  // Health / disease / prescription terms — reject-dominant (R4)
  // The reason names the CATEGORY only, never the matched term.
  // -------------------------------------------------------------------------
  if (HEALTH_REJECT_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason: 'contains disease/prescription terms — organize doesn\'t store medical specifics',
    };
  }

  return { ok: true, value: trimmed };
}
