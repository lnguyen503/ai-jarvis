/**
 * Static test: buildToolContext SSOT enforcement (v1.21.0 ADR 021 F1).
 *
 * Ensures that:
 *   1. src/tools/buildToolContext.ts exists and exports `buildToolContext`.
 *   2. buildToolContext is callable and returns a ToolContext-shaped object.
 *   3. No NEW direct ToolContext object literals exist in src/** outside of
 *      the two pre-existing sites in src/agent/index.ts (lines 816 + 1038)
 *      that are tracked for migration in v1.22.0.
 *
 * Rationale (F1 6th-iter trap pre-emption):
 *   Adding a new field to ToolContext requires threading it through every
 *   construction site. When construction is scattered (direct literals), new
 *   fields are silently undefined on paths that forget to set them. This test
 *   makes the centralized factory the only allowed construction point in new
 *   code, so a new field only needs to be threaded to ONE place.
 *
 * Pre-existing exemptions (tracked, to be migrated in v1.22.0):
 *   - src/agent/index.ts line ~816 (turn toolCtx)
 *   - src/agent/index.ts line ~1038 (runConfirmedCommand toolCtx)
 *   - src/commands/search.ts line ~66 (web_search command toolCtx)
 *   - src/commands/coachSubcommands.ts line ~447 (coach subcommand toolCtx)
 *
 * Any new file that introduces a direct `toolCtx = {` or `ToolContext = {`
 * construction outside of src/tools/buildToolContext.ts is a FAIL.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../../src');

// ---------------------------------------------------------------------------
// File scanner
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Test: factory module exists
// ---------------------------------------------------------------------------

describe('tools.buildToolContext — SSOT factory (ADR 021 F1)', () => {
  const factoryPath = path.resolve(SRC_ROOT, 'tools/buildToolContext.ts');

  it('BTC-1: src/tools/buildToolContext.ts exists', () => {
    let content: string;
    try {
      content = readFileSync(factoryPath, 'utf8');
    } catch {
      throw new Error('src/tools/buildToolContext.ts does not exist — factory must be created (ADR 021 F1)');
    }
    expect(content).toContain('export function buildToolContext');
  });

  it('BTC-2: buildToolContext is importable and callable', async () => {
    const { buildToolContext } = await import('../../src/tools/buildToolContext.js');
    expect(typeof buildToolContext).toBe('function');
  });

  it('BTC-3: buildToolContext returns a ToolContext-shaped object with required fields', async () => {
    const { buildToolContext } = await import('../../src/tools/buildToolContext.js');
    const { loadConfig } = await import('../../src/config/index.js');

    // Minimal viable params — only required fields
    const cfg = loadConfig();
    const mockMemory = {} as import('../../src/memory/index.js').MemoryApi;
    const mockSafety = {} as import('../../src/safety/index.js').SafetyApi;
    const mockLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => mockLogger,
    } as unknown as import('pino').Logger;

    const ctx = buildToolContext({
      sessionId: 1,
      chatId: 100,
      logger: mockLogger,
      config: cfg,
      memory: mockMemory,
      safety: mockSafety,
      abortSignal: new AbortController().signal,
    });

    expect(ctx.sessionId).toBe(1);
    expect(ctx.chatId).toBe(100);
    expect(ctx.config).toBe(cfg);
    expect(ctx.memory).toBe(mockMemory);
    expect(ctx.safety).toBe(mockSafety);
    expect(ctx.botIdentity).toBeUndefined(); // optional — not set in this call
  });

  it('BTC-4: buildToolContext passes botIdentity through when provided', async () => {
    const { buildToolContext } = await import('../../src/tools/buildToolContext.js');
    const { loadConfig } = await import('../../src/config/index.js');
    const cfg = loadConfig();

    const mockIdentity: import('../../src/config/botIdentity.js').BotIdentity = {
      name: 'ai-jarvis',
      scope: 'full',
      telegramToken: 'test-token',
      personaPath: '/persona.md',
      dataDir: '/data/ai-jarvis',
      webappPort: 7879,
      healthPort: 7878,
      allowedTools: new Set(['read_file']),
      aliases: [],
    additionalReadPaths: [],
    };

    const ctx = buildToolContext({
      sessionId: 1,
      chatId: 200,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: function() { return this; } } as unknown as import('pino').Logger,
      config: cfg,
      memory: {} as import('../../src/memory/index.js').MemoryApi,
      safety: {} as import('../../src/safety/index.js').SafetyApi,
      abortSignal: new AbortController().signal,
      botIdentity: mockIdentity,
    });

    expect(ctx.botIdentity).toBe(mockIdentity);
    expect(ctx.botIdentity?.name).toBe('ai-jarvis');
    expect(ctx.botIdentity?.scope).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Test: no new direct ToolContext literal constructions in src/
// ---------------------------------------------------------------------------

describe('tools.buildToolContext — no new direct literal constructions (ADR 021 F1)', () => {
  /**
   * Pre-existing exempted files — tracked for migration in v1.22.0.
   * Any file in this set is allowed to have direct toolCtx = { literals.
   * New files are NOT allowed.
   */
  const KNOWN_EXEMPTED_FILES = new Set([
    // turn() + runConfirmedCommand() in agent/index.ts (2 sites)
    path.resolve(SRC_ROOT, 'agent/index.ts'),
    // web_search command — 1 site
    path.resolve(SRC_ROOT, 'commands/search.ts'),
    // coach subcommands — 1 site
    path.resolve(SRC_ROOT, 'commands/coachSubcommands.ts'),
    // The factory itself is the canonical construction point
    path.resolve(SRC_ROOT, 'tools/buildToolContext.ts'),
  ]);

  it('BTC-5: no NEW files introduce direct ToolContext object literals (sessionId + chatId + logger)', () => {
    const allFiles = collectTsFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of allFiles) {
      // Skip known pre-existing exempted files
      if (KNOWN_EXEMPTED_FILES.has(file)) continue;

      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      // Detect ToolContext literal patterns:
      // A direct object literal that has sessionId, chatId, AND logger co-located
      // is a strong signal it's a ToolContext construction.
      // We check for: `const toolCtx = {` or `const ctx = {` followed by sessionId
      // within the next 5 lines.
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Skip comments
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;

        // Detect `const <name>: ToolContext = {` or `const <name> = {` near sessionId/chatId
        if (/const\s+\w+\s*(?::\s*ToolContext\s*)?\s*=\s*\{/.test(line)) {
          // Check if the next 10 lines contain BOTH sessionId and chatId (ToolContext signature)
          const window = lines.slice(i, i + 10).join('\n');
          if (/\bsessionId\b/.test(window) && /\bchatId\b/.test(window) && /\blogger\b/.test(window)) {
            const relPath = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
            violations.push(`${relPath}:${i + 1} — direct ToolContext literal (use buildToolContext)`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `BTC-5 FAIL — New direct ToolContext literal constructions found in src/:\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nUse buildToolContext() from src/tools/buildToolContext.ts instead.\n` +
          `Pre-existing sites in src/agent/index.ts are exempt (tracked for v1.22.0 migration).`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
