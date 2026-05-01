/**
 * Pino redact paths — covers all secret shapes that might appear in log records.
 * These are dot-path patterns as understood by pino's redact option.
 */
export const REDACT_PATHS: string[] = [
  // Top-level secret fields
  'apiKey',
  'token',
  'botToken',
  'secret',
  'password',
  'authorization',
  'accessToken',
  'refreshToken',
  // Nested patterns
  '*.apiKey',
  '*.token',
  '*.botToken',
  '*.secret',
  '*.password',
  '*.authorization',
  '*.accessToken',
  '*.refreshToken',
  // Env-var style
  'env.*_KEY',
  'env.*_TOKEN',
  'env.*_SECRET',
  // Auth headers
  'headers.authorization',
  'headers.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
];
