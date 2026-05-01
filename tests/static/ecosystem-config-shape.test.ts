/**
 * Static test — ecosystem.config.cjs shape (v1.21.0 Pillar 3 D11 + D12;
 * v1.21.1 expanded to 4-bot Avengers ensemble).
 *
 * Assertions:
 *   1. The file exports an object with an `apps` array.
 *   2. apps has exactly BOT_NAMES.length entries (currently 4 for v1.21.1).
 *   3. Each app entry's env.BOT_NAME is a member of the BOT_NAMES closed set.
 *   4. Each app entry has a unique name.
 *   5. Each app entry declares out_file and error_file.
 *   6. Each app entry has autorestart === true.
 *   7. All out_file / error_file paths are under data/<botName>/logs/.
 *
 * Pattern: read the CJS file via createRequire (avoids ESM/CJS import mix).
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_NAMES } from '../../src/config/botIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const ECOSYSTEM_PATH = path.resolve(__dirname, '../../ecosystem.config.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ecosystem = require(ECOSYSTEM_PATH) as { apps: Array<Record<string, unknown>> };

describe('ecosystem.config.cjs shape (ADR 021 Pillar 3)', () => {
  it('exports an object with an apps array', () => {
    expect(ecosystem).toBeDefined();
    expect(typeof ecosystem).toBe('object');
    expect(Array.isArray(ecosystem.apps)).toBe(true);
  });

  it('apps array has one entry per BOT_NAMES member', () => {
    expect(ecosystem.apps).toHaveLength(BOT_NAMES.length);
  });

  it('each app entry has a unique name', () => {
    const names = ecosystem.apps.map((app) => app['name'] as string);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('each app entry has env.BOT_NAME in the BOT_NAMES closed set', () => {
    for (const app of ecosystem.apps) {
      const env = app['env'] as Record<string, unknown> | undefined;
      expect(env).toBeDefined();
      const botName = env?.['BOT_NAME'] as string | undefined;
      expect(botName).toBeDefined();
      expect((BOT_NAMES as readonly string[]).includes(botName as string)).toBe(true);
    }
  });

  it('each app entry has out_file declared', () => {
    for (const app of ecosystem.apps) {
      expect(app['out_file']).toBeDefined();
    }
  });

  it('each app entry has error_file declared', () => {
    for (const app of ecosystem.apps) {
      expect(app['error_file']).toBeDefined();
    }
  });

  it('each app has autorestart === true', () => {
    for (const app of ecosystem.apps) {
      expect(app['autorestart']).toBe(true);
    }
  });

  it('out_file is under data/<botName>/logs/', () => {
    for (const app of ecosystem.apps) {
      const env = app['env'] as Record<string, unknown>;
      const botName = env['BOT_NAME'] as string;
      const outFile = app['out_file'] as string;
      expect(outFile).toContain(`data/${botName}/logs/`);
    }
  });

  it('error_file is under data/<botName>/logs/', () => {
    for (const app of ecosystem.apps) {
      const env = app['env'] as Record<string, unknown>;
      const botName = env['BOT_NAME'] as string;
      const errorFile = app['error_file'] as string;
      expect(errorFile).toContain(`data/${botName}/logs/`);
    }
  });
});
