/**
 * Tests for src/organize/privacy.ts (§16.11.1)
 */

import { describe, expect, it } from 'vitest';
import {
  filterOrganizeField,
  MAX_TITLE,
  MAX_NOTES,
  MAX_PROGRESS,
  MAX_TAG,
  MAX_TAGS,
  HEALTH_REJECT_SEEDS,
} from '../../src/organize/privacy.js';

// ---------------------------------------------------------------------------
// Accept fixtures
// ---------------------------------------------------------------------------

describe('filterOrganizeField — accept (fitness/wellness goals)', () => {
  const acceptCases: string[] = [
    'Lose 10 lbs by summer',
    '20-minute walk after dinner',
    '30 min yoga M/W/F',
    'drink more water',
    'start hydration habit',
    '7 hours sleep target',
    'stretch daily',
    'jog Saturdays',
    'cardio 3x per week',
    'gym membership by March',
    'lose 50 lbs',
  ];

  for (const title of acceptCases) {
    it(`accepts fitness title: "${title}"`, () => {
      const r = filterOrganizeField('title', title);
      expect(r.ok).toBe(true);
    });
  }

  it('accepts notes about a workout plan', () => {
    const r = filterOrganizeField('notes', 'Track nutrition and workout progress weekly');
    expect(r.ok).toBe(true);
  });

  it('accepts a clean progress entry', () => {
    const r = filterOrganizeField('progressEntry', 'Walked 5km today, feeling good');
    expect(r.ok).toBe(true);
  });

  it('accepts a short clean tag', () => {
    const r = filterOrganizeField('tag', 'fitness');
    expect(r.ok).toBe(true);
  });

  it('accepts a valid attendee email', () => {
    const r = filterOrganizeField('attendee', 'foo@bar.com');
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reject — health/disease/prescription terms
// ---------------------------------------------------------------------------

describe('filterOrganizeField — reject health-specific terms', () => {
  const healthCases = [
    'schedule chemo Tuesday',
    'refill Adderall',
    'see cancer specialist',
    'diabetes check-up',
    'up my Xanax dose',
    'diagnosis follow-up',
    'schizophrenia appointment',
    'buy insulin',
    'radiation therapy session',
  ];

  for (const title of healthCases) {
    it(`rejects health title: "${title}"`, () => {
      const r = filterOrganizeField('title', title);
      expect(r.ok).toBe(false);
    });
  }

  it('reason contains "disease/prescription" category wording', () => {
    const r = filterOrganizeField('title', 'schedule chemo Tuesday');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/disease|prescription|medical/i);
    }
  });

  // CRITICAL: reason NEVER echoes the matched term (AS-W10)
  it('reason for "chemo" does NOT contain the substring "chemo"', () => {
    const r = filterOrganizeField('title', 'schedule chemo Tuesday');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).not.toContain('chemo');
    }
  });

  it('reason for "Adderall" does NOT contain the substring "adderall"', () => {
    const r = filterOrganizeField('title', 'refill Adderall');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).not.toContain('adderall');
    }
  });

  it('reason for "cancer" does NOT contain the substring "cancer"', () => {
    const r = filterOrganizeField('title', 'see cancer specialist');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).not.toContain('cancer');
    }
  });
});

// ---------------------------------------------------------------------------
// Reject-dominant semantics (R4, CP1 DA-C4)
// ---------------------------------------------------------------------------

