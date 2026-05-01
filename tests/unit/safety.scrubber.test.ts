/**
 * §15.5 — Secret scrubber tests (C7, C8).
 * Regex set for common API key, token, PEM, and credential shapes.
 */
import { describe, it, expect } from 'vitest';
import { scrub } from '../../src/safety/scrubber.js';

describe('safety.scrubber.scrub (§15.5)', () => {
  it('scrubs Anthropic keys (sk-ant-...)', () => {
    const text = 'My key is sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz1234567890-extra-stuff';
    const out = scrub(text);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[REDACTED:ANTHROPIC_KEY]');
  });

  it('scrubs generic OpenAI keys (sk-...)', () => {
    const text = 'sk-abcdef1234567890ABCDEF1234567890XYZ';
    const out = scrub(text);
    expect(out).toContain('[REDACTED:OPENAI_KEY]');
    expect(out).not.toMatch(/^sk-[A-Za-z0-9]{20,}$/);
  });

  it('scrubs GitHub personal access tokens (ghp_/ghs_/ghr_)', () => {
    const text = 'token: ghp_' + 'abcdef1234567890ABCDEFGHIJKLMNOPQRSTUV';
    const out = scrub(text);
    expect(out).toContain('[REDACTED:GITHUB_PAT]');
    expect(out).not.toContain('ghp_abcdef');
  });

  it('scrubs Google API keys (AIza...)', () => {
    const text = 'AIzaSyAbcdefghijklmnopqrstuvwxyz0123456789X';
    const out = scrub(text);
    expect(out).toContain('[REDACTED:GOOGLE_API_KEY]');
  });

  it('scrubs AWS access keys (AKIA...)', () => {
    const text = 'key = AKIAIOSFODNN7EXAMPLE';
    const out = scrub(text);
    expect(out).toContain('[REDACTED:AWS_ACCESS_KEY]');
  });

  it('scrubs Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop';
    const out = scrub(text);
    expect(out).toContain('[REDACTED');
    // either BEARER_TOKEN or JWT replacement
  });

  it('scrubs JWTs', () => {
    const text = 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgXYZ';
    const out = scrub(text);
    expect(out).toContain('[REDACTED:JWT]');
  });

  it('scrubs PEM private keys (multi-line)', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1234567890abcdef',
      'abcdef1234567890abcdef1234567890',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = scrub(pem);
    expect(out).toContain('[REDACTED:PEM_PRIVATE_KEY]');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('scrubs 40-char hex blobs', () => {
    const hash = 'a'.repeat(40);
    const text = `token: ${hash}`;
    const out = scrub(text);
    expect(out).toContain('[REDACTED:HEX_BLOB]');
  });

  it('does not mangle safe text', () => {
    const text = 'hello world, this is a normal command output';
    expect(scrub(text)).toBe(text);
  });

  it('is side-effect free (returns new string)', () => {
    const original = 'sk-ant-abcdefghijklmnopqrstuvwxyz1234567890';
    const copy = original;
    scrub(original);
    expect(original).toBe(copy);
  });
});
