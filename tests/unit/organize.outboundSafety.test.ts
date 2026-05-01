/**
 * Direct unit tests for checkOutboundSafety (cp1 R1 / QA W7 / Fix #4).
 *
 * One describe per pattern class; 2–4 assertions each:
 *   - Positive match case → rejected (ok: false, named pattern).
 *   - Negative case → accepted (ok: true).
 * Also asserts the returned `pattern` field names the matched rule.
 * Also asserts a benign realistic goal-reminder message passes cleanly.
 */

import { describe, expect, it } from 'vitest';
import { checkOutboundSafety } from '../../src/organize/reminders.js';

// ---------------------------------------------------------------------------
// Pattern 1: CONFIRM SEND <token>
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — confirm-send', () => {
  it('rejects message containing CONFIRM SEND token6+', () => {
    const result = checkOutboundSafety('CONFIRM SEND abc123def to verify your account');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('confirm-send');
  });

  it('rejects case-insensitive variant', () => {
    const result = checkOutboundSafety('please confirm send XYZ999zz now');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('confirm-send');
  });

  it('accepts message with CONFIRM but no SEND token', () => {
    const result = checkOutboundSafety('Please confirm you sent the form');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: CONFIRM TRANSFER <token>
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — confirm-transfer', () => {
  it('rejects CONFIRM TRANSFER with 6-char token', () => {
    const result = checkOutboundSafety('CONFIRM TRANSFER abc123 to complete');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('confirm-transfer');
  });

  it('rejects mixed-case variant', () => {
    const result = checkOutboundSafety('Confirm Transfer XYZ789ab');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('confirm-transfer');
  });

  it('accepts message with "transfer" in a safe context', () => {
    const result = checkOutboundSafety("Don't forget to transfer your notes from yesterday");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: YES <hex action-id 4–8 chars>
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — yes-action-id', () => {
  it('rejects YES followed by 4-char hex', () => {
    const result = checkOutboundSafety('Type YES a7b3 to proceed');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('yes-action-id');
  });

  it('rejects YES followed by 8-char hex', () => {
    const result = checkOutboundSafety('Reply YES deadbeef to confirm');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('yes-action-id');
  });

  it('accepts "yes" in a natural sentence without hex', () => {
    const result = checkOutboundSafety("Yes, this task is still due tomorrow");
    expect(result.ok).toBe(true);
  });

  it('accepts YES followed by non-hex word', () => {
    const result = checkOutboundSafety('Yes absolutely');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: Credential-name echo
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — credential-name-echo', () => {
  it('rejects ANTHROPIC_API_KEY mention', () => {
    const result = checkOutboundSafety('Your ANTHROPIC_API_KEY might need renewal');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('credential-name-echo');
  });

  it('rejects OPENAI_API_KEY variant', () => {
    const result = checkOutboundSafety('Check your OPENAI_API_KEY expiry');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('credential-name-echo');
  });

  it('rejects TELEGRAM_TOKEN mention', () => {
    const result = checkOutboundSafety('Update your TELEGRAM_TOKEN in config');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('credential-name-echo');
  });

  it('accepts message mentioning "anthropic" in a safe context', () => {
    const result = checkOutboundSafety("Anthropic released a new model today");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: Credential shapes via scrubber
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — credential-scrubber', () => {
  it('rejects message containing sk-ant- style key', () => {
    // Use a fake key with the right prefix so scrubber catches it
    const result = checkOutboundSafety('Here is your key: sk-ant-AAAAAAAAAAAAAAAAAAAAAA');
    // scrubber should redact it → scrub(text) !== text → credential-scrubber
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('credential-scrubber');
  });

  it('accepts normal message not matching any credential shape', () => {
    const result = checkOutboundSafety("Your weekly review task is 5 days overdue");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 6: URL with embedded credentials
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — url-with-auth', () => {
  it('rejects URL with user:pass@ component', () => {
    const result = checkOutboundSafety('Visit https://evil:pass@bad.com/reset');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('url-with-auth');
  });

  it('rejects http URL with auth', () => {
    const result = checkOutboundSafety('Check http://user@example.com');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('url-with-auth');
  });

  it('accepts plain URL without credentials', () => {
    const result = checkOutboundSafety('More info at https://example.com/docs');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 7: Password dictation
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — password-dictation', () => {
  it('rejects "password is <value>"', () => {
    const result = checkOutboundSafety('Your password is hunter2');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('password-dictation');
  });

  it('rejects "password: <value>"', () => {
    const result = checkOutboundSafety('password: abc123');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('password-dictation');
  });

  it('rejects "password=<value>"', () => {
    const result = checkOutboundSafety('password=secretVal');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('password-dictation');
  });

  it('accepts message mentioning password in a safe context', () => {
    const result = checkOutboundSafety("Remember to change your password this month");
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pattern 8: Zero-width / bidi-override Unicode
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — bidi-zero-width', () => {
  it('rejects message containing zero-width space (U+200B)', () => {
    const result = checkOutboundSafety('Hello​world');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('bidi-zero-width');
  });

  it('rejects message containing bidi override (U+202E)', () => {
    const result = checkOutboundSafety('Normal‮text');
    expect(result.ok).toBe(false);
    expect((result as { ok: false; pattern: string }).pattern).toBe('bidi-zero-width');
  });

  it('accepts message with only standard ASCII and common unicode', () => {
    const result = checkOutboundSafety('Your "lose 10 lbs" goal hasn\'t had progress in 16 days — want me to suggest 3 walking routes?');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Benign realistic goal-reminder message passes cleanly
// ---------------------------------------------------------------------------

describe('checkOutboundSafety — benign messages pass', () => {
  it('typical goal-nudge message is accepted', () => {
    const result = checkOutboundSafety(
      "Your 'lose 10 lbs' goal hasn't had progress in 16 days — want me to suggest 3 walking routes?"
    );
    expect(result.ok).toBe(true);
  });

  it('task reminder with due date is accepted', () => {
    const result = checkOutboundSafety(
      "Reminder: your 'Submit tax return' task is due in 3 days."
    );
    expect(result.ok).toBe(true);
  });

  it('empty string is accepted', () => {
    const result = checkOutboundSafety('');
    expect(result.ok).toBe(true);
  });
});
