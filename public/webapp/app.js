/**
 * Jarvis Web App hub — v1.14.0
 *
 * Vanilla JS, no framework, no bundler. Loaded via <script src="./app.js" defer>.
 *
 * v1.14.0 hub conversion (ADR 009, R12.3):
 *  - Ping handler and Telegram.WebApp.sendData wiring REMOVED.
 *  - web_app_data sendData is no longer triggered from this page.
 *  - The gateway's web_app_data handler registration is preserved for v1.14.1+
 *    typed routing (see tests/unit/gateway.webAppData.test.ts, R5).
 *
 * Auth strategy (R5): Authorization: tma <initData> header ONLY.
 * The ?initData= query-string fallback is intentionally absent.
 *
 * Theme (R12.4): CSS custom properties on :root are set at runtime from
 * Telegram.WebApp.themeParams. themeChanged event is subscribed so the hub
 * responds to dark/light mode toggles without a page reload.
 */

'use strict';

// ------------------------------------------------------------------
// Theme application (R12.4)
// ------------------------------------------------------------------
function applyTheme() {
  const tp = window.Telegram?.WebApp?.themeParams || {};
  const root = document.documentElement;
  if (tp.bg_color) root.style.setProperty('--bg-color', tp.bg_color);
  if (tp.text_color) root.style.setProperty('--text-color', tp.text_color);
  if (tp.hint_color) root.style.setProperty('--hint-color', tp.hint_color);
  if (tp.button_color) root.style.setProperty('--button-bg', tp.button_color);
  if (tp.button_text_color) root.style.setProperty('--button-text', tp.button_text_color);
  if (tp.secondary_bg_color) root.style.setProperty('--secondary-bg', tp.secondary_bg_color);
}

// ------------------------------------------------------------------
// Bot identity badge (v1.21.0 ADR 021 Pillar 4 D13 + D15)
// ------------------------------------------------------------------

/**
 * Fetch /api/webapp/identity and populate the #bot-name-badge span.
 *
 * Security: botName from server is a member of the BOT_NAMES closed set
 * ('ai-jarvis' | 'ai-tony'). Set via textContent only — XSS-safe.
 *
 * @param {string} initData  — tma initData for Authorization header
 */
function initBotNameBadge(initData) {
  const badgeEl = document.getElementById('bot-name-badge');
  if (!badgeEl) return;

  fetch('/api/webapp/identity', {
    method: 'GET',
    headers: { Authorization: 'tma ' + initData },
  })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(data) {
      if (!data || !data.ok || !data.botName) return;
      badgeEl.textContent = '(' + data.botName + ')'; // textContent — XSS-safe
      badgeEl.removeAttribute('hidden');
    })
    .catch(function() { /* network failure: silently skip badge */ });
}

// ------------------------------------------------------------------
// Coach banner (v1.20.0 D20 — multi-profile + expand panel + heavy-hammer)
// ------------------------------------------------------------------

/**
 * Profile labels for hub banner expanded panel.
 * Mirrors COACH_PROFILE_LABELS in cron/app.js — kept in sync by convention.
 */
const BANNER_PROFILE_LABELS = {
  morning: 'Morning',
  midday: 'Midday',
  evening: 'Evening',
  weekly: 'Weekly',
};

/** Day-of-week names for weekly profile weekday display. */
const BANNER_WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Check coach status and show the "Coach is on" banner if any profile active.
 *
 * D20: uses GET /api/webapp/coach/profiles to get all profiles + quietUntil.
 * Banner text shows active profile count.
 * Expanded <details> panel lists per-profile schedule.
 * Heavy-hammer "Disable everything" button is two-tap: first click shows confirm;
 * second tap POSTs { action: 'mute_all' } to /api/webapp/coach/setup.
 *
 * Security invariants (ADR 009 D6): ALL dynamic content via textContent only.
 * CSP compliance: no inline JS, no confirm() — all wired in this function.
 *
 * @param {string} initData  — tma initData for Authorization header
 */
