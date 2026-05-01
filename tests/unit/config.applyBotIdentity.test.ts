/**
 * Unit tests — src/config/applyBotIdentity.ts (v1.21.1 hotfix).
 *
 * Verifies that applyBotIdentityToConfig correctly threads identity into:
 *   - cfg.memory.dbPath  → data/<botName>/jarvis.db
 *   - cfg.health.port    → identity.healthPort
 *   - cfg.webapp.port    → identity.webappPort
 *
 * Plus immutability guarantees: input cfg unchanged, output cfg frozen.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { applyBotIdentityToConfig } from '../../src/config/applyBotIdentity.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { BotIdentity, BotName } from '../../src/config/botIdentity.js';

function makeIdentity(name: BotName): BotIdentity {
  return {
    name,
    scope: name === 'ai-jarvis' ? 'full' : 'specialist',
    telegramToken: 'test-token',
    personaPath: `/personas/${name}.md`,
    dataDir: path.resolve('/tmp/data', name),
    webappPort:
      name === 'ai-jarvis' ? 7879 :
      name === 'ai-tony'   ? 7889 :
      name === 'ai-natasha' ? 7899 :
                              7909,
    healthPort:
      name === 'ai-jarvis' ? 7878 :
      name === 'ai-tony'   ? 7888 :
      name === 'ai-natasha' ? 7898 :
                              7908,
    allowedTools: new Set(),
    aliases: [],
  additionalReadPaths: [],
  };
}

function makeBaseCfg(): AppConfig {
  return Object.freeze({
    memory: { dbPath: './data/jarvis.db', maxHistoryMessages: 50 },
    health: { port: 7878 },
    webapp: { port: 7879, publicUrl: '', staticDir: 'public/webapp', initDataMaxAgeSeconds: 86400, initDataMaxFutureSkewSeconds: 300 },
    telegram: { allowedUserIds: [1], botToken: 'legacy-shared-token' },
    // Other fields don't matter for this test; cast through unknown.
  } as unknown) as AppConfig;
}

describe('applyBotIdentityToConfig', () => {
  it('rewrites memory.dbPath to data/<botName>/jarvis.db', () => {
    const cfg = makeBaseCfg();
    const id = makeIdentity('ai-jarvis');
    const out = applyBotIdentityToConfig(cfg, id);
    expect(out.memory.dbPath).toBe(path.join(id.dataDir, 'jarvis.db'));
  });

  it('rewrites health.port to identity.healthPort', () => {
    const cfg = makeBaseCfg();
    const id = makeIdentity('ai-tony');
    const out = applyBotIdentityToConfig(cfg, id);
    expect(out.health.port).toBe(7888);
  });

  it('rewrites webapp.port to identity.webappPort', () => {
    const cfg = makeBaseCfg();
    const id = makeIdentity('ai-natasha');
    const out = applyBotIdentityToConfig(cfg, id);
    expect(out.webapp.port).toBe(7899);
  });

  it('rewrites telegram.botToken to identity.telegramToken', () => {
    const cfg = makeBaseCfg();
    const id = { ...makeIdentity('ai-tony'), telegramToken: 'tony-only-token' };
    const out = applyBotIdentityToConfig(cfg, id);
    expect(out.telegram.botToken).toBe('tony-only-token');
    expect(out.telegram.botToken).not.toBe(cfg.telegram.botToken);
  });

  it('does not mutate the input cfg', () => {
    const cfg = makeBaseCfg();
    const id = makeIdentity('ai-bruce');
    applyBotIdentityToConfig(cfg, id);
    expect(cfg.memory.dbPath).toBe('./data/jarvis.db');
    expect(cfg.health.port).toBe(7878);
    expect(cfg.webapp.port).toBe(7879);
    expect(cfg.telegram.botToken).toBe('legacy-shared-token');
  });

  it('returns a frozen object', () => {
    const cfg = makeBaseCfg();
    const id = makeIdentity('ai-jarvis');
    const out = applyBotIdentityToConfig(cfg, id);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('produces unique dbPath/healthPort/webappPort across all 4 bots', () => {
    const cfg = makeBaseCfg();
    const dbPaths = new Set<string>();
    const healthPorts = new Set<number>();
    const webappPorts = new Set<number>();
    for (const name of ['ai-jarvis', 'ai-tony', 'ai-natasha', 'ai-bruce'] as const) {
      const out = applyBotIdentityToConfig(cfg, makeIdentity(name));
      dbPaths.add(out.memory.dbPath);
      healthPorts.add(out.health.port);
      webappPorts.add(out.webapp.port);
    }
    expect(dbPaths.size).toBe(4);
    expect(healthPorts.size).toBe(4);
    expect(webappPorts.size).toBe(4);
  });
});