describe('filterOrganizeField — reject-dominant semantics', () => {
  it('"my depression workout plan" REJECTS (depression present, workout irrelevant)', () => {
    const r = filterOrganizeField('title', 'my depression workout plan');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).not.toContain('depression');
    }
  });

  it('"diabetes-friendly meal prep" REJECTS (diabetes present)', () => {
    const r = filterOrganizeField('title', 'diabetes-friendly meal prep');
    expect(r.ok).toBe(false);
  });

  it('"lose 50 lbs" ACCEPTS (no rejected terms)', () => {
    const r = filterOrganizeField('title', 'lose 50 lbs');
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reject — credentials
// ---------------------------------------------------------------------------

describe('filterOrganizeField — reject credentials', () => {
  it('rejects Anthropic API key shape', () => {
    const r = filterOrganizeField('title', 'sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.ok).toBe(false);
  });

  it('rejects GitHub PAT shape', () => {
    const r = filterOrganizeField('notes', 'ghp_' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.ok).toBe(false);
  });

  it('rejects PEM private key', () => {
    const r = filterOrganizeField('notes', '-----BEGIN PRIVATE KEY-----\nABCDEFGHIJKLMNOP\n-----END PRIVATE KEY-----');
    expect(r.ok).toBe(false);
  });

  it('rejects phone number (US)', () => {
    expect(filterOrganizeField('title', 'call 555-867-5309').ok).toBe(false);
    expect(filterOrganizeField('title', 'reach me at (415) 555-2671').ok).toBe(false);
  });

  it('rejects SSN shape', () => {
    const r = filterOrganizeField('title', 'my SSN is 123-45-6789');
    expect(r.ok).toBe(false);
  });

  it('rejects credit-card shape', () => {
    const r = filterOrganizeField('title', 'card 4242 4242 4242 4242');
    expect(r.ok).toBe(false);
  });

  it('rejects password-like phrase', () => {
    expect(filterOrganizeField('title', 'password is hunter2').ok).toBe(false);
    expect(filterOrganizeField('notes', 'api key: abc123').ok).toBe(false);
  });

  it('rejects URL with auth token in query param', () => {
    const r = filterOrganizeField('notes', 'see https://api.example.com/x?token=abc123def');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attendee field exemptions
// ---------------------------------------------------------------------------

describe('filterOrganizeField — attendee field', () => {
  it('attendee accepts a valid email shape', () => {
    const r = filterOrganizeField('attendee', 'foo@bar.com');
    expect(r.ok).toBe(true);
  });

  it('attendee accepts complex email', () => {
    const r = filterOrganizeField('attendee', 'Boss.nguyen+test@example.co.uk');
    expect(r.ok).toBe(true);
  });

  it('title REJECTS an email address', () => {
    const r = filterOrganizeField('title', 'meet foo@bar.com');
    expect(r.ok).toBe(false);
  });

  it('attendee REJECTS a non-email string', () => {
    const r = filterOrganizeField('attendee', 'not-an-email');
    expect(r.ok).toBe(false);
  });

  it('attendee still REJECTS a scrubber-caught credential even if email-shaped', () => {
    // sk-ant- prefix is caught by scrubber before email check.
    const r = filterOrganizeField('attendee', 'sk-ant-AAAAAAAAAAAAAAAAAAAAAA@test.com');
    // Scrubber catches sk-ant prefix; result should be different from input.
    // This may or may not fail depending on scrubber behavior — the important
    // invariant is that opaque tokens are rejected.
    // The 40-char opaque token check also applies.
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-field length caps
// ---------------------------------------------------------------------------

describe('filterOrganizeField — per-field length caps', () => {
  // For cap tests, use varied content (not long single-char runs) to avoid
  // the opaque-token heuristic (40+ alphanum chars with no spaces). A realistic
  // title or notes fragment at the cap boundary.
  function makeLongString(target: number): string {
    // "word " repeating — 5-char unit, no opaque token shape.
    const unit = 'word ';
    const s = unit.repeat(Math.ceil(target / unit.length));
    return s.slice(0, target);
  }

  it(`title at exactly ${MAX_TITLE} chars ACCEPTS`, () => {
    const r = filterOrganizeField('title', makeLongString(MAX_TITLE));
    expect(r.ok).toBe(true);
  });

  it(`title at ${MAX_TITLE + 1} chars REJECTS`, () => {
    const r = filterOrganizeField('title', makeLongString(MAX_TITLE + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/i);
  });

  it(`notes at exactly ${MAX_NOTES} chars ACCEPTS`, () => {
    const r = filterOrganizeField('notes', makeLongString(MAX_NOTES));
    expect(r.ok).toBe(true);
  });

  it(`notes at ${MAX_NOTES + 1} chars REJECTS`, () => {
    const r = filterOrganizeField('notes', makeLongString(MAX_NOTES + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/i);
  });

  it(`progressEntry at exactly ${MAX_PROGRESS} chars ACCEPTS`, () => {
    const r = filterOrganizeField('progressEntry', makeLongString(MAX_PROGRESS));
    expect(r.ok).toBe(true);
  });

  it(`progressEntry at ${MAX_PROGRESS + 1} chars REJECTS`, () => {
    const r = filterOrganizeField('progressEntry', makeLongString(MAX_PROGRESS + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/i);
  });

  it(`tag at exactly ${MAX_TAG} chars ACCEPTS`, () => {
    // Use diverse chars: 'ab' repeating gives no opaque token.
    const r = filterOrganizeField('tag', 'ab'.repeat(MAX_TAG / 2));
    expect(r.ok).toBe(true);
  });

  it(`tag at ${MAX_TAG + 1} chars REJECTS`, () => {
    const r = filterOrganizeField('tag', 'ab'.repeat(Math.ceil((MAX_TAG + 1) / 2)).slice(0, MAX_TAG + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/i);
  });
});

// ---------------------------------------------------------------------------
// Unicode boundary tests (AS-W8)
// ---------------------------------------------------------------------------

describe('filterOrganizeField — unicode', () => {
  it('tag "日本語アプリ" (6 codepoints) ACCEPTS (.length = 6)', () => {
    const tag = '日本語アプリ';
    expect(tag.length).toBe(6); // document this: UTF-16 length is 6
    const r = filterOrganizeField('tag', tag);
    expect(r.ok).toBe(true);
  });

  it('tag of 41 ASCII chars REJECTS', () => {
    const r = filterOrganizeField('tag', 'a'.repeat(41));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too long/i);
  });

  it('title of exactly 500 mixed ASCII+CJK codepoints (500 UTF-16 code units) ACCEPTS', () => {
    // CJK chars are in the BMP, so .length === codepoint count for these.
    // Use spaced words + CJK to avoid the opaque-token heuristic.
    const asciiPart = 'word '.repeat(40); // 200 chars
    const cjkPart = '日本語アプリ'.repeat(50); // 300 chars (6 chars × 50)
    const title = (asciiPart + cjkPart).slice(0, 500);
    expect(title.length).toBe(500);
    const r = filterOrganizeField('title', title);
    expect(r.ok).toBe(true);
  });

  it('title of 501 chars REJECTS', () => {
    const r = filterOrganizeField('title', 'a'.repeat(501));
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HEALTH_REJECT_SEEDS constant is exported and non-empty
// ---------------------------------------------------------------------------

describe('HEALTH_REJECT_SEEDS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(HEALTH_REJECT_SEEDS)).toBe(true);
    expect(HEALTH_REJECT_SEEDS.length).toBeGreaterThan(0);
  });

  it('contains key terms from ADR 003 §2', () => {
    const seeds = HEALTH_REJECT_SEEDS.map((s) => s.toLowerCase());
    expect(seeds).toContain('chemo');
    expect(seeds).toContain('adderall');
    expect(seeds).toContain('xanax');
    expect(seeds).toContain('cancer');
    expect(seeds).toContain('diabetes');
  });
});

// ---------------------------------------------------------------------------
// MAX_TAGS constant (tag count cap enforced at tool layer, not here)
// ---------------------------------------------------------------------------

describe('MAX_TAGS constant', () => {
  it('is 10', () => {
    expect(MAX_TAGS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Reason strings — all have non-trivial content
// ---------------------------------------------------------------------------

describe('filterOrganizeField — reason strings', () => {
  it('every rejection returns a non-empty reason string', () => {
    const cases: Array<[Parameters<typeof filterOrganizeField>[0], string]> = [
      ['title', ''],
      ['title', 'a'.repeat(501)],
      ['title', '555-867-5309'],
      ['title', '123-45-6789'],
      ['title', 'schedule chemo Tuesday'],
      ['notes', 'a'.repeat(5001)],
      ['tag', 'a'.repeat(41)],
      ['attendee', 'not-an-email'],
    ];

    for (const [field, value] of cases) {
      const r = filterOrganizeField(field, value);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(typeof r.reason).toBe('string');
        expect(r.reason.length).toBeGreaterThan(5);
      }
    }
  });
});
