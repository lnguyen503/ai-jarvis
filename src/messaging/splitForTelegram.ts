/**
 * Split a long markdown reply into Telegram-safe chunks (v1.22.40).
 *
 * Telegram's sendMessage hard cap is 4096 chars on the rendered message.
 * markdownToTelegramHtml expands tag-bearing text (`**bold**` → `<b>bold</b>`,
 * escapes `<` to `&lt;`, etc.), so the raw markdown limit is conservatively
 * lower — DEFAULT_RAW_CAP=3500 leaves ~600 chars of headroom for HTML expansion
 * even on text with heavy entity-escaping or many bold/italic spans.
 *
 * Splitting strategy (each step preserves more semantic structure than the
 * next):
 *   1. Paragraph boundaries (`\n\n`) — preferred, never breaks mid-thought.
 *   2. Single newlines — fallback when one paragraph is itself oversized.
 *   3. Sentence ends (`. `, `! `, `? `) — fallback for one massive paragraph.
 *   4. Hard slice — last resort when one sentence exceeds the cap.
 *
 * Why a single function and not chunked send: keeping the splitter pure makes
 * it easy to unit-test and reuse for any post-LLM text that might exceed cap
 * (debate-revised drafts being the v1.22.40 trigger).
 */

export const DEFAULT_RAW_CAP = 3500;

/**
 * Split `text` into pieces, each ≤ `cap` chars in raw form. The pieces
 * concatenated with `\n\n` re-join into the original text (modulo trimming of
 * trailing whitespace per chunk). For text already under `cap`, returns
 * `[text]`.
 */
export function splitForTelegram(text: string, cap: number = DEFAULT_RAW_CAP): string[] {
  if (text.length <= cap) return [text];

  const chunks: string[] = [];
  // Paragraph-first splitting. Walk paragraphs and pack them greedily into
  // chunks until the next paragraph wouldn't fit.
  const paragraphs = text.split(/\n{2,}/);
  let buf = '';
  for (const para of paragraphs) {
    const candidate = buf.length === 0 ? para : `${buf}\n\n${para}`;
    if (candidate.length <= cap) {
      buf = candidate;
      continue;
    }
    // Flush current buf if it has anything.
    if (buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
    // The single paragraph might still exceed cap — split further.
    if (para.length <= cap) {
      buf = para;
    } else {
      for (const piece of splitOneParagraph(para, cap)) {
        if (buf.length === 0) {
          buf = piece;
        } else if (`${buf}\n${piece}`.length <= cap) {
          buf = `${buf}\n${piece}`;
        } else {
          chunks.push(buf);
          buf = piece;
        }
      }
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

/** Split one over-cap paragraph into ≤cap pieces, preferring sentence ends. */
function splitOneParagraph(para: string, cap: number): string[] {
  const lines = para.split('\n');
  if (lines.length > 1 && lines.every((l) => l.length <= cap)) {
    // Re-pack lines greedily.
    const out: string[] = [];
    let buf = '';
    for (const line of lines) {
      const next = buf.length === 0 ? line : `${buf}\n${line}`;
      if (next.length <= cap) {
        buf = next;
      } else {
        if (buf.length > 0) out.push(buf);
        buf = line;
      }
    }
    if (buf.length > 0) out.push(buf);
    return out;
  }

  // No usable line breaks — fall back to sentence ends.
  const sentenceParts = para.split(/(?<=[.!?])\s+/);
  if (sentenceParts.length > 1 && sentenceParts.every((s) => s.length <= cap)) {
    const out: string[] = [];
    let buf = '';
    for (const s of sentenceParts) {
      const next = buf.length === 0 ? s : `${buf} ${s}`;
      if (next.length <= cap) {
        buf = next;
      } else {
        if (buf.length > 0) out.push(buf);
        buf = s;
      }
    }
    if (buf.length > 0) out.push(buf);
    return out;
  }

  // Last resort — hard slice.
  const out: string[] = [];
  for (let i = 0; i < para.length; i += cap) {
    out.push(para.slice(i, i + cap));
  }
  return out;
}
