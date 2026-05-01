/**
 * /voice command handler.
 *
 * /voice          — show current voice-reply state for this chat
 * /voice on       — enable: Jarvis also sends a voice note for each reply
 * /voice off      — disable
 *
 * The toggle is in-memory (per-chat), resets on process restart.
 * Synthesis uses OpenAI TTS; requires OPENAI_API_KEY.
 */

import type { Context } from 'grammy';
import { isVoiceEnabled, setVoiceEnabled } from '../tts/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.voice' });

export async function handleVoice(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const text = ctx.message?.text ?? '';
  const arg = text.trim().split(/\s+/)[1]?.toLowerCase();

  if (!arg) {
    const state = isVoiceEnabled(chatId) ? 'ON' : 'OFF';
    await ctx.reply(
      `Voice replies: ${state}\n\nSend /voice on or /voice off to change.`,
    );
    return;
  }

  if (arg === 'on' || arg === 'enable' || arg === 'true') {
    setVoiceEnabled(chatId, true);
    await ctx.reply('Voice replies enabled. Jarvis will speak as well as type.');
    log.info({ chatId }, '/voice on');
    return;
  }

  if (arg === 'off' || arg === 'disable' || arg === 'false') {
    setVoiceEnabled(chatId, false);
    await ctx.reply('Voice replies disabled.');
    log.info({ chatId }, '/voice off');
    return;
  }

  await ctx.reply('Usage: /voice [on|off]');
}
