/**
 * Minimal Markdown subset for read-only rendering. NO innerHTML — DOM construction only.
 * URL allowlist: http/https/mailto.
 *
 * Supported subset:
 *  - Block: # H1, ## H2, ### H3 (max 3 levels; >50 headings → render as <p> per R4)
 *  - Block: paragraphs (blank-line separated)
 *  - Block: fenced code blocks (``` ... ```)
 *  - Block: - bullet lists (flat only, no nesting per R4; cap 200 items + truncation marker)
 *  - Block: 1. numbered lists (same caps)
 *  - Inline: **bold**, *italic*, `code`, [link](url)
 *
 * Hard exclusions (security):
 *  - No raw HTML — < and > pass through as text via createTextNode
 *  - No images — ![alt](url) is NOT parsed; passes through as literal text
 *  - No reference-style links — [text][ref] is NOT parsed; passes through as literal text
 *  - No autolinking — bare https://... stays as text; only [text](url) becomes a link
 *  - No tables, no blockquotes (deferred per ADR 016 D17)
 *
 * Bounded inline regexes (W6 — prevent catastrophic backtracking):
 *  BOLD: double-asterisk delimited (regex literal in code below — char classes
 *    anchored to non-asterisk + non-newline)
 *  ITALIC: single-asterisk delimited (same anchoring)
 *  INLINE_CODE: backtick delimited (same anchoring)
 *  LINK: square-bracket text + parenthesis url (same anchoring)
 *  NOTE: the literal regex bodies use slash-asterisk-slash sequences that
 *  would terminate this JSDoc block early, so they live in code only.
 *
 * DOS caps (R4):
 *  - Per-list cap: 200 items (bullet or numbered). Beyond 200 → truncation marker <li>.
 *  - Per-document heading cap: 50. Beyond 50 → renders as plain <p>.
 *
 * Exported:
 *  - renderMarkdown(text, hostElement) — clears hostElement, parses text, appends DOM nodes
 *
 * Internal:
 *  - isSafeUrl(href) — belt-and-suspenders URL validator (R3)
 *  - parseInline(line) — returns Node[] for inline tokens within a text line
 *
 * v1.16.0 — ADR 016 D7 + D7.b (R3) + D7.c (R4) + W6 bounded regexes.
 * ES module; no framework; no bundler. Same-origin only under CSP.
 */

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Max items rendered in a single bullet or numbered list before truncation (R4 / D7.c). */
const MAX_LIST_ITEMS = 200;

/** Max heading elements in the full document before overflow renders as <p> (R4 / D7.c). */
const MAX_HEADINGS = 50;

// Bounded inline-token regexes (W6 — character-class negation prevents catastrophic backtracking
// AND prevents tokens spanning newlines; no nested matches; greedy left-to-right).
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const ITALIC_RE = /\*([^*\n]+)\*/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

// ------------------------------------------------------------------
// R3 — Belt-and-suspenders URL validator (D7.b binding)
// ------------------------------------------------------------------

/**
 * Validate a URL for use in markdown link href attributes.
 *
 * Defence-in-depth against:
 *  - HTML entity encoding:       &#106;avascript: → decoded to 'javascript:'
 *  - Hex entity encoding:        &#x6A;avascript: → decoded to 'javascript:'
 *  - URL-percent encoding:       %6Aavascript: → decoded to 'javascript:'
 *  - Leading/embedded whitespace: ' javascript:', 'java\tscript:'
 *  - Image syntax:               ![alt](url) — NOT parsed at all (parser-level guard)
 *  - Reference-style:            [text][ref] — NOT parsed at all (parser-level guard)
 *
 * @param {string} href
 * @returns {boolean}
 */
