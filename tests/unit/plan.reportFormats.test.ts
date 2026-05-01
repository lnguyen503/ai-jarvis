import { describe, expect, it } from 'vitest';
import { markdownToPlainText, markdownToDocxBuffer } from '../../src/plan/reportFormats.js';

describe('markdownToPlainText', () => {
  it('strips bold/italic/code markers', () => {
    const out = markdownToPlainText('**bold** _italic_ `code`');
    expect(out.trim()).toBe('bold italic code');
  });

  it('drops heading hashes but keeps the title', () => {
    const out = markdownToPlainText('# Title\n\n## Sub\n\nbody');
    expect(out).toContain('Title');
    expect(out).toContain('Sub');
    expect(out).toContain('body');
    expect(out).not.toMatch(/^#/m);
  });

  it('keeps fenced code block contents without the fences', () => {
    const out = markdownToPlainText('```js\nconst x = 1;\n```');
    expect(out).toContain('const x = 1;');
    expect(out).not.toContain('```');
  });

  it('renders links as "label (url)"', () => {
    const out = markdownToPlainText('see [docs](https://example.com)');
    expect(out.trim()).toBe('see docs (https://example.com)');
  });

  it('renders blockquote with a "| " marker', () => {
    const out = markdownToPlainText('> a quote');
    expect(out).toContain('| a quote');
  });

  it('returns empty string on empty input', () => {
    expect(markdownToPlainText('')).toBe('');
  });

  it('renders horizontal rules as ----', () => {
    const out = markdownToPlainText('above\n\n---\n\nbelow');
    expect(out).toContain('----');
  });
});

describe('markdownToDocxBuffer', () => {
  it('produces a non-empty docx buffer for a realistic report', async () => {
    const md = `# Research Report: EV Charging in Indianapolis

## Market Size

The Indianapolis EV market grew **12%** YoY in 2025. Key data points:

- 4,200 registered EVs
- 38 public chargers as of Q3
- $2.1M in state subsidies disbursed

## Competitors

ChargePoint dominates with _58%_ share. See [their docs](https://chargepoint.com).

\`\`\`
2025 Q1: 31 chargers
2025 Q2: 35 chargers
2025 Q3: 38 chargers
\`\`\`

> "Adoption is accelerating," — Indy Star, 2025-09-12.

## Open Questions

1. What's the 2026 budget allocation?
2. Will Tesla open the Supercharger network?

---

End of report.
`;
    const buf = await markdownToDocxBuffer(md);
    // .docx files are ZIP-format containers — magic bytes "PK\x03\x04"
    expect(buf.byteLength).toBeGreaterThan(2000);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
  });

  it('handles empty markdown without throwing', async () => {
    const buf = await markdownToDocxBuffer('');
    expect(buf.byteLength).toBeGreaterThan(1000); // empty doc still has scaffolding
  });

  it('handles markdown with only headings', async () => {
    const buf = await markdownToDocxBuffer('# Just a Title\n## And a Subtitle');
    expect(buf.byteLength).toBeGreaterThan(1500);
  });
});
