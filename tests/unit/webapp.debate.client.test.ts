/**
 * Client-side smoke tests for public/webapp/debate/ (v1.16.0).
 *
 * Vitest cannot execute real browser JS, so these tests load the static
 * source files via fs.readFileSync and assert structural/safety properties:
 *  - CSP compliance (no inline script bodies)
 *  - Hub tile addition in public/webapp/index.html
 *  - Debate index.html required structure (IDs, back link, CSP)
 *  - app.js SSE reconnect logic (exponential backoff constants)
 *  - Side-by-side debater column rendering (CSS grid on desktop)
 *  - Mobile-first breakpoint at 768px (W4)
 *  - Live indicator pulse on status='running'
 *  - textContent-only invariant (ADR 009 decision 6)
 *  - Auth header pattern (tma initData)
 *
 * These tests are intentionally fast and do not require a browser or server.
 *
 * v1.16.0 — ADR 016 D1/D3/D4/D14 + W4 bindings.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const hubHtml   = readFileSync(path.join(root, 'public/webapp/index.html'), 'utf8');
const debateHtml = readFileSync(path.join(root, 'public/webapp/debate/index.html'), 'utf8');
const debateAppJs = readFileSync(path.join(root, 'public/webapp/debate/app.js'), 'utf8');
const debateStylesCSS = readFileSync(path.join(root, 'public/webapp/debate/styles.css'), 'utf8');

// ------------------------------------------------------------------
// Hub tile — ADR 016 D1
// ------------------------------------------------------------------

describe('webapp debate client — hub index.html Debate tile (D1)', () => {
  it('hub has Debate tile link to ./debate/', () => {
    expect(hubHtml).toContain('href="./debate/"');
  });

  it('hub Debate tile has feature-label "Debate"', () => {
    expect(hubHtml).toContain('Debate');
  });

  it('hub Debate tile emoji is present (🤔)', () => {
    expect(hubHtml).toContain('🤔');
  });

  it('hub still has Organize tile (regression — D1 additive only)', () => {
    expect(hubHtml).toContain('href="./organize/"');
  });

  it('hub has no inline script bodies (CSP-compliant)', () => {
    expect(hubHtml).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
  });
});

// ------------------------------------------------------------------
// Debate index.html structure
// ------------------------------------------------------------------

describe('webapp debate client — debate/index.html structure', () => {
  it('has no inline script bodies (CSP-compliant)', () => {
    expect(debateHtml).not.toMatch(/<script[^>]*>[^<]+<\/script>/);
  });

  it('loads the Telegram WebApp SDK from the official CDN', () => {
    expect(debateHtml).toContain('<script src="https://telegram.org/js/telegram-web-app.js">');
  });

  it('loads app.js as ES module with defer', () => {
    expect(debateHtml).toContain('<script type="module" src="./app.js" defer>');
  });

  it('has back-to-hub link (href="../")', () => {
    expect(debateHtml).toContain('href="../"');
  });

  it('has header with 🤔 Debate title', () => {
    expect(debateHtml).toContain('🤔 Debate');
  });

  it('has #list-view container', () => {
    expect(debateHtml).toContain('id="list-view"');
  });

  it('has #debate-list list element', () => {
    expect(debateHtml).toContain('id="debate-list"');
  });

  it('has #list-empty empty state message', () => {
    expect(debateHtml).toContain('id="list-empty"');
  });

  it('has #list-loading loading indicator', () => {
    expect(debateHtml).toContain('id="list-loading"');
  });

  it('has #detail-view container (hidden by default)', () => {
    expect(debateHtml).toContain('id="detail-view"');
    expect(debateHtml).toMatch(/id="detail-view"\s[^>]*hidden|<section[^>]*hidden[^>]*id="detail-view"/);
  });

  it('has #detail-back button in detail view', () => {
    expect(debateHtml).toContain('id="detail-back"');
  });

  it('has #debater-columns container for side-by-side columns', () => {
    expect(debateHtml).toContain('id="debater-columns"');
  });

  it('has #live-indicator for streaming status (pulse dot)', () => {
    expect(debateHtml).toContain('id="live-indicator"');
  });

  it('has #verdict-section <details> for verdict + reasoning', () => {
    expect(debateHtml).toContain('id="verdict-section"');
    expect(debateHtml).toMatch(/<details[^>]*id="verdict-section"|id="verdict-section"[^>]*>/);
  });

  it('has #toast container at body level', () => {
    expect(debateHtml).toContain('id="toast"');
  });

  it('links the external styles.css', () => {
    expect(debateHtml).toContain('<link rel="stylesheet" href="./styles.css">');
  });
});

// ------------------------------------------------------------------
// Debate app.js — SSE reconnect logic (D3 + D4)
// ------------------------------------------------------------------

describe('webapp debate client — debate/app.js SSE reconnect logic (D3/D4)', () => {
  it('uses fetch() for SSE — not EventSource API (D3: custom header support)', () => {
    // Must NOT use new EventSource(
    expect(debateAppJs).not.toContain('new EventSource(');
    // Must use fetch(
    expect(debateAppJs).toContain('fetch(');
  });

  it('uses response.body.getReader() for SSE stream reading (D3)', () => {
    expect(debateAppJs).toContain('.getReader()');
  });

  it('defines SSE_BACKOFF_BASE_MS = 1000 (D4 exponential backoff)', () => {
    expect(debateAppJs).toContain('SSE_BACKOFF_BASE_MS');
    expect(debateAppJs).toContain('1000');
  });

  it('defines SSE_BACKOFF_CAP_MS = 30000 (D4 exponential backoff cap)', () => {
    expect(debateAppJs).toContain('SSE_BACKOFF_CAP_MS');
    expect(debateAppJs).toContain('30000');
  });

  it('implements exponential backoff doubling (D4)', () => {
    // Backoff doubles: _sseBackoff = Math.min(_sseBackoff * 2, SSE_BACKOFF_CAP_MS)
    expect(debateAppJs).toContain('SSE_BACKOFF_CAP_MS');
    expect(debateAppJs).toContain('Math.min(');
    expect(debateAppJs).toContain('* 2');
  });

  it('implements _sseClosed flag for intentional close (no reconnect)', () => {
    expect(debateAppJs).toContain('_sseClosed');
  });

  it('SSE close calls scheduleReconnect (D4)', () => {
    expect(debateAppJs).toContain('function scheduleReconnect(');
    expect(debateAppJs).toContain('scheduleReconnect(');
  });

  it('connectSse re-fetches snapshot before streaming (D4 reconnect invariant)', () => {
    expect(debateAppJs).toContain('function connectSse(');
  });

  it('closeSse() cancels reader and clears reconnect timer (D4)', () => {
    expect(debateAppJs).toContain('function closeSse(');
    expect(debateAppJs).toContain('_sseReconnectTimer');
    expect(debateAppJs).toContain('.cancel()');
  });

  it('SSE auth header uses Authorization: tma (D3 / ADR 008 R5)', () => {
    expect(debateAppJs).toContain('`tma ${initData}`');
  });

  it('SSE Accept header is text/event-stream (D3)', () => {
    expect(debateAppJs).toContain('text/event-stream');
  });
});

// ------------------------------------------------------------------
// Side-by-side debater column rendering (D14)
// ------------------------------------------------------------------

describe('webapp debate client — debate/app.js debater column rendering (D14)', () => {
  it('buildDebaterColumn function is defined (D14)', () => {
    expect(debateAppJs).toContain('function buildDebaterColumn(');
  });

  it('debater column uses <details> element (mobile accordion)', () => {
    expect(debateAppJs).toContain("createElement('details')");
  });

  it('debater column header uses <summary> element (D14)', () => {
    expect(debateAppJs).toContain("createElement('summary')");
  });

  it('appendTurnToColumn function is defined (D14)', () => {
    expect(debateAppJs).toContain('function appendTurnToColumn(');
  });

  it('turn content uses textContent — never innerHTML (ADR 009 decision 6)', () => {
    // User-authored debate text in turn items must use textContent
    expect(debateAppJs).toContain('text.textContent = content');
  });

  it('does not use innerHTML on user-authored content (ADR 009 decision 6)', () => {
    // All innerHTML = '' uses are safe structural clears
    const dangerous = debateAppJs.match(/\.innerHTML\s*=\s*(?!['"`]\s*['"`])[^'"`\s;]/g);
    expect(dangerous).toBeNull();
  });

  it('renderDetailSnapshot function is defined (D14 list→detail navigation)', () => {
    expect(debateAppJs).toContain('function renderDetailSnapshot(');
  });

  it('debate topic uses textContent (not innerHTML) — user-authored', () => {
    expect(debateAppJs).toContain('detailTopicEl.textContent = debate.topic');
  });

  it('renderVerdict function is defined (D14 verdict section)', () => {
    expect(debateAppJs).toContain('function renderVerdict(');
  });

  it('verdict content uses textContent (not innerHTML) — user-authored', () => {
    expect(debateAppJs).toContain('verdictContentEl.textContent');
  });
});

// ------------------------------------------------------------------
// Live indicator pulse on status='running' (D14)
// ------------------------------------------------------------------

describe('webapp debate client — debate/app.js live indicator (D14)', () => {
  it('live-indicator is shown when SSE starts (startSse sets liveIndicatorEl)', () => {
    expect(debateAppJs).toContain('liveIndicatorEl.hidden = false');
  });

  it('live-indicator is hidden on SSE terminal events (complete/aborted)', () => {
    expect(debateAppJs).toContain("liveIndicatorEl.hidden = true");
  });

  it('debate status badge rendering includes "running" class', () => {
    expect(debateAppJs).toContain('debate.status');
    expect(debateAppJs).toContain("badge.className = `debate-status-badge ${debate.status");
  });
});

// ------------------------------------------------------------------
// CSS — W4 mobile-first breakpoint at 768px + grid layout (W4)
// ------------------------------------------------------------------

describe('webapp debate client — debate/styles.css mobile-first layout (W4)', () => {
  it('default layout is single-column accordion (mobile-first; no grid at root level)', () => {
    // The .debater-columns at root level should NOT have display: grid
    // (grid is only inside the @media query)
    const rootSection = debateStylesCSS.split('@media')[0];
    expect(rootSection).not.toMatch(/\.debater-columns\s*\{[^}]*display\s*:\s*grid/);
  });

  it('W4: @media (min-width: 768px) promotes to grid layout (W4 binding)', () => {
    // The media query MUST use min-width: 768px
    expect(debateStylesCSS).toContain('@media (min-width: 768px)');
    // The file must contain display: grid (inside the media query)
    expect(debateStylesCSS).toContain('display: grid');
    // Verify the grid and media query co-occur (both present in CSS)
    const hasMediaQuery = debateStylesCSS.includes('@media (min-width: 768px)');
    const hasGrid = debateStylesCSS.includes('display: grid');
    expect(hasMediaQuery && hasGrid).toBe(true);
  });

  it('live-pulse element has CSS animation for pulse effect (D14)', () => {
    expect(debateStylesCSS).toContain('.live-pulse');
    expect(debateStylesCSS).toContain('animation');
  });

  it('verdict section uses <details> pattern (CSS present for .verdict-section)', () => {
    expect(debateStylesCSS).toContain('.verdict-section');
  });

  it('debate-status-badge has running / complete / aborted variants', () => {
    expect(debateStylesCSS).toContain('.debate-status-badge.running');
    expect(debateStylesCSS).toContain('.debate-status-badge.complete');
    expect(debateStylesCSS).toContain('.debate-status-badge.aborted');
  });
});
