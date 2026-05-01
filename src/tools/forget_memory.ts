/**
 * Tool: forget_memory — remove entries containing a topic substring.
 *
 * Called when the user says "forget X" or "stop remembering Y".
 * Removes every bullet line in the per-user memory file whose lowercase
 * form contains the lowercase topic. Returns the number of entries
 * removed so the agent can confirm.
 *
 * Per-user, not per-chat — same as update_memory.
 */

import { z } from 'zod';
import path from 'node:path';
import type { Tool, ToolResult, ToolContext } from './types.js';
import { forgetUserMemoryEntries } from '../memory/userMemory.js';

const ForgetMemoryInput = z.object({
  topic: z
    .string()
    .min(2)
    .max(100)
    .describe(
      'A short substring to search for. Every memory entry whose text contains this substring ' +
        '(case-insensitive) will be removed. Be specific to avoid removing unrelated entries — ' +
        'use "voice replies" not just "voice", "Sonnet default" not just "Sonnet".',
    ),
});

type ForgetMemoryInputType = z.infer<typeof ForgetMemoryInput>;

export const forgetMemoryTool: Tool<ForgetMemoryInputType> = {
  name: 'forget_memory',
  description:
    'Remove memory entries that match a topic substring. ' +
    'Call when the user says "forget X", "stop remembering Y", "you don\'t need to remember Z anymore". ' +
    'Returns the number of entries removed; if 0, tell the user no matching memory was found ' +
    'and offer to show /memory so they can pick a more specific term.',
  parameters: ForgetMemoryInput,

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.forget_memory' });

    if (!ctx.userId || !Number.isFinite(ctx.userId)) {
      return {
        ok: false,
        output: 'Cannot forget memory: speaker user id is not available for this turn. If this came from a scheduled task created before v1.10.0 or without an owner, recreate the task via `schedule` — the new task will carry your user id automatically.',
        error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
      };
    }

    const dataDir = path.resolve(ctx.config.memory?.dbPath
      ? path.dirname(ctx.config.memory.dbPath)
      : 'data');

    let result: { removed: number };
    try {
      result = await forgetUserMemoryEntries(ctx.userId, input.topic, dataDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId: ctx.userId, err: msg }, 'forget_memory: failed');
      return {
        ok: false,
        output: `Failed to update memory: ${msg}`,
        error: { code: 'FORGET_FAILED', message: msg },
      };
    }

    ctx.memory.auditLog.insert({
      category: 'memory.delete',
      actor_chat_id: ctx.chatId,
      actor_user_id: ctx.userId,
      session_id: ctx.sessionId,
      detail: { topic: input.topic, removed: result.removed },
    });
    log.info(
      { userId: ctx.userId, topic: input.topic, removed: result.removed },
      'forget_memory: completed',
    );
    return {
      ok: true,
      output:
        result.removed === 0
          ? `No memory entries matched "${input.topic}". Use /memory to see what's stored.`
          : `Forgot ${result.removed} ${result.removed === 1 ? 'entry' : 'entries'} matching "${input.topic}".`,
      data: { topic: input.topic, removed: result.removed },
    };
  },
};
