/**
 * Tests for src/browser/extractor.ts — readability happy path, SPA fallback,
 * normalization, cap enforcement. No browser or network involved.
 */
import { describe, it, expect } from 'vitest';
import { extractReadable, normalize, countWords } from '../../src/browser/extractor.js';

const URL = 'https://example.com/article';

describe('extractReadable', () => {
  it('extracts article body via Readability on a normal article page', () => {
    const html = `
      <!doctype html>
      <html><head><title>Claude 4.7 announced</title></head>
      <body>
        <nav>Home · Pricing · Login</nav>
        <article>
          <h1>Claude 4.7 announced</h1>
          <p>Anthropic announced Claude 4.7 today, featuring improvements
             across coding and reasoning. The new model is available today.</p>
          <p>It replaces Claude 4.6 and maintains the same pricing structure.</p>
        </article>
        <footer>© 2026 Anthropic</footer>
      </body></html>
    `;
    const r = extractReadable(html, { url: URL, maxChars: 10_000 });
    expect(r.kind).toBe('readability');
    expect(r.title).toContain('Claude 4.7');
    expect(r.text).toContain('announced Claude 4.7');
    expect(r.text).toContain('replaces Claude 4.6');
    expect(r.text).not.toContain('Home · Pricing · Login');
    expect(r.wordCount).toBeGreaterThan(10);
    expect(r.truncated).toBe(false);
  });

  it('falls back to body text when Readability returns null (landing page)', () => {
    const html = `
      <!doctype html>
      <html><head><title>Home</title></head>
      <body>
        <div>Widget A</div>
        <div>Widget B</div>
        <script>console.log('x')</script>
        <style>.x { color: red; }</style>
      </body></html>
    `;
    const r = extractReadable(html, { url: URL, maxChars: 10_000 });
    // Either path is acceptable here — both strip scripts/styles.
    expect(['readability', 'fallback']).toContain(r.kind);
    expect(r.text).toContain('Widget A');
    expect(r.text).toContain('Widget B');
    expect(r.text).not.toContain('console.log');
    expect(r.text).not.toContain('color: red');
  });

  it('truncates extracted text at maxChars', () => {
    const longArticle = '<article><h1>Long</h1>' +
      '<p>' + 'word '.repeat(5000) + '</p></article>';
    const html = `<!doctype html><html><body>${longArticle}</body></html>`;
    const r = extractReadable(html, { url: URL, maxChars: 500 });
    expect(r.text.length).toBeLessThanOrEqual(500 + 20); // +slack for "… [truncated]"
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[truncated]');
  });

  it('handles empty body gracefully', () => {
    const html = `<!doctype html><html><head><title>Empty</title></head><body></body></html>`;
    const r = extractReadable(html, { url: URL, maxChars: 1000 });
    expect(r.wordCount).toBe(0);
  });

  it('handles completely malformed HTML without throwing', () => {
    // jsdom is tolerant but pathological strings sometimes throw internally.
    const r = extractReadable('<not-html >>> totally busted', {
      url: URL,
      maxChars: 1000,
    });
    expect(r).toBeTruthy();
    expect(['readability', 'fallback']).toContain(r.kind);
  });

  it('fills excerpt from Readability when available', () => {
    const html = `
      <!doctype html>
      <html><head><title>Test</title></head><body>
        <article>
          <h1>Test Article</h1>
          <p>This is the first paragraph which Readability picks as the excerpt. It's long enough to be meaningful.</p>
          <p>Another paragraph follows.</p>
          <p>And a third paragraph for good measure.</p>
        </article>
      </body></html>
    `;
    const r = extractReadable(html, { url: URL, maxChars: 10_000 });
    expect(r.excerpt.length).toBeGreaterThan(0);
  });
});

describe('normalize', () => {
  it('collapses runs of spaces', () => {
    expect(normalize('a    b')).toBe('a b');
  });
  it('collapses 3+ newlines to double', () => {
    expect(normalize('a\n\n\n\nb')).toBe('a\n\nb');
  });
  it('normalizes CRLF', () => {
    expect(normalize('a\r\nb')).toBe('a\nb');
  });
  it('trims leading/trailing whitespace', () => {
    expect(normalize('  hello  \n  ')).toBe('hello');
  });
});

describe('countWords', () => {
  it('counts words separated by whitespace', () => {
    expect(countWords('one two three')).toBe(3);
  });
  it('handles multiple whitespace', () => {
    expect(countWords('one   two\nthree')).toBe(3);
  });
  it('zero for empty', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});
