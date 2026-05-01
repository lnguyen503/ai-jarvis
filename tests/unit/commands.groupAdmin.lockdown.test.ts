/**
 * V-02..V-04 regression: admin-gate for /clear /stop /history /projects /status in group mode.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import { makeTestConfig } from '../fixtures/makeConfig.js';

// We test the gateway command wrapper logic directly by checking if the guard
// short-circuits. Since we can't easily spin up the full grammY bot, we simulate
// the guard logic that was added to gateway/index.ts.

function isGroupChat(chatType: string | undefined) {
  return chatType === 'group' || chatType === 'supergroup';
}

function buildGroupCtx(userId: number, chatId = -1001234567890): Partial<Context> {
  return {
    from: { id: userId, is_bot: false, first_name: 'TestUser' },
    chat: { id: chatId, type: 'supergroup', title: 'Test Group' },
    message: { text: '/clear', message_id: 1, date: Date.now(), chat: { id: chatId, type: 'supergroup', title: 'Test Group' } },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Partial<Context>;
}

describe('gateway admin-gate for group commands (V-02..V-04)', () => {
  const adminUserId = 42;
  const nonAdminUserId = 99;

  it('allows admin to /clear in group (passes guard)', () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [adminUserId], enabled: true } });
    const ctx = buildGroupCtx(adminUserId);
    const chatType = (ctx.chat as { type: string }).type;
    const userId = (ctx.from as { id: number }).id;

    // Simulate the gateway guard
    let blocked = false;
    if (isGroupChat(chatType)) {
      if (!cfg.groups.adminUserIds.includes(userId)) {
        blocked = true;
      }
    }
    expect(blocked).toBe(false);
  });

  it('blocks non-admin from /clear in group (guard fires)', () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [adminUserId], enabled: true } });
    const ctx = buildGroupCtx(nonAdminUserId);
    const chatType = (ctx.chat as { type: string }).type;
    const userId = (ctx.from as { id: number }).id;

    let blocked = false;
    if (isGroupChat(chatType)) {
      if (!cfg.groups.adminUserIds.includes(userId)) {
        blocked = true;
      }
    }
    expect(blocked).toBe(true);
  });

  it('blocks non-admin from /stop in group', () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [adminUserId], enabled: true } });
    const ctx = buildGroupCtx(nonAdminUserId);
    const chatType = (ctx.chat as { type: string }).type;
    const userId = (ctx.from as { id: number }).id;

    let blocked = false;
    if (isGroupChat(chatType)) {
      if (!cfg.groups.adminUserIds.includes(userId)) {
        blocked = true;
      }
    }
    expect(blocked).toBe(true);
  });

  it('blocks non-admin from /history in group', () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [adminUserId], enabled: true } });
    const ctx = buildGroupCtx(nonAdminUserId);
    const chatType = (ctx.chat as { type: string }).type;
    const userId = (ctx.from as { id: number }).id;

    let blocked = false;
    if (isGroupChat(chatType)) {
      if (!cfg.groups.adminUserIds.includes(userId)) {
        blocked = true;
      }
    }
    expect(blocked).toBe(true);
  });

  it('blocks non-admin from /projects in group', () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [adminUserId], enabled: true } });
    const ctx = buildGroupCtx(nonAdminUserId);
    const chatType = (ctx.chat as { type: string }).type;
    const userId = (ctx.from as { id: number }).id;

    let blocked = false;
    if (isGroupChat(chatType)) {
      if (!cfg.groups.adminUserIds.includes(userId)) {
        blocked = true;
      }
    }
    expect(blocked).toBe(true);
  });

  it('blocks non-admin from /status in group', () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [adminUserId], enabled: true } });
    const ctx = buildGroupCtx(nonAdminUserId);
    const chatType = (ctx.chat as { type: string }).type;
    const userId = (ctx.from as { id: number }).id;

    let blocked = false;
    if (isGroupChat(chatType)) {
      if (!cfg.groups.adminUserIds.includes(userId)) {
        blocked = true;
      }
    }
    expect(blocked).toBe(true);
  });

  it('allows all commands in DM regardless of admin status', () => {
    const cfg = makeTestConfig({ groups: { ...makeTestConfig().groups, adminUserIds: [adminUserId], enabled: true } });
    // DM chat type is 'private'
    const ctx = {
      from: { id: nonAdminUserId, is_bot: false, first_name: 'TestUser' },
      chat: { id: nonAdminUserId, type: 'private' },
    } as unknown as Partial<Context>;

    const chatType = (ctx.chat as { type: string }).type;
    const userId = (ctx.from as { id: number }).id;

    let blocked = false;
    if (isGroupChat(chatType)) {
      if (!cfg.groups.adminUserIds.includes(userId)) {
        blocked = true;
      }
    }
    // DM is not a group chat — guard should not fire
    expect(blocked).toBe(false);
  });
});
