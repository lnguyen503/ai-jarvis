/**
 * Unit tests for src/commands/groupAdmin.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleJarvisEnable,
  handleJarvisDisable,
  handleJarvisUsers,
  handleJarvisLimit,
  type GroupAdminDeps,
} from '../../src/commands/groupAdmin.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { GroupActivityRepo } from '../../src/memory/groupActivity.js';
import type { GroupSettingsRepo } from '../../src/memory/groupSettings.js';

const ADMIN_ID = 9999;
const NON_ADMIN_ID = 1234;
const GROUP_CHAT_ID = -100001;

function makeDeps(adminIds: number[] = [ADMIN_ID]) {
  const config = makeTestConfig({
    groups: {
      enabled: true,
      allowedGroupIds: [GROUP_CHAT_ID],
      adminUserIds: adminIds,
      rateLimitPerUser: 10,
      rateLimitWindowMinutes: 60,
      maxResponseLength: 2000,
      disabledTools: [],
    },
  });

  const groupActivity: GroupActivityRepo = {
    checkAndIncrement: vi.fn(),
    addTokens: vi.fn(),
    listForGroup: vi.fn().mockReturnValue([
      {
        group_id: GROUP_CHAT_ID,
        user_id: 42,
        username: 'Boss',
        message_count: 5,
        input_tokens: 100,
        output_tokens: 200,
        last_active_at: '2026-01-01T00:00:00',
        window_start_at: '2026-01-01T00:00:00',
      },
    ]),
    setRateLimitOverride: vi.fn(),
  } as unknown as GroupActivityRepo;

  const groupSettings: GroupSettingsRepo = {
    isEnabled: vi.fn().mockReturnValue(true),
    setEnabled: vi.fn(),
    get: vi.fn(),
  } as unknown as GroupSettingsRepo;

  return { config, groupActivity, groupSettings };
}

function makeCtx(opts: {
  userId?: number;
  chatType?: string;
  chatId?: number;
  text?: string;
}) {
  const replies: string[] = [];
  return {
    from: { id: opts.userId ?? ADMIN_ID },
    chat: { type: opts.chatType ?? 'group', id: opts.chatId ?? GROUP_CHAT_ID },
    message: { text: opts.text ?? '' },
    reply: vi.fn(async (msg: string) => { replies.push(msg); }),
    _replies: replies,
  } as never;
}

describe('commands.groupAdmin', () => {
  describe('/jarvis-enable', () => {
    it('enables the group when called by admin', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: ADMIN_ID });
      await handleJarvisEnable(ctx, deps);
      expect(deps.groupSettings.setEnabled).toHaveBeenCalledWith(GROUP_CHAT_ID, true);
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith(
        expect.stringContaining('enabled'),
      );
    });

    it('rejects non-admin with "Admin only."', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: NON_ADMIN_ID });
      await handleJarvisEnable(ctx, deps);
      expect(deps.groupSettings.setEnabled).not.toHaveBeenCalled();
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith('Admin only.');
    });

    it('rejects when called in private chat', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: ADMIN_ID, chatType: 'private', chatId: ADMIN_ID });
      await handleJarvisEnable(ctx, deps);
      expect(deps.groupSettings.setEnabled).not.toHaveBeenCalled();
    });

    it('rejects when adminUserIds is empty', async () => {
      const deps = makeDeps([]);
      const ctx = makeCtx({ userId: ADMIN_ID });
      await handleJarvisEnable(ctx, deps);
      expect(deps.groupSettings.setEnabled).not.toHaveBeenCalled();
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith('Admin only.');
    });
  });

  describe('/jarvis-disable', () => {
    it('disables the group when called by admin', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: ADMIN_ID });
      await handleJarvisDisable(ctx, deps);
      expect(deps.groupSettings.setEnabled).toHaveBeenCalledWith(GROUP_CHAT_ID, false);
    });

    it('rejects non-admin', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: NON_ADMIN_ID });
      await handleJarvisDisable(ctx, deps);
      expect(deps.groupSettings.setEnabled).not.toHaveBeenCalled();
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith('Admin only.');
    });
  });

  describe('/jarvis-users', () => {
    it('shows user stats for admin', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: ADMIN_ID });
      await handleJarvisUsers(ctx, deps);
      expect(deps.groupActivity.listForGroup).toHaveBeenCalledWith(GROUP_CHAT_ID);
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith(
        expect.stringContaining('Boss'),
        expect.any(Object),
      );
    });

    it('rejects non-admin', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: NON_ADMIN_ID });
      await handleJarvisUsers(ctx, deps);
      expect(deps.groupActivity.listForGroup).not.toHaveBeenCalled();
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith('Admin only.');
    });

    it('reports empty when no activity', async () => {
      const deps = makeDeps();
      (deps.groupActivity.listForGroup as ReturnType<typeof vi.fn>).mockReturnValue([]);
      const ctx = makeCtx({ userId: ADMIN_ID });
      await handleJarvisUsers(ctx, deps);
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith(
        expect.stringContaining('No user activity'),
      );
    });
  });

  describe('/jarvis-limit', () => {
    it('sets rate limit override for admin', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: ADMIN_ID, text: '/jarvis_limit 42 5' });
      await handleJarvisLimit(ctx, deps);
      expect(deps.groupActivity.setRateLimitOverride).toHaveBeenCalledWith(
        GROUP_CHAT_ID,
        42,
        5,
      );
    });

    it('rejects non-admin', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: NON_ADMIN_ID, text: '/jarvis_limit 42 5' });
      await handleJarvisLimit(ctx, deps);
      expect(deps.groupActivity.setRateLimitOverride).not.toHaveBeenCalled();
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith('Admin only.');
    });

    it('shows usage error for missing args', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: ADMIN_ID, text: '/jarvis_limit 42' });
      await handleJarvisLimit(ctx, deps);
      expect(deps.groupActivity.setRateLimitOverride).not.toHaveBeenCalled();
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith(
        expect.stringContaining('Usage'),
      );
    });

    it('handles limit=0 (clear override)', async () => {
      const deps = makeDeps();
      const ctx = makeCtx({ userId: ADMIN_ID, text: '/jarvis_limit 42 0' });
      await handleJarvisLimit(ctx, deps);
      expect(deps.groupActivity.setRateLimitOverride).toHaveBeenCalledWith(GROUP_CHAT_ID, 42, 0);
      expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledWith(
        expect.stringContaining('cleared'),
      );
    });
  });
});
