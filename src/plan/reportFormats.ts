/**
 * Multi-format report writers (v1.8.4).
 *
 * The synthesizer produces REPORT.md (markdown). Telegram mobile clients
 * don't render .md files — tapping one shows raw `**bold**` text. To make
 * the report actually readable on a phone, we also generate:
 *
 *   - REPORT.txt   — plain-text, formatting stripped. Universally readable
 *                    by any text viewer. Useful for Telegram's in-app
 *                    "Open" path that just shows file contents.
 *   - REPORT.docx  — Word document. Renders with proper headings, bold,
 *                    bullets in Word / Pages / Google Docs / the iOS Files
 *                    app preview. The most "looks like a finished document"
 *                    option for non-technical readers.
 *
 * Conversion is intentionally simple — line-by-line markdown recognition
 * for the subset the LLM produces (H1-H3 headings, bold/italic, code,
 * bullets, links, blockquotes). It is NOT a full markdown parser. Edge
 * cases like nested formatting or tables get a reasonable best-effort
 * pass; the .md original is always available as the source of truth.
 */

import { writeFile } from 'node:fs/promises';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx';

// ---------------------------------------------------------------------------
// markdownToPlainText — strips markdown formatting characters
// ---------------------------------------------------------------------------

/**
 * Convert markdown to plain text by stripping formatting characters.
 * Output is suitable for any text viewer; preserves paragraph structure
 * and bullet markers but removes `**`, `_`, `` ` ``, `#`, `[](url)` syntax.
 */
export function markdownToPlainText(md: string): string {
  if (!md) return '';

  let out = md;

  // Fenced code blocks: keep the contents, drop the fences.
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => String(code).replace(/\n$/, ''));

  // Headings: drop the leading #s but preserve the title text. Add a
  // trailing newline for spacing so headings stand out from prose.
  out = out.replace(/^#{1,6}\s+(.+)$/gm, (_m, title) => `${String(title).trim()}\n`);

  // Bold / italic markers — remove the syntax, keep the content.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/__([^_\n]+)__/g, '$1');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2');

  // Strikethrough.
  out = out.replace(/~~([^~\n]+)~~/g, '$1');

  // Inline code: drop the backticks, keep the code content.
  out = out.replace(/`([^`\n]+)`/g, '$1');

  // Links: [label](url) → "label (url)" so the URL is still readable.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');

  // Blockquote markers: "> " at line start → "| " for visual indent
  // without confusing the user about whether they're reading a quote.
  // (Plain "| " marker so the trailing trim() doesn't eat any leading
  // whitespace we'd otherwise add.)
  out = out.replace(/^>\s?/gm, '| ');

  // Horizontal rules: --- or *** lines → a divider.
  out = out.replace(/^[-*_]{3,}\s*$/gm, '----');

  // Collapse 3+ consecutive blank lines to 2 (markdown often has these).
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim() + '\n';
}

// ---------------------------------------------------------------------------
// markdownToDocx — line-by-line conversion to a Word document
// ---------------------------------------------------------------------------

interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * Parse a single line of markdown into styled inline segments.
 * Recognizes **bold**, *bold*, _italic_, `code`, and [text](url) → "text (url)".
 * Greedy matching from the outermost markers; a small DSL but fine for
 * well-formed LLM output.
 */
function parseInline(text: string): InlineSegment[] {
  // Pre-pass: links → "text (url)" so the URL survives as readable text.
  const linked = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');

  const segments: InlineSegment[] = [];
  let buf = '';
  let i = 0;

  // Helper to flush the plain buffer as a segment.
  const flushPlain = (): void => {
    if (buf.length > 0) {
      segments.push({ text: buf });
      buf = '';
    }
  };

  while (i < linked.length) {
    const rest = linked.slice(i);

    // **bold** (must come before single *)
    let m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      flushPlain();
      segments.push({ text: m[1]!, bold: true });
      i += m[0].length;
      continue;
    }

    // __bold__
    m = /^__([^_]+)__/.exec(rest);
    if (m) {
      flushPlain();
      segments.push({ text: m[1]!, bold: true });
      i += m[0].length;
      continue;
    }

    // *bold* (single asterisk — Telegram convention treats as bold)
    m = /^\*([^*\n]+)\*/.exec(rest);
    if (m) {
      flushPlain();
      segments.push({ text: m[1]!, bold: true });
      i += m[0].length;
      continue;
    }

    // _italic_
    m = /^_([^_\n]+)_/.exec(rest);
    if (m) {
      flushPlain();
      segments.push({ text: m[1]!, italic: true });
      i += m[0].length;
      continue;
    }

    // `code`
    m = /^`([^`\n]+)`/.exec(rest);
    if (m) {
      flushPlain();
      segments.push({ text: m[1]!, code: true });
      i += m[0].length;
      continue;
    }

    buf += linked[i];
    i++;
  }
  flushPlain();
  return segments.length > 0 ? segments : [{ text: '' }];
}

