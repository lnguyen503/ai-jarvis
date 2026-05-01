/**
 * v1.7.7 — resolveUserRef tests: numeric / @username / alias / reply-to.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from 'grammy';
import { resolveUserRef, type JarvisRolesDeps } from '../../src/commands/jarvisRoles.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { MemoryApi } from '../../src/memory/index.js';

type ActivityRow = {
  group_id: number;
  user_id: number;
  username: string | null;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  last_active_at: string;
  window_start_at: string;
};

function makeDeps(overrides: {
  aliases?: Record<string, number>;
  known?: ActivityRow[]; // what the group_activity table "knows"
} = {}): JarvisRolesDeps {
  const cfg = makeTestConfig();
  cfg.aliases = overrides.aliases ?? {};
  const known = overrides.known ?? [];
  const mockMemory: MemoryApi = {
    groupActivity: {
      findByUsernameInGroup: (gid: number, uname: string) =>
        known.find(
          (r) => r.group_id === gid && r.username?.toLowerCase() === uname.toLowerCase().replace(/^@/, ''),
        ) ?? null,
      findByUsernameAnyGroup: (uname: string) =>
        known.find((r) => r.username?.toLowerCase() === uname.toLowerCase().replace(/^@/, '')) ?? null,
      // stubs — not hit by these tests
      addTokens: () => {},
      checkAndIncrement: () => ({ allowed: true, current: 0, limit: 0 }),
      listForGroup: () => [],
    } as unknown as MemoryApi['groupActivity'],
    // stubs for other repos
  } as unknown as MemoryApi;
  return { config: cfg, configPath: '/tmp/noop.json', memory: mockMemory };
}

function makeCtx(overrides: { text?: string; replyFromId?: number; replyFromUsername?: string } = {}): Context {
  return {
    message: {
      text: overrides.text,
      reply_to_message: overrides.replyFromId
        ? { from: { id: overrides.replyFromId, username: overrides.replyFromUsername } }
        : undefined,
    },
    chat: { id: -100 },
  } as unknown as Context;
}

describe('resolveUserRef — numeric', () => {
  it('accepts a plain numeric ID', () => {
    const deps = makeDeps();
    const r = resolveUserRef('9999', makeCtx(), deps, -100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe(9999);
      expect(r.source).toBe('id');
    }
  });
});

describe('resolveUserRef — @username', () => {
  it('resolves a @username from current group activity', () => {
    const deps = makeDeps({
      known: [
        {
          group_id: -100,
          user_id: 42,
          username: 'kimhandle',
          message_count: 1,
          input_tokens: 0,
          output_tokens: 0,
          last_active_at: '',
          window_start_at: '',
        },
      ],
    });
    const r = resolveUserRef('@kimhandle', makeCtx(), deps, -100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe(42);
      expect(r.source).toBe('username');
    }
  });

  it('is case-insensitive for @username', () => {
    const deps = makeDeps({
      known: [
        {
          group_id: -100,
          user_id: 42,
          username: 'KimHandle',
          message_count: 1,
          input_tokens: 0,
          output_tokens: 0,
          last_active_at: '',
          window_start_at: '',
        },
      ],
    });
    const r = resolveUserRef('@kimhandle', makeCtx(), deps, -100);
    expect(r.ok).toBe(true);
  });

  it('errors if @username unknown', () => {
    const deps = makeDeps();
    const r = resolveUserRef('@ghost', makeCtx(), deps, -100);
    expect(r.ok).toBe(false);
  });
});

describe('resolveUserRef — alias', () => {
  it('resolves a named alias case-insensitively', () => {
    const deps = makeDeps({ aliases: { kim: 42 } });
    const r = resolveUserRef('Kim', makeCtx(), deps, -100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe(42);
      expect(r.source).toBe('alias');
    }
  });

  it('errors on unknown alias', () => {
    const deps = makeDeps({ aliases: { kim: 42 } });
    const r = resolveUserRef('bob', makeCtx(), deps, -100);
    expect(r.ok).toBe(false);
  });
});

describe('resolveUserRef — reply-to fallback', () => {
  it('uses reply_to_message.from.id when no arg given', () => {
    const deps = makeDeps();
    const r = resolveUserRef(undefined, makeCtx({ replyFromId: 555 }), deps, -100);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.userId).toBe(555);
      expect(r.source).toBe('reply');
    }
  });

  it('errors when no arg AND no reply', () => {
    const deps = makeDeps();
    const r = resolveUserRef(undefined, makeCtx(), deps, -100);
    expect(r.ok).toBe(false);
  });
});
