/**
 * 3-way line-based diff (~120 LOC).
 *
 * Pure functions only — no DOM access in the algorithm.
 * DOM rendering is in renderDiffPanel (separate function below).
 *
 * W3 trailing-whitespace tolerance: linesEqual() trims trailing whitespace before
 * comparing (matches Git's default-ish behaviour; users routinely have trailing-space
 * drift in textareas). Leading whitespace, case, and Unicode normalization are
 * preserved — byte-exact otherwise.
 *
 * R4 / P6 cap: MAX_DIFF_LINES = 200. Above the cap, diff3() falls back to
 * { chunks: null, fallback: true } — the caller should show the 2-button conflict UI.
 *
 * Exports:
 *  - splitLines(text) — split on newlines; preserve empty lines
 *  - linesEqual(a, b) — byte-exact after trim of trailing whitespace (W3)
 *  - diff3(original, user, server) — 3-way diff; returns { chunks, summary } or { fallback: true }
 *  - renderDiffPanel(diff, callbacks) — renders diff into a DOM <section>
 *
 * v1.16.0 — ADR 016 D8 + W3 line-equality predicate.
 * ES module; no framework; no bundler.
 */

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Above this many lines (in any of the three texts), fall back to 2-button UI (R4 / P6). */
export const MAX_DIFF_LINES = 200;

// ------------------------------------------------------------------
// Pure utility functions
// ------------------------------------------------------------------

/**
 * Split text on newlines. Empty lines are preserved.
 * Trailing newline does NOT produce a spurious empty final element.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  // Remove single trailing empty line from a trailing newline (common in textarea content)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Compare two lines for equality, ignoring trailing whitespace only (W3).
 * Case-sensitive; leading whitespace preserved; Unicode not normalised.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function linesEqual(a, b) {
  return a.replace(/\s+$/, '') === b.replace(/\s+$/, '');
}

// ------------------------------------------------------------------
// LCS (Longest Common Subsequence)
// Standard O(m*n) DP; returns indices into `a` that form the LCS with `b`.
// ------------------------------------------------------------------

/**
 * Compute the Longest Common Subsequence of two line arrays.
 * Returns an array of [indexInA, indexInB] pairs for each matched line.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<[number, number]>}
 */
