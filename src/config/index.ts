import fs from 'fs';
import path from 'path';
import { AppConfig, ConfigSchema, BUILT_IN_READ_DENY_GLOBS } from './schema.js';
import { resolveEnvRefs } from './resolveEnvRefs.js';

// dotenv loaded by src/index.ts before config.load() is called
// We import here for test-time convenience
import 'dotenv/config';

let _config: AppConfig | null = null;

/**
 * Load, validate, and freeze the application config.
 * Called once at boot. Throws on any invalid value — fail fast.
 */
export function loadConfig(configPath?: string): AppConfig {
  const filePath =
    configPath ?? process.env['CONFIG_PATH'] ?? path.resolve(process.cwd(), 'config/config.json');

  let raw: unknown;
  try {
    let text = fs.readFileSync(filePath, 'utf8');
    // Strip UTF-8 BOM if present — editors (Notepad, VS Code on Windows) can save
    // JSON with a leading BOM which trips JSON.parse.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(
      `Failed to read config file at "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resolve ENV: references before zod validation
  let resolved: unknown;
  try {
    resolved = resolveEnvRefs(raw);
  } catch (err) {
    throw new Error(
      `Config env-ref resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // v1.0 → v1.1 backward-compat migration:
  // If config.ai has top-level `provider` + `model` (v1.0 shape) but no
  // defaultProvider/defaultModel, migrate them and log a warning.
  const rawAi = (resolved as Record<string, unknown>)['ai'] as Record<string, unknown> | undefined;
  if (rawAi && rawAi['model'] && !rawAi['defaultModel']) {
    const legacyModel = rawAi['model'] as string;
    const legacyProvider = (rawAi['provider'] as string | undefined) ?? 'anthropic';
    // Map 'anthropic' provider name to our internal 'claude' name
    const mappedProvider = legacyProvider === 'anthropic' ? 'claude' : legacyProvider;
    rawAi['defaultProvider'] = mappedProvider;
    rawAi['defaultModel'] = legacyModel;
    // eslint-disable-next-line no-console
    console.warn(
      `[config] v1.0 ai.model="${legacyModel}" migrated to defaultProvider="${mappedProvider}", defaultModel="${legacyModel}". ` +
        'Update your config.json to the v1.1 shape to silence this warning.',
    );
  }

  // Validate with zod
  const result = ConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const cfg = result.data;

  // Validate health port
  if (cfg.health.port < 1024 || cfg.health.port > 65535) {
    throw new Error(`config.health.port must be 1024–65535, got ${cfg.health.port}`);
  }

  // Validate: web.enabled=true requires non-empty allowedHosts
  if (cfg.web.enabled && cfg.web.allowedHosts.length === 0) {
    throw new Error(
      'config.web.enabled is true but config.web.allowedHosts is empty. ' +
        'Add at least one host or set web.enabled=false.',
    );
  }

  // Merge built-in readDenyGlobs (user config cannot shrink below defaults)
  const mergedDenyGlobs = [
    ...new Set([...BUILT_IN_READ_DENY_GLOBS, ...cfg.filesystem.readDenyGlobs]),
  ];
  cfg.filesystem.readDenyGlobs = mergedDenyGlobs;

  // Validate allowedPaths: each must exist and be realpathable
  // Note: we validate existence here; the safety module does per-call realpath
  // Boot fails if an allowed root does not exist (ARCH §14 rule 1)
  const { realpathSync } = fs;
  const validatedPaths: string[] = [];
  for (const p of cfg.filesystem.allowedPaths) {
    try {
      const real = realpathSync.native(p);
      validatedPaths.push(real);
    } catch {
      throw new Error(
        `config.filesystem.allowedPaths entry "${p}" does not exist or cannot be resolved. ` +
          `Create the directory or remove it from the config.`,
      );
    }
  }
  cfg.filesystem.allowedPaths = validatedPaths;

  // Freeze to prevent mutation
  _config = Object.freeze(cfg) as AppConfig;
  return _config;
}

/**
 * Returns the already-loaded config instance.
 * Throws if loadConfig() has not been called.
 */
export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error('Config not loaded. Call loadConfig() before getConfig().');
  }
  return _config;
}

/** For testing: reset the singleton */
export function _resetConfig(): void {
  _config = null;
}

export type { AppConfig };