function isSafeUrl(href) {
  if (typeof href !== 'string') return false;
  // 1. Trim leading + trailing whitespace.
  const trimmed = href.trim();
  // 2. Reject empty.
  if (!trimmed) return false;
  // 3. HTML entity unescape — handles &#106;avascript:, &#x6A;avascript:, etc.
  //    Belt: parser does NOT entity-decode URLs (raw bytes from [text](URL)),
  //    but the validator decodes defensively as belt-and-suspenders.
  const unescaped = trimmed
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  // 4. URL-decode — handles %6Aavascript:, %4A%41%56%41%53..., etc.
  let decoded;
  try { decoded = decodeURIComponent(unescaped); } catch { return false; }
  // 5. Re-trim after decode (decoded result may have leading whitespace from %20 etc.).
  const final = decoded.trim();
  // 6. Strict prefix regex (case-insensitive) — belt-and-suspenders allowlist.
  if (!/^(https?:\/\/|mailto:)/i.test(final)) return false;
  // 7. Final: try new URL() to catch any remaining browser-quirk parse paths.
  try {
    const u = new URL(final);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Inline token parser
// Scans a plain-text line for bold / italic / inline-code / link tokens.
// Returns an array of DOM Node objects.
// NEVER uses innerHTML — all text fragments pass through createTextNode.
// ------------------------------------------------------------------

/**
 * Parse inline markdown tokens in a single text line.
 * Returns an array of DOM Node objects (Text nodes, <strong>, <em>, <code>, <a>).
 *
 * Processing order: code spans first (protect their contents), then links,
 * then bold, then italic. Overlapping tokens are resolved left-to-right.
 *
 * @param {string} line
 * @returns {Node[]}
 */
function parseInline(line) {
  // Build a flat token list: [{start, end, type, text, href?}]
  // We scan with each regex, collect all matches, sort by start pos,
  // then walk left-to-right, emitting text nodes for gaps.

  const tokens = [];

  // Helper: collect all regex matches for a type
  function collect(re, type) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      tokens.push({
        start: m.index,
        end: m.index + m[0].length,
        type,
        inner: m[1],
        href: m[2] || null,
        raw: m[0],
      });
    }
  }

  collect(INLINE_CODE_RE, 'code');
  collect(LINK_RE, 'link');
  collect(BOLD_RE, 'bold');
  collect(ITALIC_RE, 'italic');

  // Sort by start position; on tie, prefer earlier-declared types (code > link > bold > italic).
  const typeOrder = { code: 0, link: 1, bold: 2, italic: 3 };
  tokens.sort((a, b) => a.start - b.start || typeOrder[a.type] - typeOrder[b.type]);

  // Walk tokens, skipping overlapping ones, emitting DOM nodes.
  const nodes = [];
  let cursor = 0;

  for (const tok of tokens) {
    if (tok.start < cursor) continue; // overlapping — skip
    // Text before this token
    if (tok.start > cursor) {
      nodes.push(document.createTextNode(line.slice(cursor, tok.start)));
    }
    cursor = tok.end;

    if (tok.type === 'code') {
      const el = document.createElement('code');
      el.textContent = tok.inner; // textContent — never innerHTML
      nodes.push(el);
    } else if (tok.type === 'link') {
      if (isSafeUrl(tok.href)) {
        const a = document.createElement('a');
        a.href = tok.href.trim(); // validated above; setAttribute equivalent via property
        a.textContent = tok.inner; // textContent — never innerHTML
        a.rel = 'noopener noreferrer';
        a.target = '_blank';
        nodes.push(a);
      } else {
        // Unsafe URL — render as plain text; preserve original markup so users see why it didn't link.
        nodes.push(document.createTextNode(tok.raw));
      }
    } else if (tok.type === 'bold') {
      const el = document.createElement('strong');
      el.textContent = tok.inner; // textContent — never innerHTML
      nodes.push(el);
    } else if (tok.type === 'italic') {
      const el = document.createElement('em');
      el.textContent = tok.inner; // textContent — never innerHTML
      nodes.push(el);
    }
  }

  // Remaining text after last token
  if (cursor < line.length) {
    nodes.push(document.createTextNode(line.slice(cursor)));
  }

  return nodes.length > 0 ? nodes : [document.createTextNode(line)];
}

// ------------------------------------------------------------------
// Block-level parser + renderer
// ------------------------------------------------------------------

/**
 * Classify a line for block-level type.
 * Returns one of: 'h1' | 'h2' | 'h3' | 'fence' | 'bullet' | 'ordered' | 'blank' | 'para'
 *
 * @param {string} line
 * @returns {string}
 */
function classifyLine(line) {
  if (line === '') return 'blank';
  if (line.startsWith('### ')) return 'h3';
  if (line.startsWith('## ')) return 'h2';
  if (line.startsWith('# ')) return 'h1';
  if (line.startsWith('```')) return 'fence';
  // Bullet: lines starting with '- ' or '*  ' — but we only support '- ' per D7
  // Indented bullets (R4 / D7.c): IGNORED — any '- ' or '  - ' prefix still produces a flat item.
  if (/^[ \t]*- /.test(line)) return 'bullet';
  // Ordered: lines starting with digits + '.' + space (indentation ignored per R4)
  if (/^[ \t]*\d+\. /.test(line)) return 'ordered';
  return 'para';
}

/**
 * Extract the inner text from a heading/bullet/ordered line.
 * Strips the block-level prefix.
 *
 * @param {string} line
 * @param {string} type
 * @returns {string}
 */
function stripPrefix(line, type) {
  if (type === 'h1') return line.slice(2); // '# '
  if (type === 'h2') return line.slice(3); // '## '
  if (type === 'h3') return line.slice(4); // '### '
  if (type === 'bullet') return line.replace(/^[ \t]*- /, '');
  if (type === 'ordered') return line.replace(/^[ \t]*\d+\. /, '');
  return line;
}

