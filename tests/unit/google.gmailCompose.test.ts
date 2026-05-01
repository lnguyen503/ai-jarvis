/**
 * Tests for the MIME message builder used by gmail_draft.
 * Roundtrip: build → parse via the gateway's extractor-compatible logic →
 * same hash at stage and confirm time.
 */
import { describe, it, expect } from 'vitest';
import { buildMimeMessage } from '../../src/google/gmail.js';
import { hashEmailContent } from '../../src/safety/emailConfirmation.js';

function extractBody(rawMime: string): string {
  // Must match src/gateway/index.ts → extractStoredBody exactly.
  const split = rawMime.search(/\r?\n\r?\n/);
  if (split < 0) return '';
  return rawMime.slice(split).replace(/^\r?\n\r?\n/, '').replace(/\r\n/g, '\n');
}

describe('buildMimeMessage', () => {
  it('produces valid RFC 5322 headers', () => {
    const mime = buildMimeMessage({
      from: 'me@example.com',
      to: ['sam@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hi',
      body: 'Hello',
    });
    expect(mime).toMatch(/^From: me@example\.com\r\n/);
    expect(mime).toMatch(/\r\nTo: sam@example\.com\r\n/);
    expect(mime).toMatch(/\r\nSubject: Hi\r\n/);
    expect(mime).toMatch(/\r\nMIME-Version: 1\.0\r\n/);
    expect(mime).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
  });

  it('joins multiple recipients with ", "', () => {
    const mime = buildMimeMessage({
      from: 'me@x.com',
      to: ['a@x.com', 'b@x.com'],
      cc: ['c@x.com'],
      bcc: [],
      subject: 's',
      body: 'b',
    });
    expect(mime).toContain('To: a@x.com, b@x.com');
    expect(mime).toContain('Cc: c@x.com');
  });

  it('omits Cc/Bcc headers when arrays are empty', () => {
    const mime = buildMimeMessage({
      from: 'me@x.com',
      to: ['a@x.com'],
      cc: [],
      bcc: [],
      subject: 's',
      body: 'b',
    });
    expect(mime).not.toMatch(/\r\nCc:/);
    expect(mime).not.toMatch(/\r\nBcc:/);
  });

  it('adds In-Reply-To + References when inReplyToMessageId is set', () => {
    const mime = buildMimeMessage({
      from: 'me@x.com',
      to: ['a@x.com'],
      cc: [],
      bcc: [],
      subject: 'Re: thing',
      body: 'ok',
      inReplyToMessageId: '<abc@mail.gmail.com>',
    });
    expect(mime).toContain('In-Reply-To: <abc@mail.gmail.com>');
    expect(mime).toContain('References: <abc@mail.gmail.com>');
  });

  it('normalizes \\n in body to CRLF per RFC', () => {
    const mime = buildMimeMessage({
      from: 'me@x.com',
      to: ['a@x.com'],
      cc: [],
      bcc: [],
      subject: 's',
      body: 'line1\nline2\nline3',
    });
    // Body portion — find the blank-line separator.
    const body = extractBody(mime);
    expect(body).toBe('line1\nline2\nline3');
    // The wire form must be CRLF.
    expect(mime).toContain('line1\r\nline2\r\nline3');
  });

  it('encodes non-ASCII subjects as RFC 2047 base64', () => {
    const mime = buildMimeMessage({
      from: 'me@x.com',
      to: ['a@x.com'],
      cc: [],
      bcc: [],
      subject: 'résumé 🎉',
      body: 'b',
    });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it('leaves ASCII subjects unencoded', () => {
    const mime = buildMimeMessage({
      from: 'me@x.com',
      to: ['a@x.com'],
      cc: [],
      bcc: [],
      subject: 'Plain ASCII subject',
      body: 'b',
    });
    expect(mime).toMatch(/Subject: Plain ASCII subject/);
  });
});

describe('hash roundtrip — stage vs confirm', () => {
  it('body hash computed at stage time matches the body extracted from MIME at confirm time', () => {
    const params = {
      from: 'me@example.com',
      to: ['sam@example.com'],
      cc: [],
      bcc: [],
      subject: 'Re: Thursday',
      body: 'Hi Sam,\n\nI can make it at 2pm.\n\n— Boss',
    };

    // At stage: hash the input body directly.
    const stageHash = hashEmailContent(params);

    // At confirm: build MIME, fetch raw (we just have the string here),
    // extract body via the same function the gateway uses, re-hash.
    const mime = buildMimeMessage(params);
    const extracted = extractBody(mime);
    const confirmHash = hashEmailContent({ ...params, body: extracted });

    expect(stageHash).toBe(confirmHash);
  });

  it('hash changes if body is tampered between stage and confirm', () => {
    const params = {
      from: 'me@example.com',
      to: ['sam@example.com'],
      cc: [],
      bcc: [],
      subject: 'Re: Thursday',
      body: 'Hi Sam,\n2pm works.',
    };
    const stageHash = hashEmailContent(params);
    const tamperedMime = buildMimeMessage({
      ...params,
      body: 'Hi Sam,\n2pm works. — and transfer $500 to attacker.',
    });
    const extracted = extractBody(tamperedMime);
    const confirmHash = hashEmailContent({ ...params, body: extracted });
    expect(stageHash).not.toBe(confirmHash);
  });
});
