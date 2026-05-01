import { describe, expect, it } from 'vitest';
import { filterMemoryFact } from '../../src/memory/userMemoryPrivacy.js';

describe('filterMemoryFact — accept', () => {
  it('accepts a clean preference statement', () => {
    const r = filterMemoryFact('prefers brief replies');
    expect(r.ok).toBe(true);
    expect(r.fact).toBe('prefers brief replies');
  });

  it('accepts a project description', () => {
    const r = filterMemoryFact('works on rehearse-sales, deployed to Cloud Run');
    expect(r.ok).toBe(true);
  });

  it('accepts a relationship label', () => {
    const r = filterMemoryFact('Kim is my sister');
    expect(r.ok).toBe(true);
  });

  it('accepts a tech preference', () => {
    const r = filterMemoryFact('uses Vim, prefers TypeScript over JavaScript');
    expect(r.ok).toBe(true);
  });

  it('accepts time-zone facts', () => {
    const r = filterMemoryFact('lives in Pacific time zone (PT/PDT)');
    expect(r.ok).toBe(true);
  });

  it('trims whitespace and control chars', () => {
    const r = filterMemoryFact('  prefers brief replies  ');
    expect(r.ok).toBe(true);
    expect(r.fact).toBe('prefers brief replies');
  });
});

describe('filterMemoryFact — reject', () => {
  it('rejects empty input after sanitization', () => {
    expect(filterMemoryFact('').ok).toBe(false);
    expect(filterMemoryFact('     ').ok).toBe(false);
  });

  it('rejects facts over 500 chars', () => {
    const r = filterMemoryFact('x'.repeat(600));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too long/i);
  });

  it('rejects phone numbers (US)', () => {
    expect(filterMemoryFact('call me at 555-867-5309').ok).toBe(false);
    expect(filterMemoryFact('reach me at (415) 555-2671').ok).toBe(false);
    expect(filterMemoryFact('text me 415.555.2671').ok).toBe(false);
  });

  it('rejects SSN-shape', () => {
    const r = filterMemoryFact('my number is 123-45-6789');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/social security/i);
  });

  it('rejects credit-card-shape', () => {
    const r = filterMemoryFact('card 4242 4242 4242 4242');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/credit card/i);
  });

  it('rejects email addresses', () => {
    expect(filterMemoryFact('email me at Boss@example.com').ok).toBe(false);
  });

  it('rejects credential-like phrases', () => {
    expect(filterMemoryFact('the password is hunter2').ok).toBe(false);
    expect(filterMemoryFact('api key: abc123').ok).toBe(false);
    expect(filterMemoryFact('my pin = 1234').ok).toBe(false);
  });

  it('rejects URLs with auth tokens', () => {
    expect(filterMemoryFact('use https://api.example.com/x?token=abc123def').ok).toBe(false);
  });

  it('rejects health-specific terms', () => {
    expect(filterMemoryFact('diagnosed with diabetes in 2020').ok).toBe(false);
    expect(filterMemoryFact('takes prescription for anxiety').ok).toBe(false);
  });

  it('rejects financial specifics', () => {
    expect(filterMemoryFact('salary is 120k').ok).toBe(false);
    expect(filterMemoryFact('bank account 12345 at chase').ok).toBe(false);
  });

  it('rejects long opaque tokens (>=40 alphanum chars)', () => {
    const longToken = 'a'.repeat(50);
    const r = filterMemoryFact(`my key ${longToken}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/opaque token/i);
  });

  it('rejects content the safety scrubber would scrub (api keys)', () => {
    // sk-ant-... is the Anthropic key shape the scrubber catches.
    const r = filterMemoryFact('save sk-ant-api03-' + '1234567890abcdefghijklmn');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/credential|opaque|key/i);
  });

  it('returns string reason for every rejection (not undefined)', () => {
    const cases = [
      '',
      'x'.repeat(600),
      '555-867-5309',
      '123-45-6789',
      'Boss@example.com',
      'password is foo',
    ];
    for (const c of cases) {
      const r = filterMemoryFact(c);
      expect(r.ok).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect(r.reason!.length).toBeGreaterThan(5);
    }
  });
});
