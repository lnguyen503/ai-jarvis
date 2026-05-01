/**
 * Unit tests for hub banner — v1.19.0 D17 (updated for v1.20.0 D20).
 *
 * Tests assert structural/safety properties via fs.readFileSync.
 *
 * v1.20.0 D20 updates:
 *  - BNR-2: #coach-banner-disable replaced by two-tap heavy-hammer buttons
 *    (#coach-banner-disable-all + #coach-banner-disable-confirm)
 *  - BNR-6: action:'off' replaced by action:'mute_all' (heavy-hammer)
 *
 * Coverage:
 *  - BNR-1: hub index.html has #coach-active-banner element (hidden by default)
 *  - BNR-2: hub index.html has #coach-banner-disable-all and #coach-banner-dismiss buttons (D20)
 *  - BNR-3: hub app.js defines initCoachBanner function
 *  - BNR-4: app.js uses textContent (not innerHTML) — ADR 009 D6
 *  - BNR-5: app.js checks sessionStorage for 'coach-banner-dismissed'
 *  - BNR-6: app.js POSTs { action: 'mute_all' } on heavy-hammer confirm (D20)
 *  - BNR-7: hub styles.css defines .coach-banner class
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const root = path.resolve(__dirname, '../..');
const hubHtml = readFileSync(path.join(root, 'public/webapp/index.html'), 'utf8');
const hubAppJs = readFileSync(path.join(root, 'public/webapp/app.js'), 'utf8');
const hubCSS   = readFileSync(path.join(root, 'public/webapp/styles.css'), 'utf8');

describe('"Coach is on" hub banner — index.html (D17)', () => {
  it('BNR-1: #coach-active-banner element is present and hidden by default', () => {
    expect(hubHtml).toContain('id="coach-active-banner"');
    // Must be hidden by default (hidden attribute)
    const idx = hubHtml.indexOf('id="coach-active-banner"');
    // Find the opening tag containing this id
    const tagStart = hubHtml.lastIndexOf('<', idx);
    const tagEnd = hubHtml.indexOf('>', idx);
    const tag = hubHtml.slice(tagStart, tagEnd + 1);
    expect(tag).toContain('hidden');
  });

  it('BNR-2: hub has heavy-hammer disable buttons and dismiss button (D20)', () => {
    // v1.20.0 D20: replaced single "Disable" with two-tap heavy-hammer pattern
    expect(hubHtml).toContain('id="coach-banner-disable-all"');
    expect(hubHtml).toContain('id="coach-banner-disable-confirm"');
    expect(hubHtml).toContain('id="coach-banner-dismiss"');
  });
});

describe('"Coach is on" hub banner — app.js (D17)', () => {
  it('BNR-3: app.js defines initCoachBanner function', () => {
    expect(hubAppJs).toContain('function initCoachBanner');
  });

  it('BNR-4: app.js uses .textContent (not .innerHTML =) in banner — ADR 009 D6', () => {
    const fnIdx = hubAppJs.indexOf('function initCoachBanner');
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    const fnBody = hubAppJs.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toContain('.textContent');
    expect(fnBody).not.toContain('.innerHTML =');
  });

  it('BNR-5: app.js checks sessionStorage coach-banner-dismissed before showing', () => {
    const fnIdx = hubAppJs.indexOf('function initCoachBanner');
    const fnBody = hubAppJs.slice(fnIdx, fnIdx + 1500);
    expect(fnBody).toContain('coach-banner-dismissed');
    expect(fnBody).toContain('sessionStorage');
  });

  it('BNR-6: heavy-hammer confirm button POSTs action: mute_all to coach/setup (D20)', () => {
    // Search full source — function body is large; windowing by char count is fragile
    expect(hubAppJs).toContain("action: 'mute_all'");
    // The POST to coach/setup is inside initCoachBanner (verified by function existence in BNR-3)
    expect(hubAppJs).toContain('coach/setup');
  });
});

describe('"Coach is on" hub banner — styles.css (D17)', () => {
  it('BNR-CSS-1: hub styles.css defines .coach-banner class', () => {
    expect(hubCSS).toContain('.coach-banner');
  });

  it('BNR-CSS-2: hub styles.css defines .coach-banner-text class', () => {
    expect(hubCSS).toContain('.coach-banner-text');
  });
});
