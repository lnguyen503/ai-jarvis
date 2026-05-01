/**
 * /memory command (v1.8.5).
 *
 *   /memory                  — show what Jarvis remembers about you
 *   /memory clear            — wipe your entire memory file (requires CONFIRM)
 *   /memory clear CONFIRM    — actually clears (two-step to prevent fat-finger)
 *   /memory off              — disable memory injection for this session (your turns only)
 *   /memory on               — re-enable memory injection
 *
 * Per-USER scoping: shows YOUR memory, not anyone else's, regardless of
 * whether you're in DM or a group chat.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import {
  readUserMemory,
  clearUserMemory,
} from '../memory/userMemory.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.memory' });

/** Per-user toggle (in-memory only — resets on restart, mirrors /voice). */
const memoryDisabled = new Set<number>();

export function isMemoryDisabledForUser(userId: number): boolean {
  return memoryDisabled.has(userId);
}

/** Test hook. */
export function _resetMemoryToggleForTests(): void {
  memoryDisabled.clear();
}

export interface MemoryCommandDeps {
  config: AppConfig;
}

export async function handleMemory(ctx: Context, deps: MemoryCommandDeps): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('No user context — cannot determine whose memory to show.').catch(() => {});
    return;
  }

  const text = ctx.message?.text ?? '';
  const args = text.replace(/^\/memory(@\S+)?\s*/, '').trim().split(/\s+/).filter(Boolean);
  const sub = args[0]?.toLowerCase() ?? '';

  const dataDir = resolveDataDir(deps.config);

  // ----- /memory off / on
  if (sub === 'off' || sub === 'disable') {
    memoryDisabled.add(userId);
    await ctx.reply('Memory OFF for this session. Your saved facts won\'t be loaded into Jarvis\'s context until you re-enable with /memory on.').catch(() => {});
    log.info({ userId }, '/memory off');
    return;
  }
  if (sub === 'on' || sub === 'enable') {
    memoryDisabled.delete(userId);
    await ctx.reply('Memory ON. Your saved facts are loaded into context for your turns.').catch(() => {});
    log.info({ userId }, '/memory on');
    return;
  }

  // ----- /memory clear
  if (sub === 'clear' || sub === 'wipe' || sub === 'reset') {
    const confirmed = (args[1] ?? '').toUpperCase() === 'CONFIRM';
    if (!confirmed) {
      const body = await readUserMemory(userId, dataDir);
      const note = body.length === 0
        ? 'You don\'t have any saved memory yet — nothing to clear.'
        : `This will permanently delete EVERYTHING Jarvis remembers about you (about ${body.length} chars across all categories). To confirm, send: /memory clear CONFIRM`;
      await ctx.reply(note).catch(() => {});
      return;
    }
    try {
      await clearUserMemory(userId, dataDir);
      await ctx.reply('Done. Your memory has been wiped.').catch(() => {});
      log.info({ userId }, '/memory clear (confirmed)');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId, err: msg }, '/memory clear failed');
      await ctx.reply(`Couldn't clear memory: ${msg}`).catch(() => {});
    }
    return;
  }

  // ----- bare /memory — show what's stored
  if (sub === '' || sub === 'show' || sub === 'list') {
    const body = await readUserMemory(userId, dataDir);
    const status = memoryDisabled.has(userId) ? '\n\n_(memory currently OFF — /memory on to re-enable)_' : '';
    if (body.trim().length === 0) {
      await ctx.reply(
        `Jarvis doesn't have any saved memory of you yet.\n\n` +
        `Memory is per-user — it follows you across DMs and groups. To save something, ` +
        `say "remember that I prefer brief replies" (or any preference). ` +
        `Sensitive content (phone, email, credentials, health, financials) is auto-rejected.${status}`,
      ).catch(() => {});
      return;
    }
    // Telegram message limit ~4096 chars; memory cap per file is generous so
    // truncate if needed (rare — facts are short by design).
    const trimmed = body.length > 3800 ? body.slice(0, 3800) + '\n\n…(truncated; raw file in data/memories/)' : body;
    await ctx.reply(trimmed + status).catch(() => {});
    return;
  }

  // ----- unknown subcommand
  await ctx.reply(
    `Usage:\n` +
    `  /memory          — show what Jarvis remembers about you\n` +
    `  /memory clear CONFIRM — wipe your entire memory\n` +
    `  /memory off / on — toggle memory injection for this session`,
  ).catch(() => {});
}