function lcs(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return [];

  // DP table — only need two rows at a time for memory efficiency.
  // But for backtracking we need the full table.
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesEqual(a[i - 1], b[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to recover the actual pairs
  const pairs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (linesEqual(a[i - 1], b[j - 1])) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

// ------------------------------------------------------------------
// 3-way diff
// ------------------------------------------------------------------

/**
 * Compute a 3-way line-based diff.
 *
 * Algorithm:
 *  1. Run LCS(original, user) and LCS(original, server) independently.
 *  2. Walk original lines; for each line, classify whether it appears in
 *     user, server, both, or neither.
 *  3. Produce unified chunks for display.
 *
 * @param {string} original — the value when the user started editing (client-captured baseline)
 * @param {string} user     — the user's pending edit
 * @param {string} server   — the server's current value (from 412 envelope)
 * @returns {{ chunks: Array<{type: string, text: string}>, summary: object }
 *          | { fallback: true }}
 */
export function diff3(original, user, server) {
  const origLines = splitLines(original);
  const userLines = splitLines(user);
  const srvLines  = splitLines(server);

  // R4 / P6 cap: fall back if any side is too large
  if (origLines.length > MAX_DIFF_LINES ||
      userLines.length > MAX_DIFF_LINES ||
      srvLines.length > MAX_DIFF_LINES) {
    return { fallback: true };
  }

  // LCS original↔user and original↔server
  const userMatches  = lcs(origLines, userLines);  // [[oi, ui], ...]
  const srvMatches   = lcs(origLines, srvLines);   // [[oi, si], ...]

  // Build sets: which original indices are matched in user / server
  const origInUser = new Set(userMatches.map(([oi]) => oi));
  const origInSrv  = new Set(srvMatches.map(([oi]) => oi));
  // Reverse maps: original index → user/server index
  const origToUser = new Map(userMatches.map(([oi, ui]) => [oi, ui]));
  const origToSrv  = new Map(srvMatches.map(([oi, si]) => [oi, si]));

  // Track which user/server lines have been consumed via original matches
  const usedUser = new Set();
  const usedSrv  = new Set();

  const chunks = [];
  let summary = { same: 0, userOnly: 0, serverOnly: 0, conflict: 0 };

  // Walk original lines; emit chunks
  for (let oi = 0; oi < origLines.length; oi++) {
    const inUser = origInUser.has(oi);
    const inSrv  = origInSrv.has(oi);

    if (inUser && inSrv) {
      // Line present in all three — 'same'
      const ui = origToUser.get(oi);
      const si = origToSrv.get(oi);
      usedUser.add(ui);
      usedSrv.add(si);
      chunks.push({ type: 'same', text: origLines[oi] });
      summary.same++;
    } else if (inUser && !inSrv) {
      // User kept it; server removed it → user-add (relative to server)
      const ui = origToUser.get(oi);
      usedUser.add(ui);
      chunks.push({ type: 'user-add', text: userLines[ui] });
      summary.userOnly++;
    } else if (!inUser && inSrv) {
      // Server kept it; user removed it → server-add (relative to user)
      const si = origToSrv.get(oi);
      usedSrv.add(si);
      chunks.push({ type: 'server-add', text: srvLines[si] });
      summary.serverOnly++;
    } else {
      // Removed by both — skip (no output)
    }
  }

  // Lines in user not matched to any original line — user added them
  for (let ui = 0; ui < userLines.length; ui++) {
    if (!usedUser.has(ui)) {
      chunks.push({ type: 'user-add', text: userLines[ui] });
      summary.userOnly++;
    }
  }

  // Lines in server not matched to any original line — server added them
  for (let si = 0; si < srvLines.length; si++) {
    if (!usedSrv.has(si)) {
      chunks.push({ type: 'server-add', text: srvLines[si] });
      summary.serverOnly++;
    }
  }

  return { chunks, summary };
}

// ------------------------------------------------------------------
// DOM rendering
// ------------------------------------------------------------------

/**
 * Render a diff3 result into a DOM <section> for the conflict modal.
 *
 * @param {{ chunks: Array<{type, text}>, summary: object } | { fallback: true }} diffResult
 * @param {{ onTakeMine: Function, onTakeTheirs: Function, onMergeManually: Function,
 *            userText: string, serverText: string }} callbacks
 * @returns {HTMLElement} — the rendered <section>
 */
export function renderDiffPanel(diffResult, callbacks) {
  const section = document.createElement('section');
  section.className = 'diff-panel';

  if (!diffResult || diffResult.fallback) {
    const msg = document.createElement('p');
    msg.textContent = 'Content too large for 3-way diff view.';
    section.appendChild(msg);
  } else {
    // Header
    const header = document.createElement('div');
    header.className = 'diff-header';
    const title = document.createElement('h3');
    title.textContent = 'Merge conflict';
    header.appendChild(title);
    section.appendChild(header);

    // Diff lines
    const pre = document.createElement('div');
    pre.className = 'diff-lines';
    for (const chunk of diffResult.chunks) {
      const row = document.createElement('div');
      row.className = `diff-line diff-${chunk.type}`;
      // Prefix indicator
      const prefix = document.createElement('span');
      prefix.className = 'diff-prefix';
      if (chunk.type === 'user-add') prefix.textContent = '+';
      else if (chunk.type === 'server-add') prefix.textContent = '~';
      else prefix.textContent = ' ';
      row.appendChild(prefix);
      const content = document.createElement('span');
      content.className = 'diff-content';
      content.textContent = chunk.text; // textContent — never innerHTML
      row.appendChild(content);
      pre.appendChild(row);
    }
    section.appendChild(pre);
  }

  // Buttons
  const actions = document.createElement('div');
  actions.className = 'diff-actions';

  const takeMineBtn = document.createElement('button');
  takeMineBtn.type = 'button';
  takeMineBtn.className = 'diff-btn diff-take-mine';
  takeMineBtn.textContent = 'Take Mine';
  takeMineBtn.addEventListener('click', () => callbacks.onTakeMine && callbacks.onTakeMine());

  const takeTheirsBtn = document.createElement('button');
  takeTheirsBtn.type = 'button';
  takeTheirsBtn.className = 'diff-btn diff-take-theirs';
  takeTheirsBtn.textContent = 'Take Theirs';
  takeTheirsBtn.addEventListener('click', () => callbacks.onTakeTheirs && callbacks.onTakeTheirs());

  const mergeBtn = document.createElement('button');
  mergeBtn.type = 'button';
  mergeBtn.className = 'diff-btn diff-merge';
  mergeBtn.textContent = 'Save Manually-Merged';
  mergeBtn.addEventListener('click', () => callbacks.onMergeManually && callbacks.onMergeManually());

  actions.appendChild(takeMineBtn);
  actions.appendChild(takeTheirsBtn);
  actions.appendChild(mergeBtn);
  section.appendChild(actions);

  return section;
}
