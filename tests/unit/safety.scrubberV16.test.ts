/**
 * V-16 regression: expanded scrubber patterns (Stripe, Google OAuth, npm, HF, Telegram, API key headers, DB URLs).
 */
import { describe, it, expect } from 'vitest';
import { scrub } from '../../src/safety/scrubber.js';

describe('safety.scrubber — V-16 additional patterns', () => {
  it('scrubs Stripe secret key (sk_live_)', () => {
    const text = 'Stripe key: sk_live_' + 'abcdefghijklmnopqrstuvwx';
    const out = scrub(text);
    expect(out).not.toContain('sk_live_');
    expect(out).toContain('[REDACTED:STRIPE_KEY]');
  });

  it('scrubs Stripe secret key (sk_test_)', () => {
    const text = 'key=sk_test_' + 'ABCDEFghijklmnopqrstuvwxy';
    const out = scrub(text);
    expect(out).not.toContain('sk_test_');
    expect(out).toContain('[REDACTED:STRIPE_KEY]');
  });

  it('scrubs Stripe restricted key (rk_live_)', () => {
    const text = 'rk_live_' + 'ABCDEFghijklmnopqrstuvwxy1234';
    const out = scrub(text);
    expect(out).not.toContain('rk_live_');
    expect(out).toContain('[REDACTED:STRIPE_RKEY]');
  });

  it('scrubs Stripe publishable key (pk_live_)', () => {
    const text = 'pk_live_' + 'ABCDEFghijklmnopqrstuvwxy1234';
    const out = scrub(text);
    expect(out).not.toContain('pk_live_');
    expect(out).toContain('[REDACTED:STRIPE_PKEY]');
  });

  it('scrubs Google OAuth client secret (GOCSPX-)', () => {
    const text = 'client_secret: GOCSPX-' + 'abcdefghijklmnopqrstu';
    const out = scrub(text);
    expect(out).not.toContain('GOCSPX-');
    expect(out).toContain('[REDACTED:GOOGLE_OAUTH]');
  });

  it('scrubs npm token (npm_)', () => {
    // npm tokens are exactly 36 chars after npm_
    const token36 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'; // 36 chars
    const text = `NPM_TOKEN=npm_${token36}`;
    const out = scrub(text);
    expect(out).not.toContain(`npm_${token36}`);
    expect(out).toContain('[REDACTED:NPM_TOKEN]');
  });

  it('scrubs HuggingFace token (hf_)', () => {
    // hf_ tokens are exactly 34 chars after hf_
    const token34 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh'; // 34 chars
    const text = `HF_TOKEN=hf_${token34}`;
    const out = scrub(text);
    expect(out).not.toContain(`hf_${token34}`);
    expect(out).toContain('[REDACTED:HF_TOKEN]');
  });

  it('scrubs Telegram bot token (digits:chars)', () => {
    const text = 'BOT_TOKEN=1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm';
    const out = scrub(text);
    expect(out).not.toContain('1234567890:');
    expect(out).toContain('[REDACTED:TELEGRAM_BOT_TOKEN]');
  });

  it('scrubs generic x-api-key header', () => {
    const text = 'curl -H "x-api-key: supersecretapikey123456789012"';
    const out = scrub(text);
    expect(out).not.toContain('supersecretapikey123456789012');
    expect(out).toContain('[REDACTED:API_KEY_HEADER]');
  });

  it('scrubs generic api_key= value', () => {
    const text = 'api_key=abcdefghijklmnopqrstuvwxyz12345678';
    const out = scrub(text);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz12345678');
    expect(out).toContain('[REDACTED:API_KEY_HEADER]');
  });

  it('scrubs DB URL password (postgres://)', () => {
    const text = 'DATABASE_URL=postgres://user:supersecretpassword@localhost:5432/mydb';
    const out = scrub(text);
    expect(out).not.toContain('supersecretpassword');
    expect(out).toContain('[REDACTED:DB_PASSWORD]');
  });

  it('scrubs DB URL password (mysql://)', () => {
    const text = 'DB=mysql://root:mysecretpass@127.0.0.1:3306/app';
    const out = scrub(text);
    expect(out).not.toContain('mysecretpass');
    expect(out).toContain('[REDACTED:DB_PASSWORD]');
  });

  it('scrubs Authorization: Bearer header', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig';
    const out = scrub(text);
    // Should not contain the raw token portion
    expect(out).toContain('Authorization: Bearer [REDACTED');
  });

  // Verify no regression on existing patterns
  it('still scrubs Anthropic keys', () => {
    const text = 'sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz123456';
    const out = scrub(text);
    expect(out).toContain('[REDACTED:ANTHROPIC_KEY]');
  });

  it('still scrubs GitHub PAT', () => {
    const text = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef01';
    const out = scrub(text);
    expect(out).toContain('[REDACTED:GITHUB_PAT]');
  });

  it('does not create false positives on short strings', () => {
    const text = 'hf_ab'; // too short for HF token
    const out = scrub(text);
    expect(out).toBe(text);
  });
});
