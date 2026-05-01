/**
 * Secret scrubber (ARCH §9, C7/C8).
 * Invoked by the tools dispatcher on EVERY tool output before:
 *   - Persisting to messages.tool_output / command_log.stdout_preview
 *   - Returning the result to the agent loop (Claude context)
 *   - Sending to Telegram
 *
 * Side-effect free: returns a new string with secrets replaced.
 */

interface ScrubPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const SCRUB_PATTERNS: ScrubPattern[] = [
  {
    name: 'ANTHROPIC_KEY',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/gi,
    replacement: '[REDACTED:ANTHROPIC_KEY]',
  },
  {
    name: 'OPENAI_KEY',
    // Generic OpenAI-style sk-... (but not sk-ant- which is above)
    pattern: /sk-(?!ant-)[A-Za-z0-9]{20,}/gi,
    replacement: '[REDACTED:OPENAI_KEY]',
  },
  {
    name: 'GITHUB_PAT',
    pattern: /gh[pousr]_[A-Za-z0-9]{30,}/gi,
    replacement: '[REDACTED:GITHUB_PAT]',
  },
  {
    name: 'GOOGLE_API_KEY',
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: '[REDACTED:GOOGLE_API_KEY]',
  },
  {
    name: 'AWS_ACCESS_KEY',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED:AWS_ACCESS_KEY]',
  },
  {
    name: 'AWS_SECRET',
    // AWS secrets are context-specific; we scrub when preceded by an obvious
    // "aws_secret" or "aws_secret_access_key" marker. A bare 40-char token
    // is handled by HEX_BLOB below to avoid false positives on common hashes.
    pattern:
      /(aws[_\s-]*secret[_\s-]*(?:access[_\s-]*)?key\s*[:=]\s*)['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
    replacement: '$1[REDACTED:AWS_SECRET]',
  },
  {
    name: 'SLACK_TOKEN',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/gi,
    replacement: '[REDACTED:SLACK_TOKEN]',
  },
  {
    name: 'JWT',
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[REDACTED:JWT]',
  },
  {
    name: 'BEARER_TOKEN',
    pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
    replacement: 'Bearer [REDACTED:BEARER_TOKEN]',
  },
  {
    name: 'PEM_PRIVATE_KEY',
    pattern:
      /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+|DSA\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/gi,
    replacement: '[REDACTED:PEM_PRIVATE_KEY]',
  },
  // --- V-16: Additional provider and token patterns ---
  {
    name: 'STRIPE_SECRET_KEY',
    pattern: /sk_(live|test)_[A-Za-z0-9]{24,}/gi,
    replacement: '[REDACTED:STRIPE_KEY]',
  },
  {
    name: 'STRIPE_RESTRICTED_KEY',
    pattern: /rk_live_[A-Za-z0-9]{24,}/gi,
    replacement: '[REDACTED:STRIPE_RKEY]',
  },
  {
    name: 'STRIPE_PUBLISHABLE_KEY',
    // pk_live_ keys are technically public but still worth scrubbing in tool output
    pattern: /pk_live_[A-Za-z0-9]{24,}/gi,
    replacement: '[REDACTED:STRIPE_PKEY]',
  },
  {
    name: 'GOOGLE_OAUTH_SECRET',
    pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:GOOGLE_OAUTH]',
  },
  {
    name: 'NPM_TOKEN',
    pattern: /npm_[A-Za-z0-9]{36}/g,
    replacement: '[REDACTED:NPM_TOKEN]',
  },
  {
    name: 'HUGGINGFACE_TOKEN',
    pattern: /hf_[A-Za-z0-9]{34}/g,
    replacement: '[REDACTED:HF_TOKEN]',
  },
  {
    name: 'TELEGRAM_BOT_TOKEN',
    // Format: <6-12 digits>:<35-char alphanumeric+_-> (e.g. 123456789:ABCDEF...)
    pattern: /\d{6,12}:[A-Za-z0-9_-]{35,}/g,
    replacement: '[REDACTED:TELEGRAM_BOT_TOKEN]',
  },
  {
    name: 'GENERIC_API_KEY_HEADER',
    // Catches x-api-key: value, api_key=value, apikey=value patterns
    pattern: /(?:api[_-]?key|x-api-key|apikey)\s*[:=]\s*['"]?([A-Za-z0-9_-]{20,})['"]?/gi,
    replacement: '[REDACTED:API_KEY_HEADER]',
  },
  {
    name: 'DB_URL_PASSWORD',
    // Catches passwords in DB connection strings: postgres://user:PASSWORD@host/db
    pattern:
      /(?:postgres|mysql|mongodb)(?:\+\w+)?:\/\/[^:@\s]+:([^@\s]+)@/gi,
    replacement: '[REDACTED:DB_PASSWORD]@',
  },
  {
    name: 'AUTHORIZATION_BEARER',
    // Catches Authorization: Bearer <token> in HTTP headers (distinct from free-text Bearer)
    pattern: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{10,}/gi,
    replacement: 'Authorization: Bearer [REDACTED:AUTH_BEARER]',
  },
  {
    name: 'HEX_BLOB_40',
    // 40–64 char hex strings used as tokens/secrets.
    // Contextual anchors prevent clobbering git SHAs, checksums, and SRI hashes
    // that a user may legitimately reference. The hex blob is only redacted when:
    //   (a) immediately preceded (with optional whitespace/quotes) by a
    //       secret-context keyword (secret, token, key, password, credential,
    //       auth, passwd) followed by ':' or '=', OR
    //   (b) surrounded by single or double quotes (literal value in config/code).
    // Plain bare hex strings in git log output, diff headers, etc. are left alone.
    //
    // Implementation: use a replace function so the keyword prefix in case (a)
    // is preserved — only the hex portion itself is replaced.
    pattern:
      /(?<=(?:secret|token|key|password|credential|auth|passwd)\s*[:=]\s*['"]?)(?<![A-Fa-f0-9])[A-Fa-f0-9]{40,64}(?![A-Fa-f0-9])|(?<=['"])[A-Fa-f0-9]{40,64}(?=['"])/gi,
    replacement: '[REDACTED:HEX_BLOB]',
  },
];

/**
 * Scrub known secret patterns from text.
 * Returns a new string; never mutates input.
 */
export function scrub(text: string): string {
  // Unicode-normalize before matching (C7: NFC)
  let result = text.normalize('NFC');

  for (const { pattern, replacement } of SCRUB_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

/** Scrub a Record's string values (for data fields in ToolResult) */
export function scrubRecord(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') {
      out[k] = scrub(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
