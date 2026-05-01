/**
 * Telegram Web App initData verifier (v1.13.0).
 *
 * Categorization axis: WHO is the protocol's other party?
 *   - Internal-to-Jarvis primitives (path sandbox, scrubber, blocklist, email tokens) → src/safety/
 *   - External protocol implementations (Telegram Mini App HMAC, future OAuth client-side,
 *     future Slack/WhatsApp WebApp protocols) → src/webapp/ (this module)
 *
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Implementation notes:
 *
 * 1. URL decoding: We URL-decode each value AFTER extracting it from
 *    URLSearchParams (which decodes once already). This matches grammY's
 *    reference impl (https://github.com/grammyjs/grammY). The
 *    data-check-string components are decoded once total — Telegram's spec
 *    examples confirm.
 *
 * 2. Hash extraction: We use exact case-sensitive 'hash' (lowercase). Other
 *    case variants (e.g. 'Hash', 'HASH') are NOT recognized and the missing-
 *    hash path returns reason 'malformed'. This defends against attackers
 *    submitting BOTH a real lowercase hash AND a lookalike that an
 *    accidentally-permissive parser might accept.
 *
 * 3. Duplicate-hash defense: URLSearchParams.get() returns the FIRST value of
 *    a duplicated key. We additionally reject when params.getAll('hash')
 *    returns more than one value, with reason 'malformed'. Defends against
 *    attackers crafting initData with both a forged hash AND a valid hash
 *    hoping a permissive verifier picks the wrong one.
 *
 * 4. timingSafeEqual: requires equal-length buffers. We pre-validate both
 *    are 64 hex chars (=32 bytes) BEFORE calling timingSafeEqual. The
 *    pre-check is observably timed (length is public anyway), so its timing
 *    leaks nothing. If lengths differ, return 'bad-hash' immediately.
 *
 * 5. Future-skew: per R7, reject when auth_date is > maxFutureSkewSeconds
 *    in the future (default 300s). Stale check (older than maxAgeSeconds)
 *    happens after the future-skew check; both run AFTER the HMAC check,
 *    so a malformed-hash request never gets a clock-related error message
 *    (which could leak server-side time).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { child } from '../logger/index.js';

const log = child({ component: 'webapp.auth' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerifiedInitData {
  user: {
    id: number;
    username?: string;
    first_name?: string;
    language_code?: string;
  };
  chat?: { id: number; type: string };
  authDate: Date;
  query_id?: string;
  raw: string;
}

export type VerifyResult =
  | { ok: true; data: VerifiedInitData }
  | { ok: false; reason: 'malformed' | 'bad-hash' | 'stale' | 'no-user' };

export interface VerifyOpts {
  maxAgeSeconds?: number;
  maxFutureSkewSeconds?: number;
  /** Override clock source — useful for deterministic tests. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Verify a Telegram Mini App initData string.
 *
 * @param initData  The raw initData string from Telegram.WebApp.initData
 * @param botToken  The bot token used to derive the secret key
 * @param opts      Optional: maxAgeSeconds (default 86400), maxFutureSkewSeconds (default 300), now
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  opts?: VerifyOpts,
): VerifyResult {
  const maxAgeSeconds = opts?.maxAgeSeconds ?? 86400;
  const maxFutureSkewSeconds = opts?.maxFutureSkewSeconds ?? 300;
  const nowMs = (opts?.now ?? new Date()).getTime();

  // -------------------------------------------------------------------------
  // 1. Parse
  // -------------------------------------------------------------------------
  if (!initData || typeof initData !== 'string') {
    log.debug({}, 'verifyTelegramInitData: empty or non-string input');
    return { ok: false, reason: 'malformed' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    log.debug({}, 'verifyTelegramInitData: URLSearchParams parse failed');
    return { ok: false, reason: 'malformed' };
  }

  // -------------------------------------------------------------------------
  // 2. Hash field validation (case-sensitive lowercase 'hash' only)
  // -------------------------------------------------------------------------

  // Reject duplicate hash fields (defense per R8 note 3)
  const allHashValues = params.getAll('hash');
  if (allHashValues.length > 1) {
    log.debug({ count: allHashValues.length }, 'verifyTelegramInitData: duplicate hash field');
    return { ok: false, reason: 'malformed' };
  }

  const receivedHash = params.get('hash');
  if (!receivedHash) {
    // This catches: missing hash entirely, AND case-variant 'Hash' / 'HASH'
    // (URLSearchParams is case-sensitive; 'Hash' won't match 'hash')
    log.debug({}, 'verifyTelegramInitData: missing or non-lowercase hash field');
    return { ok: false, reason: 'malformed' };
  }

  // -------------------------------------------------------------------------
  // 3. Build the data-check-string (all params except 'hash', sorted, decoded)
  // -------------------------------------------------------------------------
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    // URLSearchParams already decoded once. Telegram spec examples show values
    // decoded in the check string. One decode total.
    pairs.push([key, decodeURIComponent(value)]);
  }

  if (pairs.length === 0) {
    log.debug({}, 'verifyTelegramInitData: no fields other than hash');
    return { ok: false, reason: 'malformed' };
  }

  // Sort lexicographically by key
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  // -------------------------------------------------------------------------
  // 4. HMAC verification
  // -------------------------------------------------------------------------
  // secret_key = HMAC-SHA256("WebAppData", bot_token)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Pre-validate both hashes are 64 hex chars (32 bytes) before timingSafeEqual
  // (note 4: pre-check avoids the throw-on-length-mismatch observable timing path)
  if (receivedHash.length !== 64 || computedHash.length !== 64) {
    log.debug(
      { receivedLen: receivedHash.length, computedLen: computedHash.length },
      'verifyTelegramInitData: hash length mismatch — returning bad-hash',
    );
    return { ok: false, reason: 'bad-hash' };
  }

  const receivedBuf = Buffer.from(receivedHash, 'hex');
  const computedBuf = Buffer.from(computedHash, 'hex');

  if (!timingSafeEqual(receivedBuf, computedBuf)) {
    log.debug({}, 'verifyTelegramInitData: HMAC mismatch');
    return { ok: false, reason: 'bad-hash' };
  }

  // -------------------------------------------------------------------------
  // 5. Timestamp checks (run AFTER HMAC so bad-hash never leaks server time)
  //    Future-skew first (R8 note 5), then stale check.
  // -------------------------------------------------------------------------
  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) {
    log.debug({}, 'verifyTelegramInitData: missing auth_date');
    return { ok: false, reason: 'malformed' };
  }

  const authDateUnix = parseInt(authDateRaw, 10);
  if (!Number.isFinite(authDateUnix)) {
    log.debug({ authDateRaw }, 'verifyTelegramInitData: auth_date is not a number');
    return { ok: false, reason: 'malformed' };
  }

  const authDateMs = authDateUnix * 1000;
  const diffSeconds = (authDateMs - nowMs) / 1000;

  // Future-skew check (R7 / R8 note 5)
  if (diffSeconds > maxFutureSkewSeconds) {
    log.debug({ diffSeconds, maxFutureSkewSeconds }, 'verifyTelegramInitData: auth_date too far in future');
    return { ok: false, reason: 'stale' };
  }

  // Stale check
  const ageSeconds = (nowMs - authDateMs) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    log.debug({ ageSeconds, maxAgeSeconds }, 'verifyTelegramInitData: auth_date too old');
    return { ok: false, reason: 'stale' };
  }

  // -------------------------------------------------------------------------
  // 6. Parse user field
  // -------------------------------------------------------------------------
  const userRaw = params.get('user');
  if (!userRaw) {
    log.debug({}, 'verifyTelegramInitData: missing user field');
    return { ok: false, reason: 'no-user' };
  }

  let user: VerifiedInitData['user'];
  try {
    const parsed = JSON.parse(decodeURIComponent(userRaw)) as Record<string, unknown>;
    if (typeof parsed.id !== 'number') {
      log.debug({ parsedKeys: Object.keys(parsed), idType: typeof parsed.id, hasUser: 'user' in parsed }, 'initData parsed');
      return { ok: false, reason: 'malformed' };
    }
    user = {
      id: parsed.id as number,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      first_name: typeof parsed.first_name === 'string' ? parsed.first_name : undefined,
      language_code: typeof parsed.language_code === 'string' ? parsed.language_code : undefined,
    };
  } catch {
    log.debug({}, 'verifyTelegramInitData: user field JSON parse failed');
    return { ok: false, reason: 'malformed' };
  }

  // -------------------------------------------------------------------------
  // 7. Parse optional fields
  // -------------------------------------------------------------------------
  let chat: VerifiedInitData['chat'] | undefined;
  const chatRaw = params.get('chat');
  if (chatRaw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(chatRaw)) as Record<string, unknown>;
      if (typeof parsed.id === 'number' && typeof parsed.type === 'string') {
        chat = { id: parsed.id as number, type: parsed.type as string };
      }
    } catch {
      // chat field malformed — non-fatal; continue
    }
  }

  const query_id = params.get('query_id') ?? undefined;

  return {
    ok: true,
    data: {
      user,
      chat,
      authDate: new Date(authDateMs),
      query_id,
      raw: initData,
    },
  };
}