function inlineToRuns(segments: InlineSegment[]): TextRun[] {
  return segments.map(
    (s) =>
      new TextRun({
        text: s.text,
        bold: s.bold,
        italics: s.italic,
        font: s.code ? { name: 'Consolas' } : undefined,
        color: s.code ? '880000' : undefined,
      }),
  );
}

/**
 * Convert markdown text into a .docx Buffer ready to write to disk.
 * Recognized constructs:
 *   - # Heading 1 / ## Heading 2 / ### Heading 3
 *   - Bullet lists (- item / * item)
 *   - Numbered lists (1. item)
 *   - Fenced code blocks (```)
 *   - Blockquotes (> line)
 *   - Horizontal rules (---)
 *   - Inline: **bold** / *bold* / _italic_ / `code` / [link](url)
 *   - Plain paragraphs separated by blank lines
 */
export async function markdownToDocxBuffer(md: string): Promise<Buffer> {
  const lines = md.split(/\r?\n/);
  const children: Paragraph[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block — collect until the closing fence.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      i++; // skip closing fence
      // Each code line as its own monospace paragraph.
      for (const codeLine of codeLines) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: codeLine || ' ',
                font: { name: 'Consolas' },
                color: '333333',
              }),
            ],
          }),
        );
      }
      continue;
    }

    // Headings.
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: inlineToRuns(parseInline(h1[1]!)),
        }),
      );
      i++;
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: inlineToRuns(parseInline(h2[1]!)),
        }),
      );
      i++;
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: inlineToRuns(parseInline(h3[1]!)),
        }),
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^[-*_]{3,}\s*$/.test(line)) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: '— · — · —', color: '999999' })],
        }),
      );
      i++;
      continue;
    }

    // Blockquote.
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      children.push(
        new Paragraph({
          indent: { left: 720 }, // 0.5 inch in twips
          children: [
            new TextRun({ text: '“ ', italics: true, color: '666666' }),
            ...inlineToRuns(parseInline(quote[1] ?? '')).map((r) => {
              // Force italics on quote text.
              return new TextRun({
                text: (r as unknown as { text?: string }).text ?? '',
                italics: true,
                color: '444444',
              });
            }),
          ],
        }),
      );
      i++;
      continue;
    }

    // Unordered list.
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: inlineToRuns(parseInline(bullet[1]!)),
        }),
      );
      i++;
      continue;
    }

    // Ordered list — docx renders numbering automatically when `numbering`
    // is wired, but for simplicity we keep the user-supplied "1. " prefix.
    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (numbered) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: inlineToRuns(parseInline(numbered[1]!)),
        }),
      );
      i++;
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim().length === 0) {
      children.push(new Paragraph({}));
      i++;
      continue;
    }

    // Plain paragraph.
    children.push(
      new Paragraph({
        children: inlineToRuns(parseInline(line)),
      }),
    );
    i++;
  }

  const doc = new Document({
    creator: 'Jarvis',
    title: 'Research Report',
    description: 'Multi-model synthesized research report',
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}

/** Write all three report formats to disk alongside the source REPORT.md. */
export async function writeAllReportFormats(
  reportMdPath: string,
  markdownContent: string,
): Promise<{ md: string; txt: string; docx: string }> {
  const txtPath = reportMdPath.replace(/\.md$/i, '.txt');
  const docxPath = reportMdPath.replace(/\.md$/i, '.docx');

  await writeFile(txtPath, markdownToPlainText(markdownContent), 'utf8');
  const docxBuffer = await markdownToDocxBuffer(markdownContent);
  await writeFile(docxPath, docxBuffer);

  return { md: reportMdPath, txt: txtPath, docx: docxPath };
}
