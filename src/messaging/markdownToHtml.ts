/**
 * Markdown → Telegram HTML conversion for agent reply text.
 *
 * The agent emits markdown (per system prompt). Telegram supports a small
 * HTML subset: <b> <i> <u> <s> <code> <pre> <a href> <blockquote>. Rendering
 * agent output as-markdown via parse_mode="Markdown" fails frequently because
 * Telegram's markdown parser is strict (unbalanced * trips it). HTML is more
 * forgiving — we escape what we don't recognize, map what we do.
 *
 * Conversion order matters: code blocks are extracted FIRST so their contents
 * aren't interpreted as bold/italic/etc. Inline code next. Then the remaining
 * text is HTML-escaped and markdown syntax is replaced with HTML tags. Finally
 * code placeholders are restored (with their contents HTML-escaped too).
 */

const PLACEHOLDER_BLOCK = '';
const PLACEHOLDER_INLINE = '';
const PLACEHOLDER_MENTION = '';

/** Escape the five HTML-significant characters for Telegram. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert a subset of markdown to Telegram HTML. Supports:
 *   **bold**, *bold*, __bold__   → <b>
 *   _italic_                      → <i>
 *   `code`                        → <code>
 *   ```fenced```                  → <pre>
 *   > quote (line-start)          → <blockquote>
 *   [text](url)                   → <a href="url">text</a>
 *   ~~strike~~                    → <s>
 *
 * Unrecognized markdown is left as-is (HTML-escaped so it renders as plain text).
 */
export function markdownToTelegramHtml(md: string): string {
  if (!md) return '';

  // 1. Extract fenced code blocks first so their contents stay intact.
  const blocks: string[] = [];
  let src = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(String(code).replace(/\n$/, ''));
    return `${PLACEHOLDER_BLOCK}${blocks.length - 1}${PLACEHOLDER_BLOCK}`;
  });

  // 2. Extract inline code.
  const inlines: string[] = [];
  src = src.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlines.push(String(code));
    return `${PLACEHOLDER_INLINE}${inlines.length - 1}${PLACEHOLDER_INLINE}`;
  });

  // 2b. v1.21.10 — extract @-mentions BEFORE markdown processing so that
  // underscore-bearing usernames (e.g. @your_tony_bot) don't get
  // misparsed as italic by the `_x_` → <i>x</i> rule. Without this,
  // `@your_tony_bot` becomes `@ai<i>Tony</i>Stark_bot` after
  // markdown conversion → Telegram strips the underscores → mention
  // entity fails → peer bot doesn't see itself addressed.
  // Pattern: @ followed by 1+ word chars; allows trailing _word repeats.
  const mentions: string[] = [];
  src = src.replace(/@\w[\w]*\b/g, (m) => {
    mentions.push(m);
    return `${PLACEHOLDER_MENTION}${mentions.length - 1}${PLACEHOLDER_MENTION}`;
  });

  // 3. HTML-escape everything that remains (prose between code markers).
  src = escapeHtml(src);

  // 4. Inline markdown → HTML. Order: links before bold/italic so markdown
  //    link text doesn't eat a stray underscore.
  src = src.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label, url) => `<a href="${String(url)}">${String(label)}</a>`,
  );
  // Strikethrough: ~~text~~
  src = src.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // Bold: **text** or __text__ (double underscores) — both → <b>.
  //   Single * can be italic in some dialects but we prefer _x_ for italic
  //   below and map single * to bold to match Telegram markdown habits.
  src = src.replace(/\*\*([^\n*][^*]*?)\*\*/g, '<b>$1</b>');
  src = src.replace(/__([^\n_][^_]*?)__/g, '<b>$1</b>');
  src = src.replace(/(^|[^*])\*([^\n*][^*]*?)\*(?!\*)/g, '$1<b>$2</b>');
  // Italic: _text_
  src = src.replace(/(^|[^_])_([^\n_][^_]*?)_(?!_)/g, '$1<i>$2</i>');
  // Blockquote: > at the start of a line. Merge consecutive > lines into one.
  src = src.replace(/(^|\n)((?:&gt; [^\n]*\n?)+)/g, (_m, lead, block) => {
    const stripped = String(block)
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/^&gt; ?/, ''))
      .join('\n');
    return `${lead}<blockquote>${stripped}</blockquote>`;
  });

  // 5. Restore code placeholders with HTML-escaped contents.
  src = src.replace(
    new RegExp(`${PLACEHOLDER_INLINE}(\\d+)${PLACEHOLDER_INLINE}`, 'g'),
    (_m, idx) => `<code>${escapeHtml(inlines[Number(idx)] ?? '')}</code>`,
  );
  src = src.replace(
    new RegExp(`${PLACEHOLDER_BLOCK}(\\d+)${PLACEHOLDER_BLOCK}`, 'g'),
    (_m, idx) => `<pre>${escapeHtml(blocks[Number(idx)] ?? '')}</pre>`,
  );

  // 5b. v1.21.10 — restore @-mention placeholders. The mentions were
  // captured pre-escape, so HTML-escape them now. We escape because a
  // hostile mention shouldn't be able to inject HTML.
  src = src.replace(
    new RegExp(`${PLACEHOLDER_MENTION}(\\d+)${PLACEHOLDER_MENTION}`, 'g'),
    (_m, idx) => escapeHtml(mentions[Number(idx)] ?? ''),
  );

  return src;
}
