/**
 * applyBotIdentityToConfig — v1.21.1 hotfix (Avengers production-wiring closure).
 *
 * Background: v1.21.0 shipped BotIdentity with `dataDir`, `webappPort`, and
 * `healthPort` fields, plus a per-bot data migration that renames legacy
 * `data/jarvis.db` → `data/<botName>/jarvis.db`. But the runtime config
 * (`cfg.memory.dbPath`, `cfg.health.port`, `cfg.webapp.port`) was NEVER
 * rewritten with the resolved identity. Result: ai-jarvis migrated its data
 * to `data/ai-jarvis/jarvis.db`, then opened `./data/jarvis.db` per cfg —
 * which created a fresh empty DB (data loss avoided only because rename is
 * non-destructive). Concurrently, ai-tony hit `EADDRINUSE` on health port
 * 7878 because both bots loaded the same hardcoded value.
 *
 * This helper is the missing link: takes a frozen `cfg` + resolved
 * `identity`, deep-clones cfg, rewrites the per-bot fields from identity,
 * re-freezes, and returns the new cfg.
 *
 * Trap-class context: this is the 6th iteration of the v1.18.0 trap class
 * "interface declared, runtime stub". Static test
 * `tests/static/v1.21-wiring-reachable.test.ts` is extended to cover this
 * helper too — must have ≥1 production caller in src tree.
 *
 * BINDING: must run AFTER `resolveBotIdentity()` AND AFTER
 * `runBotDataMigration()`, but BEFORE `initMemory()` opens the DB.
 *
 * @param cfg       The loaded (frozen) AppConfig from loadConfig().
 * @param identity  The resolved BotIdentity from resolveBotIdentity().
 * @returns         A new frozen AppConfig with per-bot path/port rewrites.
 */

import path from 'node:path';
import type { AppConfig } from './schema.js';
import type { BotIdentity } from './botIdentity.js';

export function applyBotIdentityToConfig(cfg: AppConfig, identity: BotIdentity): AppConfig {
  // Deep clone the frozen cfg so we can mutate.
  // structuredClone is cheaper than JSON round-trip and preserves
  // Date/Set/Map/etc., though our config is plain JSON-ish.
  const writable = structuredClone(cfg) as AppConfig;

  // (a) memory.dbPath → data/<botName>/jarvis.db
  // Cascades to src/index.ts:236 `const dataDir = path.dirname(cfg.memory.dbPath)`.
  writable.memory.dbPath = path.join(identity.dataDir, 'jarvis.db');

  // (b) health.port → per-bot health port (prevents EADDRINUSE between bots)
  writable.health.port = identity.healthPort;

  // (c) webapp.port → per-bot webapp port (prevents EADDRINUSE between bots)
  writable.webapp.port = identity.webappPort;

  // (d) telegram.botToken → per-bot Telegram token (prevents two bots
  // talking to the same Telegram account; the legacy ENV:TELEGRAM_BOT_TOKEN
  // env-ref resolves to ai-jarvis's token only).
  writable.telegram.botToken = identity.telegramToken;

  return Object.freeze(writable) as AppConfig;
}
