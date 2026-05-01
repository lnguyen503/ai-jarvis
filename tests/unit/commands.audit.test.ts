/**
 * /audit command tests: admin-only access, formatting, DM-only enforcement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { handleAudit } from '../../src/commands/audit.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { Context } from 'grammy';

const ADMIN_USER_ID = 42;

function makeCtx(userId: number, chatType: 'private' | 'group' | 'supergroup' = 'private'): Context {
  return {
    from: { id: userId, is_bot: false, first_name: 'TestUser' },
    chat: { id: chatType === 'private' ? userId : -100123456, type: chatType, title: chatType !== 'private' ? 'TestGroup' : undefined },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe('commands.audit', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    _resetDb();
    const cfg = makeTestConfig({
      groups: {
        enabled: true,
        allowedGroupIds: [],
        adminUserIds: [ADMIN_USER_ID],
        rateLimitPerUser: 10,
        rateLimitWindowMinutes: 60,
        maxResponseLength: 2000,
        disabledTools: [],
      },
    });
    cfg.memory.dbPath = path.join(cfg.filesystem.allowedPaths[0]!, 'test.db');
    mem = initMemory(cfg);
  });

  it('rejects non-admin with "Admin only."', async () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [ADMIN_USER_ID] } });
    const ctx = makeCtx(999); // non-admin
    await handleAudit(ctx, { config: cfg, memory: mem });
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('Admin only.');
  });

  it('rejects admin in group chat with DM-only warning', async () => {
    const cfg = makeTestConfig({
      groups: {
        enabled: true,
        allowedGroupIds: [],
        adminUserIds: [ADMIN_USER_ID],
        rateLimitPerUser: 10,
        rateLimitWindowMinutes: 60,
        maxResponseLength: 2000,
        disabledTools: [],
      },
    });
    const ctx = makeCtx(ADMIN_USER_ID, 'supergroup');
    await handleAudit(ctx, { config: cfg, memory: mem });
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain('DM only');
  });

  it('returns "No audit log entries yet." when log is empty', async () => {
    const cfg = makeTestConfig({
      groups: {
        enabled: true,
        allowedGroupIds: [],
        adminUserIds: [ADMIN_USER_ID],
        rateLimitPerUser: 10,
        rateLimitWindowMinutes: 60,
        maxResponseLength: 2000,
        disabledTools: [],
      },
    });
    const ctx = makeCtx(ADMIN_USER_ID, 'private');
    await handleAudit(ctx, { config: cfg, memory: mem });
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain('No audit log');
  });

  it('returns audit log entries for admin in DM', async () => {
    const cfg = makeTestConfig({
      groups: {
        enabled: true,
        allowedGroupIds: [],
        adminUserIds: [ADMIN_USER_ID],
        rateLimitPerUser: 10,
        rateLimitWindowMinutes: 60,
        maxResponseLength: 2000,
        disabledTools: [],
      },
    });
    // Insert a test entry (session_id null to avoid FK constraint in test)
    mem.auditLog.insert({
      category: 'tool_call',
      actor_user_id: ADMIN_USER_ID,
      actor_chat_id: ADMIN_USER_ID,
      session_id: null,
      detail: { tool: 'read_file', path: '/test/file.txt' },
    });

    const ctx = makeCtx(ADMIN_USER_ID, 'private');
    await handleAudit(ctx, { config: cfg, memory: mem });
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(reply).toContain('tool_call');
    expect(reply).toContain('Audit Log');
  });
});
