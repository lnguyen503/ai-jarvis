/**
 * /avengers commands — toggle multi-bot collaboration modes per chat (v1.22.1).
 *
 * Two independent flags stored in `group_settings`:
 *
 *   /avengers chat on|off
 *     When ON: specialist bots may chime in on free-form chatter, not just
 *     respond to explicit @-mentions. Casual demo mode for showing the team
 *     can talk in a chat with humans present.
 *
 *   /avengers assemble on|off
 *     When ON: orchestrator (Jarvis) runs in "team execution" mode —
 *     explicitly delegates domain work to specialists and coordinates a
 *     multi-step deliverable. ASSEMBLE!
 *
 *   /avengers status
 *     Show current flag state.
 *
 * Admin-only (gated by config.groups.adminUserIds upstream). DM is allowed
 * for testing — toggles are scoped per chat_id.
 */

import type { Context } from 'grammy';
import type { MemoryApi } from '../memory/index.js';
import type { AppConfig } from '../config/index.js';
import { child } from '../logger/index.js';
import {
  deriveThreadKey,
  markThreadStopped,
} from '../gateway/loopProtection.js';

const log = child({ component: 'commands.avengers' });

export interface AvengersCmdCtx {
  ctx: Context;
  userId: number;
  chatId: number;
  memory: MemoryApi;
  config: AppConfig;
}

const HELP_TEXT =
  '/avengers chat on|off — toggle free-form chat mode (specialists may chime in)\n' +
  '/avengers assemble on|off — toggle team-execution mode (orchestrator coordinates the team)\n' +
  '/avengers debate on|off — toggle debate-for-accuracy (specialists debate Jarvis-as-critic; experimental, slower)\n' +
  '/avengers reset — break any in-progress chatter; tell specialists no task is active\n' +
  '/avengers status — show current flag state';

export async function handleAvengersCommand(deps: AvengersCmdCtx, sub: string, arg: string | undefined): Promise<void> {
  const { ctx, chatId, memory, userId } = deps;

  // Admin-only gate (mirrors /coach pattern; allowedUserIds + adminUserIds).
  const isAdmin =
    deps.config.telegram.allowedUserIds.includes(userId) ||
    deps.config.groups.adminUserIds.includes(userId);
  if (!isAdmin) {
    await ctx.reply('Admin only.').catch(() => undefined);
    return;
  }

  if (sub === 'status' || sub === '') {
    return showStatus(deps);
  }

  // v1.22.46 — /avengers reset. Three effects:
  //   1. Mark this thread "stopped" so peer-bot messages drop at Jarvis's
  //      gateway until the next user message.
  //   2. Reset the peer-bot loop counter so that next user message starts
  //      with a fresh budget.
  //   3. Post a chat-visible reset notice. Specialists see this in their
  //      conversation history; combined with the v1.22.46 persona rule
  //      ("no active task by default"), they won't resume any prior work
  //      on the next activation.
  if (sub === 'reset') {
    const groupThreadKey = deriveThreadKey(chatId, undefined);
    // The /avengers user message itself already cleared the loop counter
    // via the gateway's normal user-message reset path. Now mark the thread
    // STOPPED so any in-flight peer-bot replies arriving after the user
    // message also drop. The next user message will clear the stopped flag.
    markThreadStopped(groupThreadKey);
    log.info({ chatId, actorUserId: userId }, '/avengers reset invoked');
    memory.auditLog.insert({
      category: 'group.avengers_mode',
      actor_user_id: userId,
      actor_chat_id: chatId,
      detail: { mode: 'reset', enabled: true },
    });
    await ctx
      .reply(
        '🛑 <b>Avengers reset.</b> Any in-progress specialist chatter is dropped. ' +
          'Tony, Natasha, Bruce — no task is active. Stand by until Boss delegates the next one.',
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
    return;
  }

  if (sub !== 'chat' && sub !== 'assemble' && sub !== 'debate') {
    await ctx.reply(`Unknown /avengers subcommand: "${sub}".\n\n${HELP_TEXT}`).catch(() => undefined);
    return;
  }

  if (arg !== 'on' && arg !== 'off') {
    await ctx.reply(`/avengers ${sub} requires "on" or "off".\n\n${HELP_TEXT}`).catch(() => undefined);
    return;
  }

  const enabled = arg === 'on';

  if (sub === 'chat') {
    memory.groupSettings.setAvengersChat(chatId, enabled);
    log.info({ chatId, enabled, actorUserId: userId }, '/avengers chat toggled');
    memory.auditLog.insert({
      category: 'group.avengers_mode',
      actor_user_id: userId,
      actor_chat_id: chatId,
      detail: { mode: 'chat', enabled },
    });
    await ctx
      .reply(
        enabled
          ? '🦸 Avengers CHAT mode ON — specialists may chime in freely.'
          : '🦸 Avengers CHAT mode OFF — specialists wait for explicit @-mention.',
      )
      .catch(() => undefined);
    return;
  }

  if (sub === 'assemble') {
    memory.groupSettings.setAvengersAssemble(chatId, enabled);
    log.info({ chatId, enabled, actorUserId: userId }, '/avengers assemble toggled');
    memory.auditLog.insert({
      category: 'group.avengers_mode',
      actor_user_id: userId,
      actor_chat_id: chatId,
      detail: { mode: 'assemble', enabled },
    });
    await ctx
      .reply(
        enabled
          ? '🦸 AVENGERS, ASSEMBLE! — team-execution mode ON. Orchestrator routes work to specialists until delivered.'
          : '🦸 Avengers ASSEMBLE mode OFF — orchestrator works solo unless it chooses to delegate.',
      )
      .catch(() => undefined);
    return;
  }

  // sub === 'debate' (v1.22.36)
  memory.groupSettings.setAvengersDebate(chatId, enabled);
  log.info({ chatId, enabled, actorUserId: userId }, '/avengers debate toggled');
  memory.auditLog.insert({
    category: 'group.avengers_mode',
    actor_user_id: userId,
    actor_chat_id: chatId,
    detail: { mode: 'debate', enabled },
  });
  await ctx
    .reply(
      enabled
        ? '🔬 Debate-for-accuracy ON — specialists will debate Jarvis-as-critic before posting (slower; up to 3 rounds; transcripts in dashboard).'
        : '🔬 Debate-for-accuracy OFF — specialists post drafts directly without critic review.',
    )
    .catch(() => undefined);
}

async function showStatus(deps: AvengersCmdCtx): Promise<void> {
  const { ctx, chatId, memory } = deps;
  const modes = memory.groupSettings.getAvengersModes(chatId);
  const lines = [
    '<b>Avengers status</b>',
    `• chat: ${modes.chat ? '🟢 ON' : '⚪ off'}`,
    `• assemble: ${modes.assemble ? '🟢 ON' : '⚪ off'}`,
    `• debate: ${modes.debate ? '🟢 ON' : '⚪ off'}`,
    '',
    HELP_TEXT,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' }).catch(() => undefined);
}
