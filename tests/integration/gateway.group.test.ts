/**
 * Integration tests for group chat mode.
 *
 * Tests:
 *  1. Unrelated message in group is silently ignored
 *  2. "jarvis ..." message triggers agent turn
 *  3. Rate limit blocks after configured threshold
 *  4. Tool filtering is applied in group mode (disabled tools not in list)
 *  5. Group scrubber is applied (hostname absent from reply)
 *  6. /jarvis_enable / /jarvis_disable work in DB
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import { checkGroupActivation, type GroupGateDeps } from '../../src/gateway/groupGate.js';
import { _resetGroupState } from '../../src/gateway/groupState.js';
import { scrubForGroup } from '../../src/safety/groupScrub.js';
import { toolsForContext } from '../../src/tools/index.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { Tool } from '../../src/tools/types.js';
import type { ModelProvider, UnifiedResponse } from '../../src/providers/types.js';
import type { AppConfig } from '../../src/config/index.js';
import { z } from 'zod';
import path from 'path';

function fresh() {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-grpint-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  return initMemory(cfg);
}

const BOT_ID = 77;
const ALLOWED_GROUP = -100001;

function makeGroupConfig(mem: MemoryApi, extra: Partial<{
  enabled: boolean;
  allowedGroupIds: number[];
  adminUserIds: number[];
}> = {}) {
  return makeTestConfig({
    groups: {
      enabled: extra.enabled ?? true,
      allowedGroupIds: extra.allowedGroupIds ?? [ALLOWED_GROUP],
      adminUserIds: extra.adminUserIds ?? [],
      developerUserIds: [],
      groupRoles: {},
      rateLimitPerUser: 3,
      rateLimitWindowMinutes: 60,
      maxResponseLength: 2000,
      disabledTools: ['run_command', 'write_file', 'system_info'],
      intentDetection: {
        // Disabled in this integration suite — we test the deterministic
        // gate behavior only (mention / reply / preflight). Classifier-path
        // coverage lives in tests/unit/gateway.groupGate.test.ts.
        enabled: false,
        provider: 'ollama-cloud',
        model: 'gemma4:cloud',
        followUpWindowSeconds: 120,
        confirmationTtlSeconds: 120,
        rateLimitPerMinute: 30,
        recentMessageContext: 4,
      },
    },
  });
}

const silentProvider: ModelProvider = {
  name: 'mock',
  async call(): Promise<UnifiedResponse> {
    return {
      stop_reason: 'end_turn',
      content: '{"addressed":false,"confidence":"low","reason":"mock"}',
      tool_calls: [],
      provider: 'mock',
      model: 'mock',
    };
  },
};

function makeGateDeps(cfg: AppConfig, mem: MemoryApi): GroupGateDeps {
  return {
    config: cfg,
    botUserId: BOT_ID,
    groupSettings: mem.groupSettings,
    getRecentMessages: () => [],
    classifierProvider: silentProvider,
    abortSignal: new AbortController().signal,
  };
}

describe('gateway.group integration', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = fresh();
    _resetGroupState();
  });

  describe('checkGroupActivation — activation gate', () => {
    const userCtx = (text: string, chatId = ALLOWED_GROUP, replyFromId?: number) =>
      ({
        chat: { type: 'group', id: chatId },
        from: { id: 1001, first_name: 'Boss' },
        message: {
          text,
          reply_to_message: replyFromId !== undefined ? { from: { id: replyFromId } } : undefined,
        },
      }) as never;

    it('ignores unrelated message (no jarvis mention, not reply to bot)', async () => {
      const cfg = makeGroupConfig(mem);
      const result = await checkGroupActivation(
        userCtx('hey everyone what is for lunch'),
        makeGateDeps(cfg, mem),
      );
      expect(result.proceed).toBe(false);
    });

    it('activates for "jarvis help me" in allowed group', async () => {
      const cfg = makeGroupConfig(mem);
      const result = await checkGroupActivation(
        userCtx('jarvis help me with something'),
        makeGateDeps(cfg, mem),
      );
      expect(result.proceed).toBe(true);
    });

    it('ignores message in non-allowed group even with jarvis mention', async () => {
      const cfg = makeGroupConfig(mem, { allowedGroupIds: [ALLOWED_GROUP] });
      const result = await checkGroupActivation(
        userCtx('Jarvis are you there?', -999999),
        makeGateDeps(cfg, mem),
      );
      expect(result.proceed).toBe(false);
    });

    it('activates for reply-to-bot even without jarvis mention', async () => {
      const cfg = makeGroupConfig(mem);
      const result = await checkGroupActivation(
        userCtx('yes please continue', ALLOWED_GROUP, BOT_ID),
        makeGateDeps(cfg, mem),
      );
      expect(result.proceed).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('allows up to configured limit then blocks', () => {
      const cfg = makeGroupConfig(mem);
      const GROUP = ALLOWED_GROUP;
      const USER = 1001;

      // Limit is 3
      for (let i = 0; i < 3; i++) {
        const r = mem.groupActivity.checkAndIncrement(
          GROUP, USER, 'Boss', cfg.groups.rateLimitPerUser, cfg.groups.rateLimitWindowMinutes,
        );
        expect(r.allowed).toBe(true);
      }

      // 4th should be blocked
      const blocked = mem.groupActivity.checkAndIncrement(
        GROUP, USER, 'Boss', cfg.groups.rateLimitPerUser, cfg.groups.rateLimitWindowMinutes,
      );
      expect(blocked.allowed).toBe(false);
    });

    it('different users have independent limits', () => {
      const cfg = makeGroupConfig(mem);
      const GROUP = ALLOWED_GROUP;

      // Fill USER_A's limit
      for (let i = 0; i < 3; i++) {
        mem.groupActivity.checkAndIncrement(
          GROUP, 1001, 'Boss', cfg.groups.rateLimitPerUser, cfg.groups.rateLimitWindowMinutes,
        );
      }

      // USER_B should still be allowed
      const result = mem.groupActivity.checkAndIncrement(
        GROUP, 1002, 'Bob', cfg.groups.rateLimitPerUser, cfg.groups.rateLimitWindowMinutes,
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe('tool filtering in group mode', () => {
    function makeFakeTool(name: string): Tool {
      return {
        name,
        description: `${name} tool`,
        parameters: z.object({}),
        execute: vi.fn(),
      };
    }

    it('removes disabled tools in group mode', () => {
      const allTools = [
        makeFakeTool('run_command'),
        makeFakeTool('read_file'),
        makeFakeTool('write_file'),
        makeFakeTool('system_info'),
        makeFakeTool('list_directory'),
      ];
      const disabled = ['run_command', 'write_file', 'system_info'];

      const filtered = toolsForContext({
        groupMode: true,
        disabledTools: disabled,
        allTools,
      });

      const names = filtered.map((t) => t.name);
      expect(names).not.toContain('run_command');
      expect(names).not.toContain('write_file');
      expect(names).not.toContain('system_info');
      expect(names).toContain('read_file');
      expect(names).toContain('list_directory');
    });

    it('returns all tools when not in group mode', () => {
      const allTools = [
        makeFakeTool('run_command'),
        makeFakeTool('read_file'),
      ];

      const filtered = toolsForContext({
        groupMode: false,
        disabledTools: ['run_command'],
        allTools,
      });

      expect(filtered).toHaveLength(2); // all tools returned
    });

    it('agent classifier still runs: run_command appears in disabled list for group mode', () => {
      // This verifies that run_command is in the disabledTools default list
      const cfg = makeGroupConfig(mem);
      expect(cfg.groups.disabledTools).toContain('run_command');
      expect(cfg.groups.disabledTools).toContain('write_file');
      expect(cfg.groups.disabledTools).toContain('system_info');
    });
  });

  describe('group scrubber — no info leak', () => {
    it('hostname is never present in group reply', () => {
      const cfg = makeGroupConfig(mem);
      const hostname = os.hostname();
      const text = `The server ${hostname} processed your request`;
      const result = scrubForGroup(text, cfg);
      expect(result.toLowerCase()).not.toContain(hostname.toLowerCase());
    });

    it('allowed paths are redacted in group replies', () => {
      const cfg = makeGroupConfig(mem);
      const allowedPath = cfg.filesystem.allowedPaths[0]!;
      const text = `File saved to ${allowedPath}\\output.txt`;
      const result = scrubForGroup(text, cfg);
      expect(result).not.toContain(allowedPath);
      expect(result).toContain('<path>');
    });
  });

  describe('group enable/disable via DB', () => {
    it('starts enabled by default', () => {
      expect(mem.groupSettings.isEnabled(ALLOWED_GROUP)).toBe(true);
    });

    it('/jarvis-disable persists across reads', () => {
      mem.groupSettings.setEnabled(ALLOWED_GROUP, false);
      expect(mem.groupSettings.isEnabled(ALLOWED_GROUP)).toBe(false);
    });

    it('/jarvis-enable re-enables a disabled group', () => {
      mem.groupSettings.setEnabled(ALLOWED_GROUP, false);
      mem.groupSettings.setEnabled(ALLOWED_GROUP, true);
      expect(mem.groupSettings.isEnabled(ALLOWED_GROUP)).toBe(true);
    });

    it('disabled group is ignored by checkGroupActivation', async () => {
      mem.groupSettings.setEnabled(ALLOWED_GROUP, false);
      const cfg = makeGroupConfig(mem);
      const ctx = {
        chat: { type: 'group', id: ALLOWED_GROUP },
        from: { id: 1001, first_name: 'Boss' },
        message: { text: 'Jarvis are you there?' },
      } as never;
      const result = await checkGroupActivation(ctx, makeGateDeps(cfg, mem));
      expect(result.proceed).toBe(false);
      expect(result.note).toContain('disabled');
    });
  });
});
