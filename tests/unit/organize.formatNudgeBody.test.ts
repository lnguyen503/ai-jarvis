/**
 * Tests for formatNudgeBody (v1.9.1 polish).
 *
 * Covers the defense-in-depth pass that the reminder orchestrator runs on
 * the LLM-authored `decision.message` + `offer.description` text BEFORE the
 * body is sent to the user's DM:
 *   1. Credential scrub via src/safety/scrubber.ts (belt-and-braces — the
 *      outbound-safety filter already REJECTS messages that contain
 *      credential shapes; this is the second pass in case the filter's
 *      pattern list misses one).
 *   2. Control-char + bidi-override + zero-width strip (v1.9.1) — prevents
 *      exotic Unicode in LLM output from rendering weirdly on Telegram
 *      or enabling display-level spoofing.
 *
 * The outbound-safety FILTER (checkOutboundSafety) is tested separately in
 * tests/unit/organize.outboundSafety.test.ts — it REJECTS messages that
 * match a pattern class. formatNudgeBody is the post-acceptance CLEANER
 * for messages that passed the filter.
 */

import { describe, expect, it } from 'vitest';
import { formatNudgeBody } from '../../src/organize/reminders.js';

const BASE = {
  shouldNudge: true as const,
  itemId: '2026-04-24-aaaa',
  reasoning: '',
  urgency: 'medium' as const,
};

describe('formatNudgeBody — control-char strip (v1.9.1)', () => {
  it('strips ASCII control chars other than tab / newline', () => {
    // Assemble via String.fromCharCode so the source file has no raw control chars.
    const nul = String.fromCharCode(0x00);
    const bell = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);
    const msg = `hello${nul}world${bell}end${del}.`;
    const body = formatNudgeBody({ ...BASE, message: msg });
    expect(body).toBe('helloworldend.');
    expect(body).not.toContain(nul);
    expect(body).not.toContain(bell);
    expect(body).not.toContain(del);
  });

  it('preserves newlines and tabs', () => {
    const body = formatNudgeBody({ ...BASE, message: 'line1\nline2\tcol2' });
    expect(body).toBe('line1\nline2\tcol2');
  });

  it('strips zero-width space / joiner / non-joiner', () => {
    const zwsp = String.fromCharCode(0x200b);
    const zwnj = String.fromCharCode(0x200c);
    const zwj = String.fromCharCode(0x200d);
    const msg = `t${zwsp}e${zwnj}x${zwj}t`;
    const body = formatNudgeBody({ ...BASE, message: msg });
    expect(body).toBe('text');
  });

  it('strips LRE / RLE / PDF / LRO / RLO bidi-override block (U+202A–U+202E)', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]) {
      const msg = `safe${String.fromCharCode(cp)}evil.com`;
      const body = formatNudgeBody({ ...BASE, message: msg });
      expect(body).toBe('safeevil.com');
    }
  });

  it('strips LRI / RLI / FSI / PDI isolates (U+2066–U+2069)', () => {
    for (const cp of [0x2066, 0x2067, 0x2068, 0x2069]) {
      const msg = `pre${String.fromCharCode(cp)}post`;
      const body = formatNudgeBody({ ...BASE, message: msg });
      expect(body).toBe('prepost');
    }
  });
});

describe('formatNudgeBody — structure', () => {
  it('includes the italic offer line when offer kind is tool-help', () => {
    const body = formatNudgeBody({
      ...BASE,
      message: 'hello',
      offer: { kind: 'tool-help', description: 'want me to help?' },
    });
    expect(body).toBe('hello\n\n_want me to help?_');
  });

  it('omits the offer line when offer.kind is none', () => {
    const body = formatNudgeBody({
      ...BASE,
      message: 'hello',
      offer: { kind: 'none', description: 'ignored text' },
    });
    expect(body).toBe('hello');
  });

  it('omits the offer line when offer is absent', () => {
    const body = formatNudgeBody({ ...BASE, message: 'hello' });
    expect(body).toBe('hello');
  });
});

describe('formatNudgeBody — credential scrub (existing defense)', () => {
  it('scrubs Anthropic API key shapes', () => {
    const msg = 'debug: sk-ant-api03-' + 'abcdefghijklmnopqrstuvwx and continue';
    const body = formatNudgeBody({ ...BASE, message: msg });
    expect(body).not.toContain('sk-ant-api03-' + 'abcdefghijklmnopqrstuvwx');
  });

  it('scrubs credential split by zero-width chars (regression: v1.9.1 scrub-vs-strip order)', () => {
    // Anti-Slop W1 (v1.9.1 review): if scrub() ran BEFORE the control-char
    // strip, this ZWSP-split credential would evade the scrubber (pattern
    // doesn't match across ZWSP), then the strip would remove the ZWSP
    // leaving a plaintext key. Test asserts strip-first ordering so the
    // scrubber sees (and redacts) the re-assembled credential.
    const zwsp = String.fromCharCode(0x200b);
    const zwnj = String.fromCharCode(0x200c);
    // Splice zero-width chars throughout a real sk-ant shape.
    const credential = `sk-ant-${zwsp}api03-${zwnj}abcdefghijklmnopqrstuvwx`;
    const msg = `leaked: ${credential} please`;
    const body = formatNudgeBody({ ...BASE, message: msg });
    expect(body).not.toContain('sk-ant-api03-' + 'abcdefghijklmnopqrstuvwx');
    expect(body).not.toContain(zwsp);
    expect(body).not.toContain(zwnj);
  });
});
