/**
 * Pre-navigation URL validator for the browser tool.
 *
 * Purpose: prevent server-side request forgery (SSRF) when the LLM hands us
 * a URL. The browser tool runs on the host and can reach anything that host
 * can reach — so without a guard, a prompt-injection payload could aim it at
 * `http://127.0.0.1:7878/…` (Jarvis's health endpoint), `http://169.254.169.254/`
 * (cloud-metadata), or a private LAN service.
 *
 * Rules enforced (fail → throw SsrfBlockedError):
 *   1. Scheme must be http or https. No file:, data:, javascript:, ftp:, chrome:, etc.
 *   2. Hostname must resolve to a PUBLIC unicast IP. Every A/AAAA record is checked;
 *      if ANY resolves to a private/loopback/link-local/unspecified/reserved range,
 *      the URL is rejected (prevents DNS-rebinding and multi-record sneakiness).
 *   3. Hostname-as-IP literals are caught without DNS (someone typing `http://10.0.0.5`).
 *   4. Configured `denyHosts` globs are honored (e.g. `"*.internal"`, `"*.corp"`).
 *
 * Only what's explicitly checked is allowed. "Public" here means: not
 * loopback, not link-local, not private (RFC 1918 / RFC 4193), not
 * unspecified (0.0.0.0, ::), not reserved (240/4), and not multicast.
 */

import { promises as dns } from 'dns';
import net from 'net';

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface SsrfGuardOptions {
  /** Extra hostname globs the user configured to deny (case-insensitive). */
  denyHosts?: string[];
  /**
   * Override DNS resolution — lets tests inject deterministic IPs without
   * hitting the real resolver. Returns the list of resolved addresses.
   */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * Validate that a URL is safe to navigate to. Resolves with the normalized
 * URL on success; throws SsrfBlockedError on any failure.
 *
 * Returns the normalized URL string (lower-case host, trailing dot stripped)
 * so callers use the version that matches what got validated.
 */
export async function assertUrlIsSafe(
  rawUrl: string,
  options: SsrfGuardOptions = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(
      `URL is not parseable: ${rawUrl}`,
      'invalid-url',
      rawUrl,
    );
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new SsrfBlockedError(
      `Only http and https URLs are allowed; got "${scheme}:"`,
      'bad-scheme',
      rawUrl,
    );
  }

  // Normalize host — strip trailing dot (valid in DNS but confuses globs),
  // lowercase, and strip IPv6 brackets that the WHATWG URL parser keeps on
  // .hostname ("[::1]" → "::1").
  const host = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) {
    throw new SsrfBlockedError('URL has no host', 'no-host', rawUrl);
  }

  // Honor deny-list globs.
  for (const pattern of options.denyHosts ?? []) {
    if (matchHostGlob(host, pattern.toLowerCase())) {
      throw new SsrfBlockedError(
        `Host "${host}" is in the configured deny list (matches "${pattern}")`,
        'deny-host-glob',
        rawUrl,
      );
    }
  }

  // If the host is an IP literal, check it directly — no DNS needed.
  if (net.isIP(host)) {
    if (!isPublicIp(host)) {
      throw new SsrfBlockedError(
        `URL points at a non-public IP: ${host}`,
        'private-ip-literal',
        rawUrl,
      );
    }
    return parsed.toString();
  }

  // Otherwise resolve and verify every address is public.
  const resolver = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw new SsrfBlockedError(
      `DNS resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      'dns-error',
      rawUrl,
    );
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(
      `DNS returned no addresses for ${host}`,
      'dns-empty',
      rawUrl,
    );
  }
  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new SsrfBlockedError(
        `Host ${host} resolves to non-public IP ${addr}`,
        'private-ip-resolved',
        rawUrl,
      );
    }
  }

  return parsed.toString();
}

/**
 * Default DNS resolver: returns every A + AAAA record for the hostname.
 * Separated from assertUrlIsSafe so tests can inject a stub.
 */
async function defaultResolve(hostname: string): Promise<string[]> {
  const out: string[] = [];
  // Both families — don't let a host sneak in a private IPv6 while we only
  // checked IPv4.
  const tasks: Promise<void>[] = [
    dns.resolve4(hostname).then(
      (v4) => {
        out.push(...v4);
      },
      () => {
        // no A records — ignore, IPv6 may still resolve
      },
    ),
    dns.resolve6(hostname).then(
      (v6) => {
        out.push(...v6);
      },
      () => {
        // no AAAA records
      },
    ),
  ];
  await Promise.all(tasks);
  return out;
}

/**
 * Is this IP address a publicly-routable unicast address?
 * False for loopback, link-local, private, unspecified, multicast, reserved.
 */
export function isPublicIp(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) return isPublicIpv4(addr);
  if (family === 6) return isPublicIpv6(addr);
  return false;
}

function isPublicIpv4(addr: string): boolean {
  const parts = addr.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 — unspecified / current network
  if (a === 0) return false;
  // 10.0.0.0/8 — RFC 1918 private
  if (a === 10) return false;
  // 127.0.0.0/8 — loopback
  if (a === 127) return false;
  // 169.254.0.0/16 — link-local + cloud metadata (169.254.169.254)
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12 — RFC 1918 private
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24, 192.0.2.0/24 — IETF / TEST-NET-1
  if (a === 192 && b === 0) return false;
  // 192.168.0.0/16 — RFC 1918 private
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15 — benchmark
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 198.51.100.0/24 — TEST-NET-2
  if (a === 198 && b === 51) return false;
  // 203.0.113.0/24 — TEST-NET-3
  if (a === 203 && b === 0) return false;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return false;
  // 240.0.0.0/4 — reserved / 255.255.255.255 broadcast
  if (a >= 240) return false;

  return true;
}

function isPublicIpv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  // Unspecified :: — note the full-zero canonical form is "::".
  if (lower === '::' || lower === '::0') return false;
  // Loopback ::1
  if (lower === '::1') return false;
  // IPv4-mapped in dotted form (::ffff:a.b.c.d) — check the embedded IPv4.
  const v4mappedDotted = lower.match(/^::ffff:([\d.]+)$/);
  if (v4mappedDotted && v4mappedDotted[1]) {
    return isPublicIpv4(v4mappedDotted[1]);
  }
  // IPv4-mapped in packed-hex form (::ffff:a00:1) — the WHATWG URL parser
  // normalizes the dotted form to hex. Parse two 16-bit hex groups back
  // into a dotted-quad for the recursive check.
  const v4mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4mappedHex && v4mappedHex[1] && v4mappedHex[2]) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPublicIpv4(dotted);
  }
  // Link-local fe80::/10 — matches fe80..febf prefix.
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return false;
  // Unique-local fc00::/7 — matches fc.. or fd.. prefix.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return false;
  // Discard prefix 100::/64 — reserved for discard.
  if (/^100:0{0,4}(:|$)/.test(lower)) return false;

  return true;
}

/**
 * Minimal host glob matcher — supports `*` as a component wildcard.
 * Examples:
 *   "*.internal" matches "foo.internal" and "a.b.internal"
 *   "mail.example.com" matches only that literal
 */
export function matchHostGlob(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
    'i',
  );
  return regex.test(host);
}
