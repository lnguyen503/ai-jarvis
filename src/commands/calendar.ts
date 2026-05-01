/**
 * /calendar command handler (v1.7.11.2).
 *
 * /calendar       — show whether Google Calendar tools are active in this chat
 * /calendar on    — enable (default state)
 * /calendar off   — disable: drops calendar_list_events / calendar_create_event
 *                   from the LLM's tool list for this chat until re-enabled
 *
 * In-memory per-chat (no persistence). Mirrors /voice and /vision.
 *
 * Calendar tools are admin-only at the Tool level — non-admin sessions never
 * see them regardless of this toggle. So in groups with developers/members,
 * /calendar off is a no-op (already hidden); /calendar on doesn't expose them
 * either. The command is most useful in your DM when you want a calendar-free
 * session for a stretch.
 */

import type { Context } from 'grammy';
import { isCalendarEnabledForChat, setCalendarEnabledForChat } from '../google/calendar.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.calendar' });

export async function handleCalendar(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const text = ctx.message?.text ?? '';
  const arg = text.trim().split(/\s+/)[1]?.toLowerCase();

  if (!arg) {
    const state = isCalendarEnabledForChat(chatId) ? 'ON' : 'OFF';
    await ctx.reply(
      `Calendar tools: ${state}\n\nSend /calendar on or /calendar off to change.`,
    );
    return;
  }

  if (arg === 'on' || arg === 'enable' || arg === 'true') {
    setCalendarEnabledForChat(chatId, true);
    await ctx.reply('Calendar tools enabled for this chat.');
    log.info({ chatId }, '/calendar on');
    return;
  }

  if (arg === 'off' || arg === 'disable' || arg === 'false') {
    setCalendarEnabledForChat(chatId, false);
    await ctx.reply('Calendar tools disabled for this chat.');
    log.info({ chatId }, '/calendar off');
    return;
  }

  await ctx.reply('Usage: /calendar [on|off]');
}
