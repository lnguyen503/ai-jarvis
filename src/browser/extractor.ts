/**
 * HTML → readable-text extractor.
 *
 * Uses Mozilla's Readability (the algo behind Firefox Reader View) on top of
 * jsdom. Readability is tuned for article pages and produces clean body text
 * with nav/footer/ads stripped. It returns null for pages that don't look
 * like articles — landing pages, search results, SPAs — in which case we
 * fall back to body.innerText.
 *
 * Output is capped at `maxChars` so one massive page can't blow the
 * agent's context window.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export interface ExtractedPage {
  title: string;
  excerpt: string;
  text: string;
  wordCount: number;
  siteName?: string;
  /** Which extraction path won: Readability's article pass, or raw body fallback. */
  kind: 'readability' | 'fallback';
  /** Whether the extracted text was truncated at `maxChars`. */
  truncated: boolean;
}

export interface ExtractorOptions {
  /** Source URL — Readability uses it to resolve relative links. */
  url: string;
  /** Max characters of `text` we'll return. Extra is dropped. */
  maxChars: number;
}

/**
 * Extract readable text from a page's HTML.
 *
 * Errors are caught — jsdom and Readability can throw on malformed input;
 * we surface a best-effort fallback rather than crash the tool.
 */
export function extractReadable(html: string, opts: ExtractorOptions): ExtractedPage {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url: opts.url });
  } catch {
    return emptyResult('fallback');
  }

  // Try Readability first.
  try {
    const doc = dom.window.document;
    // Readability mutates the document, so clone the node first if we wanted
    // a fallback later. Here we only read once per call; mutation is fine.
    const article = new Readability(doc).parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      const text = normalize(article.textContent);
      const capped = cap(text, opts.maxChars);
      return {
        title: (article.title ?? '').trim() || untitled(dom),
        excerpt: (article.excerpt ?? '').trim().slice(0, 300),
        text: capped.text,
        wordCount: countWords(capped.text),
        siteName: (article.siteName ?? '').trim() || undefined,
        kind: 'readability',
        truncated: capped.truncated,
      };
    }
  } catch {
    // fall through to the body fallback
  }

  // Fallback: strip scripts/styles, take body.textContent.
  try {
    const body = dom.window.document.body;
    if (body) {
      for (const el of Array.from(body.querySelectorAll('script, style, noscript'))) {
        el.remove();
      }
      const raw = body.textContent ?? '';
      const text = normalize(raw);
      const capped = cap(text, opts.maxChars);
      return {
        title: untitled(dom),
        excerpt: capped.text.slice(0, 300),
        text: capped.text,
        wordCount: countWords(capped.text),
        kind: 'fallback',
        truncated: capped.truncated,
      };
    }
  } catch {
    // fall through
  }

  return emptyResult('fallback');
}

function untitled(dom: JSDOM): string {
  const t = dom.window.document.title?.trim();
  return t && t.length > 0 ? t : '(untitled)';
}

function emptyResult(kind: 'readability' | 'fallback'): ExtractedPage {
  return {
    title: '(untitled)',
    excerpt: '',
    text: '',
    wordCount: 0,
    kind,
    truncated: false,
  };
}

/**
 * Collapse pathological whitespace: multiple newlines → double, multiple
 * spaces → single, trim. Readable-text pages do this naturally; fallback
 * extraction needs it because DOM traversal preserves every character of
 * original formatting.
 */
export function normalize(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function countWords(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function cap(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars).replace(/\s+\S*$/, '') + '… [truncated]',
    truncated: true,
  };
}
