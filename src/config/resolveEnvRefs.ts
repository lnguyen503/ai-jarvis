/**
 * Resolves ENV:VAR_NAME tokens in config values.
 * Config JSON can reference env vars as "ENV:TELEGRAM_BOT_TOKEN"
 * so secrets never live in config.json.
 */
export function resolveEnvRefs(obj: unknown): unknown {
  if (typeof obj === 'string') {
    if (obj.startsWith('ENV:')) {
      const varName = obj.slice(4);
      const value = process.env[varName];
      if (!value) {
        throw new Error(
          `Config references environment variable "${varName}" which is not set. ` +
            `Add it to your .env file.`,
        );
      }
      return value;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(resolveEnvRefs);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvRefs(value);
    }
    return result;
  }

  return obj;
}