function initCoachBanner(initData) {
  const bannerEl     = document.getElementById('coach-active-banner');
  const bannerTextEl = document.getElementById('coach-banner-text');
  const profileList  = document.getElementById('coach-banner-profile-list');
  const dismissBtn   = document.getElementById('coach-banner-dismiss');
  const disableAllBtn    = document.getElementById('coach-banner-disable-all');
  const disableConfirmBtn = document.getElementById('coach-banner-disable-confirm');
  if (!bannerEl) return;

  // One-time per session: already dismissed
  if (sessionStorage.getItem('coach-banner-dismissed') === 'true') return;

  fetch('/api/webapp/coach/profiles', {
    method: 'GET',
    headers: { Authorization: 'tma ' + initData },
  })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(data) {
      if (!data || !data.profiles) return;

      const activeProfiles = data.profiles.filter(function(p) { return p.active; });
      if (activeProfiles.length === 0) return; // no active profiles — keep banner hidden

      // Build banner text: "Coach Jarvis active — N profiles + event triggers"
      if (bannerTextEl) {
        const count = activeProfiles.length;
        const profileWord = count === 1 ? 'profile' : 'profiles';
        bannerTextEl.textContent = 'Coach Jarvis active — ' + count + ' ' + profileWord + ' + event triggers';
      }

      // Build per-profile list in expanded panel
      if (profileList) {
        profileList.textContent = ''; // clear placeholder; textContent clears all children
        for (let i = 0; i < activeProfiles.length; i++) {
          const p = activeProfiles[i];
          const li = document.createElement('li');
          li.className = 'coach-banner-profile-item';

          const labelEl = document.createElement('span');
          labelEl.className = 'coach-banner-profile-name';
          const labelText = BANNER_PROFILE_LABELS[p.profile] || p.profile;
          labelEl.textContent = labelText; // our own mapping — safe

          const schedEl = document.createElement('span');
          schedEl.className = 'coach-banner-profile-sched';
          let schedText = p.hhmm || '';
          if (p.profile === 'weekly' && typeof p.weekday === 'number') {
            schedText = (BANNER_WEEKDAY_NAMES[p.weekday] || 'Day ' + p.weekday) + ' ' + schedText;
          }
          schedEl.textContent = schedText; // computed from server data — safe (numeric + known strings)

          li.appendChild(labelEl);
          li.appendChild(schedEl);
          profileList.appendChild(li);
        }
      }

      // Show quiet indicator if applicable
      if (data.quietUntil && bannerTextEl) {
        try {
          const quietDate = new Date(data.quietUntil);
          if (quietDate.getTime() > Date.now()) {
            const quietSpan = document.createElement('span');
            quietSpan.className = 'coach-banner-quiet';
            quietSpan.textContent = ' (quiet mode on)';
            bannerTextEl.appendChild(quietSpan);
          }
        } catch {
          // date parse failure is non-fatal
        }
      }

      // Reveal the banner (hidden by default in HTML)
      bannerEl.removeAttribute('hidden');
    })
    .catch(function() { /* network failure: silently skip banner */ });

  // Heavy-hammer two-tap pattern (ADR 020 D20):
  //   Tap 1: hide "Disable everything", show "Confirm — disable all?"
  //   Tap 2: POST { action: 'mute_all' }, hide banner, reset button state
  if (disableAllBtn && disableConfirmBtn) {
    disableAllBtn.addEventListener('click', function() {
      disableAllBtn.setAttribute('hidden', '');
      disableConfirmBtn.removeAttribute('hidden');
    });

    disableConfirmBtn.addEventListener('click', function() {
      fetch('/api/webapp/coach/setup', {
        method: 'POST',
        headers: {
          Authorization: 'tma ' + initData,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'mute_all' }),
      })
        .then(function(res) {
          if (res.ok) {
            bannerEl.setAttribute('hidden', '');
            sessionStorage.setItem('coach-banner-dismissed', 'true');
          } else {
            // Reset button state on failure — let user retry
            disableConfirmBtn.setAttribute('hidden', '');
            disableAllBtn.removeAttribute('hidden');
          }
        })
        .catch(function() {
          disableConfirmBtn.setAttribute('hidden', '');
          disableAllBtn.removeAttribute('hidden');
        });
    });
  }

  // Dismiss button: hide for session; coach stays on
  if (dismissBtn) {
    dismissBtn.addEventListener('click', function(evt) {
      evt.preventDefault(); // prevent <details> toggle when dismissing
      evt.stopPropagation();
      sessionStorage.setItem('coach-banner-dismissed', 'true');
      bannerEl.setAttribute('hidden', '');
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const greetingEl = document.getElementById('greeting');
  const statusEl = document.getElementById('status');
  const userInfoEl = document.getElementById('user-info');
  const userIdEl = document.getElementById('user-id');
  const featuresEl = document.getElementById('features');
  const unauthEl = document.getElementById('unauth-message');

  // --- Unauth path: SDK not present (opened in browser, not via Telegram) ---
  if (!window.Telegram || !window.Telegram.WebApp) {
    if (greetingEl) greetingEl.textContent = 'Not in Telegram';
    if (statusEl) statusEl.textContent = '';
    if (unauthEl) unauthEl.hidden = false;
    if (userInfoEl) userInfoEl.hidden = true;
    if (featuresEl) featuresEl.hidden = true;
    return;
  }

  const twa = window.Telegram.WebApp;

  // Signal readiness to Telegram and expand to full height
  twa.ready();
  twa.expand();

  // Apply theme immediately and subscribe to future changes (R12.4)
  applyTheme();
  twa.onEvent('themeChanged', applyTheme);

  const initData = twa.initData || '';
  const initDataUnsafe = twa.initDataUnsafe || {};

  // --- Unauth path: empty initData (developer tools / direct URL) ---
  if (!initData) {
    if (greetingEl) greetingEl.textContent = 'Not authenticated';
    if (statusEl) statusEl.textContent = '';
    if (unauthEl) unauthEl.hidden = false;
    if (userInfoEl) userInfoEl.hidden = true;
    if (featuresEl) featuresEl.hidden = true;
    return;
  }

  // Cosmetic greeting from initDataUnsafe (not verified here — server verifies)
  const firstName = initDataUnsafe.user && initDataUnsafe.user.first_name
    ? initDataUnsafe.user.first_name
    : 'there';
  if (greetingEl) greetingEl.textContent = firstName;
  if (statusEl) statusEl.textContent = 'Verifying with Jarvis…';

  // Verify with the server using Authorization: tma <initData> (R5 — header only)
  fetch('/api/webapp/echo', {
    method: 'GET',
    headers: {
      Authorization: `tma ${initData}`,
    },
  })
    .then((res) => {
      if (res.ok) {
        return res.json().then((data) => {
          // Server verified — show the authenticated hub UI
          if (statusEl) statusEl.textContent = '';
          if (userInfoEl) userInfoEl.hidden = false;
          // R3: echo response now includes ok: true; userId may be under data.userId
          if (userIdEl) userIdEl.textContent = String(data.userId ?? '');
          if (featuresEl) featuresEl.hidden = false;
          // v1.21.0 Pillar 4: show bot name badge
          initBotNameBadge(initData);
          // v1.19.0 D17: show coach banner if active
          initCoachBanner(initData);
        });
      } else {
        return res.json().catch(() => ({})).then((body) => {
          const reason = body && body.reason ? body.reason : String(res.status);
          if (statusEl) statusEl.hidden = true;
          if (greetingEl) {
            greetingEl.textContent =
              `Verification failed (reason: ${reason}). Try reopening the Web App.`;
          }
          if (userInfoEl) userInfoEl.hidden = true;
          if (featuresEl) featuresEl.hidden = true;
        });
      }
    })
    .catch((err) => {
      if (statusEl) statusEl.textContent = `Network error: ${err.message}`;
      if (userInfoEl) userInfoEl.hidden = true;
      if (featuresEl) featuresEl.hidden = true;
    });
});
