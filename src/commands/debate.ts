/**
 * /debate command handler.
 *
 * /debate                    — show status + example rosters
 * /debate on [rounds]        — enable debate mode; default 3 rounds, max 5
 * /debate off                — disable
 *
 * When enabled, ordinary user messages (non-slash) are answered by a
 * multi-model debate instead of the single-model agent loop. The debate
 * stops early if Claude (as judge) decides the models have reached
 * substantive agreement.
 */

import type { Context } from 'grammy';
import {
  isDebateEnabled,
  getDebateRounds,
  getDebateExchanges,
  setDebate,
  pickRoster,
} from '../debate/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.debate' });

export async function handleDebate(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const text = ctx.message?.text ?? '';
  const parts = text.trim().split(/\s+/);
  const arg = parts[1]?.toLowerCase();
  const roundsArg = parts[2] ? parseInt(parts[2], 10) : undefined;
  const exchangesArg = parts[3] ? parseInt(parts[3], 10) : undefined;

  if (!arg) {
    const state = isDebateEnabled(chatId) ? 'ON' : 'OFF';
    const rounds = getDebateRounds(chatId);
    const exchanges = getDebateExchanges(chatId);
    const exampleRoster = pickRoster('general question').models;
    await ctx.reply(
      `Debate mode: ${state}\n` +
        `Rounds: ${rounds} · Exchanges per round: ${exchanges}\n\n` +
        `Default roster: ${exampleRoster.join(', ')}\n` +
        `(The router picks models by keywords in your question.)\n\n` +
        `Usage:\n` +
        `/debate on [rounds] [exchangesPerRound]  — enable\n` +
        `  rounds: 1–5 (default 2)\n` +
        `  exchangesPerRound: 1–4 (default 2) — how many times each debater ` +
        `speaks per round\n` +
        `/debate off  — disable\n\n` +
        `Debate is adversarial: each debater must attack the previous ` +
        `speaker's weakest point, not just restate their own view. ` +
        `Claude judges consensus at the end of each round; stops early on agreement.`,
    );
    return;
  }

  if (arg === 'on' || arg === 'enable' || arg === 'true') {
    const rounds = roundsArg && !Number.isNaN(roundsArg) ? roundsArg : 2;
    const exchanges = exchangesArg && !Number.isNaN(exchangesArg) ? exchangesArg : 2;
    setDebate(chatId, true, rounds, exchanges);
    const cRounds = getDebateRounds(chatId);
    const cExch = getDebateExchanges(chatId);
    await ctx.reply(
      `⚔️ Debate ON — up to ${cRounds} round${cRounds === 1 ? '' : 's'} · ` +
        `${cExch} exchange${cExch === 1 ? '' : 's'} per round.\n\n` +
        `📝 <b>Send your topic as a normal message now</b> — every non-slash message ` +
        `you send will trigger a multi-model debate until you run <code>/debate off</code>.\n\n` +
        `Example: "<i>is React or Vue better for a small team?</i>"`,
      { parse_mode: 'HTML' },
    );
    log.info({ chatId, rounds: cRounds, exchanges: cExch }, '/debate on');
    return;
  }

  if (arg === 'off' || arg === 'disable' || arg === 'false') {
    setDebate(chatId, false, getDebateRounds(chatId), getDebateExchanges(chatId));
    await ctx.reply('Debate OFF. Back to the single-model agent.');
    log.info({ chatId }, '/debate off');
    return;
  }

  await ctx.reply('Usage: /debate [on|off] [rounds] [exchangesPerRound]');
}
