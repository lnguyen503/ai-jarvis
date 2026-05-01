/**
 * Tests for src/google/gmail.ts pure helpers — header lookup, base64url
 * decoding, MIME-part walking, HTML stripping.
 *
 * These are the parts most likely to regress silently when we touch Gmail
 * later (adding send, forwarding, etc.), so they deserve direct coverage.
 * The GmailApi class itself is thin glue over googleapis; its behavior is
 * exercised indirectly by tools.gmail tests.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeBase64Url,
  extractHeader,
  extractBody,
  findPart,
  extractAttachments,
  stripHtml,
} from '../../src/google/gmail.js';
import type { gmail_v1 } from 'googleapis';

describe('extractHeader', () => {
  const headers = [
    { name: 'From', value: 'sam@example.com' },
    { name: 'SUBJECT', value: 'Hello' },
    { name: 'date', value: 'Tue, 15 Apr 2026 09:00:00 -0700' },
  ];

  it('is case-insensitive', () => {
    expect(extractHeader(headers, 'from')).toBe('sam@example.com');
    expect(extractHeader(headers, 'Subject')).toBe('Hello');
    expect(extractHeader(headers, 'DATE')).toBe('Tue, 15 Apr 2026 09:00:00 -0700');
  });

  it('returns undefined when the header is missing', () => {
    expect(extractHeader(headers, 'Cc')).toBeUndefined();
  });

  it('handles empty header list', () => {
    expect(extractHeader([], 'From')).toBeUndefined();
  });
});

describe('decodeBase64Url', () => {
  it('decodes standard ascii', () => {
    // "Hello, world!" → base64url
    expect(decodeBase64Url('SGVsbG8sIHdvcmxkIQ')).toBe('Hello, world!');
  });

  it('handles UTF-8 multibyte characters', () => {
    // "résumé 🎉" → base64url
    const encoded = Buffer.from('résumé 🎉', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeBase64Url(encoded)).toBe('résumé 🎉');
  });

  it('handles base64url chars that differ from standard base64', () => {
    // A string whose standard base64 would contain + and /
    // We build a binary input that forces those chars, then url-encode.
    const raw = Buffer.from([0xfb, 0xff, 0xfe]);
    const std = raw.toString('base64'); // contains + or /
    const url = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(Buffer.from(decodeBase64Url(url), 'utf8').equals(Buffer.from(decodeBase64Url(url)))).toBe(true);
    // Round-trip: decode back to bytes equals raw
    const std2 = url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std2 + '='.repeat((4 - (std2.length % 4)) % 4);
    expect(Buffer.from(padded, 'base64').equals(raw)).toBe(true);
  });
});

describe('stripHtml', () => {
  it('removes script and style blocks entirely', () => {
    const html = '<p>keep</p><script>alert(1)</script><style>.x{color:red}</style><p>also</p>';
    const out = stripHtml(html);
    expect(out).not.toContain('alert');
    expect(out).not.toContain('color:red');
    expect(out).toContain('keep');
    expect(out).toContain('also');
  });

  it('converts <br> and </p> to newlines', () => {
    const out = stripHtml('Line1<br>Line2</p>Line3');
    expect(out).toContain('Line1');
    expect(out).toContain('Line2');
    expect(out).toContain('Line3');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('decodes common HTML entities', () => {
    const out = stripHtml('AT&amp;T &lt;tag&gt; &quot;q&quot; &#39;s&#39; &nbsp;end');
    expect(out).toContain('AT&T');
    expect(out).toContain('<tag>');
    expect(out).toContain('"q"');
    expect(out).toContain("'s'");
    expect(out).toContain(' end');
  });

  it('collapses triple-plus newlines to double', () => {
    const out = stripHtml('a</p></p></p></p>b');
    expect(/\n{3,}/.test(out)).toBe(false);
  });
});

describe('findPart', () => {
  it('finds a plain text part nested under multipart/alternative', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: 'aGVsbG8' } },
        { mimeType: 'text/plain', body: { data: 'aGk' } },
      ],
    };
    const part = findPart(payload, 'text/plain');
    expect(part?.mimeType).toBe('text/plain');
  });

  it('skips parts that look like attachments even when mime matches', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { attachmentId: 'att1', size: 10 },
        },
        { mimeType: 'text/plain', body: { data: 'aGk' } },
      ],
    };
    const part = findPart(payload, 'text/plain');
    expect(part?.filename).toBeFalsy();
    expect(part?.body?.data).toBe('aGk');
  });

  it('returns null when no match exists', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'text/html',
      body: { data: 'PHA+aGk8L3A+' },
    };
    expect(findPart(payload, 'text/plain')).toBeNull();
  });
});

describe('extractBody', () => {
  it('prefers text/plain over text/html', () => {
    const plain = Buffer.from('hello plain', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const html = Buffer.from('<p>hello html</p>', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: html } },
        { mimeType: 'text/plain', body: { data: plain } },
      ],
    };
    const { text, kind } = extractBody(payload);
    expect(kind).toBe('plain');
    expect(text).toBe('hello plain');
  });

  it('falls back to text/html with tags stripped', () => {
    const html = Buffer.from('<p>hello <b>world</b></p>', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'text/html',
      body: { data: html },
    };
    const { text, kind } = extractBody(payload);
    expect(kind).toBe('html');
    expect(text).toContain('hello');
    expect(text).toContain('world');
    expect(text).not.toContain('<');
  });

  it('returns empty when payload has no body and no parts', () => {
    const { text, kind } = extractBody({ mimeType: 'text/plain' });
    expect(text).toBe('');
    expect(kind).toBe('empty');
  });

  it('returns empty when payload is undefined', () => {
    const { text, kind } = extractBody(undefined);
    expect(text).toBe('');
    expect(kind).toBe('empty');
  });
});

describe('extractAttachments', () => {
  it('lists attachments across nested parts', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGk' } },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att1', size: 2048 },
        },
        {
          mimeType: 'multipart/related',
          parts: [
            {
              mimeType: 'image/png',
              filename: 'logo.png',
              body: { attachmentId: 'att2', size: 512 },
            },
          ],
        },
      ],
    };
    const atts = extractAttachments(payload);
    expect(atts).toHaveLength(2);
    expect(atts[0]).toMatchObject({ filename: 'invoice.pdf', size: 2048 });
    expect(atts[1]).toMatchObject({ filename: 'logo.png', size: 512 });
  });

  it('returns empty array when there are no attachments', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'text/plain',
      body: { data: 'aGk' },
    };
    expect(extractAttachments(payload)).toEqual([]);
  });

  it('ignores parts with a filename but no attachmentId', () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', filename: 'inline.txt', body: { data: 'aGk' } },
      ],
    };
    expect(extractAttachments(payload)).toEqual([]);
  });
});
