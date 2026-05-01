/**
 * /webapp command handler — v1.13.0
 *
 * DM-only. Reads config.webapp.publicUrl and sends an inline Web App button
 * via adapter.sendWebAppButton. If publicUrl is empty or the server is not
 * yet configured, replies with a setup-guidance message pointing at the README.
 *
 * Group chats are intentionally rejected: Telegram Web Apps launched from
 * group buttons have different lifecycle semantics (group context, chat_instance
 * scoping) that v1.13.0 does not implement. Deferred to v1.14.0+.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import { isGroupChat } from '../gateway/groupGate.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.webapp' });

export interface WebAppCommandDeps {
  config: AppConfig;
  adapter: MessagingAdapter;
}

export async function handleWebApp(ctx: Context, deps: WebAppCommandDeps): Promise<void> {
  // DM-only — Web Apps from group chats hit different launch flows; defer.
  if (isGroupChat(ctx)) {
    await ctx.reply('Web App is DM-only — message me privately.').catch(() => {});
    return;
  }

  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const url = deps.config.webapp.publicUrl;
  if (!url) {
    await ctx
      .reply(
        "Web App isn't configured yet. Set `webapp.publicUrl` in config.json " +
          '(use cloudflared for dev: see README §Telegram Web App). Then restart Jarvis.',
      )
      .catch(() => {});
    log.info({ chatId }, '/webapp invoked but publicUrl empty');
    return;
  }

  if (!url.startsWith('https://')) {
    await ctx
      .reply(
        `Web App URL must be HTTPS. Configured URL is "${url}" — ` +
          'Telegram only accepts https:// in WebApp buttons.',
      )
      .catch(() => {});
    log.warn({ chatId, url }, '/webapp invoked with non-HTTPS publicUrl');
    return;
  }

  // v1.13.1: append the static-mount path so the button opens index.html, not
  // the server root (which falls through to the 404 catchall). publicUrl is
  // the bare tunnel/domain base; the static page lives at `/webapp/`.
  // Strip any trailing slash on publicUrl before joining to avoid `//webapp/`.
  const buttonUrl = `${url.replace(/\/+$/, '')}/webapp/`;

  try {
    await deps.adapter.sendWebAppButton(chatId, 'Open Jarvis Web App', '🚀 Open', buttonUrl);
    log.info({ chatId, url: buttonUrl }, '/webapp button sent');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Couldn't send the Web App button: ${msg}`).catch(() => {});
    log.error({ chatId, err: msg }, '/webapp button send failed');
  }
}
