/**
 * Tests for /calendar on|off command and the underlying per-chat toggle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCalendarEnabledForChat,
  setCalendarEnabledForChat,
  _resetCalendarToggle,
} from '../../src/google/calendar.js';
import { handleCalendar } from '../../src/commands/calendar.js';

interface MockCtx {
  chat?: { id: number };
  message?: { text?: string };
  replies: string[];
  reply: (msg: string) => Promise<void>;
}

function makeCtx(chatId: number, text: string): MockCtx {
  const ctx: MockCtx = {
    chat: { id: chatId },
    message: { text },
    replies: [],
    reply: async (msg: string) => {
      ctx.replies.push(msg);
    },
  };
  return ctx;
}

describe('calendar toggle — state', () => {
  beforeEach(() => _resetCalendarToggle());

  it('defaults to ENABLED for any chat (empty disabled set)', () => {
    expect(isCalendarEnabledForChat(123)).toBe(true);
    expect(isCalendarEnabledForChat(-456)).toBe(true);
  });

  it('setCalendarEnabledForChat(false) disables only that chat', () => {
    setCalendarEnabledForChat(123, false);
    expect(isCalendarEnabledForChat(123)).toBe(false);
    expect(isCalendarEnabledForChat(456)).toBe(true);
  });

  it('setCalendarEnabledForChat(true) re-enables a previously disabled chat', () => {
    setCalendarEnabledForChat(123, false);
    setCalendarEnabledForChat(123, true);
    expect(isCalendarEnabledForChat(123)).toBe(true);
  });

  it('toggle state is per-chat (independent for groups vs DMs)', () => {
    setCalendarEnabledForChat(-100, false); // group
    setCalendarEnabledForChat(200, true);   // DM (default already true)
    expect(isCalendarEnabledForChat(-100)).toBe(false);
    expect(isCalendarEnabledForChat(200)).toBe(true);
  });
});

describe('/calendar command — handler', () => {
  beforeEach(() => _resetCalendarToggle());

  it('reports current state when called with no arg', async () => {
    const ctx = makeCtx(7, '/calendar');
    await handleCalendar(ctx as unknown as Parameters<typeof handleCalendar>[0]);
    expect(ctx.replies[0]).toContain('Calendar tools: ON');
    expect(ctx.replies[0]).toContain('/calendar on');
    expect(ctx.replies[0]).toContain('/calendar off');
  });

  it('"/calendar off" disables and confirms', async () => {
    const ctx = makeCtx(7, '/calendar off');
    await handleCalendar(ctx as unknown as Parameters<typeof handleCalendar>[0]);
    expect(isCalendarEnabledForChat(7)).toBe(false);
    expect(ctx.replies[0]).toContain('disabled');
  });

  it('"/calendar on" re-enables and confirms', async () => {
    setCalendarEnabledForChat(7, false);
    const ctx = makeCtx(7, '/calendar on');
    await handleCalendar(ctx as unknown as Parameters<typeof handleCalendar>[0]);
    expect(isCalendarEnabledForChat(7)).toBe(true);
    expect(ctx.replies[0]).toContain('enabled');
  });

  it('reports OFF state correctly', async () => {
    setCalendarEnabledForChat(7, false);
    const ctx = makeCtx(7, '/calendar');
    await handleCalendar(ctx as unknown as Parameters<typeof handleCalendar>[0]);
    expect(ctx.replies[0]).toContain('Calendar tools: OFF');
  });

  it('rejects invalid argument with usage hint', async () => {
    const ctx = makeCtx(7, '/calendar maybe');
    await handleCalendar(ctx as unknown as Parameters<typeof handleCalendar>[0]);
    expect(ctx.replies[0]).toContain('Usage');
    expect(isCalendarEnabledForChat(7)).toBe(true); // unchanged
  });

  it('accepts "enable" / "disable" / "true" / "false" as aliases', async () => {
    const cases: Array<[string, boolean]> = [
      ['/calendar enable', true],
      ['/calendar disable', false],
      ['/calendar true', true],
      ['/calendar false', false],
    ];
    for (const [text, expected] of cases) {
      _resetCalendarToggle();
      const ctx = makeCtx(7, text);
      await handleCalendar(ctx as unknown as Parameters<typeof handleCalendar>[0]);
      expect(isCalendarEnabledForChat(7)).toBe(expected);
    }
  });

  it('does nothing when chat ID is missing', async () => {
    const ctx = makeCtx(0, '/calendar off');
    delete ctx.chat;
    await handleCalendar(ctx as unknown as Parameters<typeof handleCalendar>[0]);
    expect(ctx.replies).toHaveLength(0);
  });
});