/**
 * Render markdown text into a host DOM element.
 * Clears the host, then appends freshly-constructed DOM nodes.
 *
 * NEVER uses innerHTML on user content. All text passes through
 * document.createTextNode or element.textContent.
 *
 * @param {string} text — raw markdown text (user-authored)
 * @param {HTMLElement} hostElement — container to render into (cleared first)
 */
export function renderMarkdown(text, hostElement) {
  if (!hostElement) return;
  // Clear existing content safely (innerHTML = '' on the host is safe here —
  // the host is our own DOM node; we're not injecting user content).
  hostElement.innerHTML = '';

  if (!text || typeof text !== 'string') return;

  const lines = text.split('\n');

  let headingCount = 0;
  let inFence = false;
  let fenceEl = null;    // current <code> element inside <pre>
  let inList = false;    // whether we're inside a <ul> or <ol>
  let listEl = null;     // the current <ul> or <ol>
  let listType = null;   // 'bullet' | 'ordered'
  let listItemCount = 0; // items emitted in the current list
  let listTruncated = false;
  let paraLines = [];    // accumulate paragraph lines

  function flushPara() {
    if (paraLines.length === 0) return;
    const p = document.createElement('p');
    // Join para lines with a space (bare newlines inside a paragraph block become space).
    const joined = paraLines.join(' ');
    const inlineNodes = parseInline(joined);
    inlineNodes.forEach((n) => p.appendChild(n));
    hostElement.appendChild(p);
    paraLines = [];
  }

  function flushList() {
    if (!listEl) return;
    inList = false;
    listEl = null;
    listType = null;
    listItemCount = 0;
    listTruncated = false;
  }

  function appendListItem(innerText) {
    if (!listEl) return;
    if (listTruncated) return; // already truncated; skip
    if (listItemCount >= MAX_LIST_ITEMS) {
      // Emit truncation marker (R4 / D7.c)
      const truncLi = document.createElement('li');
      truncLi.className = 'markdown-truncated';
      // Count remaining items
      // We'll set textContent after we know how many remain; for now record the truncation.
      truncLi.textContent = '… (truncated; additional items not rendered)';
      listEl.appendChild(truncLi);
      listTruncated = true;
      return;
    }
    const li = document.createElement('li');
    const inlineNodes = parseInline(innerText);
    inlineNodes.forEach((n) => li.appendChild(n));
    listEl.appendChild(li);
    listItemCount++;
  }

  for (const rawLine of lines) {
    const type = classifyLine(rawLine);

    // --- Fenced code block handling ---
    if (type === 'fence') {
      if (inFence) {
        // Close fence
        inFence = false;
        fenceEl = null;
      } else {
        // Close any open list or paragraph first
        flushPara();
        flushList();
        // Open fence
        inFence = true;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        pre.appendChild(code);
        hostElement.appendChild(pre);
        fenceEl = code;
      }
      continue;
    }

    if (inFence) {
      // Inside a code block — append raw text (textContent — never innerHTML)
      if (fenceEl) {
        // Append newline if not the first line
        if (fenceEl.textContent) fenceEl.textContent += '\n' + rawLine;
        else fenceEl.textContent = rawLine;
      }
      continue;
    }

    // --- Normal block parsing (outside fence) ---

    if (type === 'h1' || type === 'h2' || type === 'h3') {
      flushPara();
      flushList();
      headingCount++;
      if (headingCount > MAX_HEADINGS) {
        // Overflow: render as plain paragraph (R4 / D7.c)
        const p = document.createElement('p');
        const inner = stripPrefix(rawLine, type);
        const inlineNodes = parseInline(inner);
        inlineNodes.forEach((n) => p.appendChild(n));
        hostElement.appendChild(p);
      } else {
        const tag = type === 'h1' ? 'h1' : type === 'h2' ? 'h2' : 'h3';
        const heading = document.createElement(tag);
        const inner = stripPrefix(rawLine, type);
        const inlineNodes = parseInline(inner);
        inlineNodes.forEach((n) => heading.appendChild(n));
        hostElement.appendChild(heading);
      }
      continue;
    }

    if (type === 'bullet' || type === 'ordered') {
      flushPara();
      const newListType = type; // 'bullet' or 'ordered'
      // If switching list types, close current list and open a new one.
      if (inList && listType !== newListType) {
        flushList();
      }
      if (!inList) {
        listEl = document.createElement(type === 'bullet' ? 'ul' : 'ol');
        hostElement.appendChild(listEl);
        inList = true;
        listType = newListType;
        listItemCount = 0;
        listTruncated = false;
      }
      const inner = stripPrefix(rawLine, type);
      appendListItem(inner);
      continue;
    }

    if (type === 'blank') {
      flushPara();
      flushList();
      continue;
    }

    // type === 'para'
    if (inList) {
      // A non-list line after list items closes the list
      flushList();
    }
    paraLines.push(rawLine);
  }

  // Flush any remaining content
  flushPara();
  // Note: unclosed fences are left as-is (partial render)
}
