/**
 * Tool: organize_log_progress — append a dated entry to an item's Progress log.
 *
 * Privacy filter runs on the new entry text only (CP1 R5).
 * NEVER changes status. NEVER touches GCal.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext } from './types.js';
import { readItem, appendProgressEntry } from '../organize/storage.js';
import { filterOrganizeField } from '../organize/privacy.js';
import { ItemIdSchema, getDataDir } from './organize_shared.js';

const parameters = z.object({
  id: ItemIdSchema.describe('Item id (YYYY-MM-DD-xxxx).'),
  entry: z
    .string()
    .min(1)
    .max(500)
    .describe('Progress note to append (privacy-filtered; max 500 chars).'),
});

type OrganizeLogProgressInput = z.infer<typeof parameters>;

export const organizeLogProgressTool: Tool<OrganizeLogProgressInput> = {
  name: 'organize_log_progress',
  description:
    'Append a dated progress entry to an organize item\'s Progress log. ' +
    'Does not change the item\'s status. Does not touch Google Calendar.',
  parameters,
  adminOnly: false,

  async execute(input: OrganizeLogProgressInput, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.organize_log_progress' });

    if (!ctx.userId || !Number.isFinite(ctx.userId)) {
      return {
        ok: false,
        output: "Jarvis couldn't identify you for this action. /organize requires a DM with a user we can identify. If this came from a scheduled task created before v1.10.0 or without an owner, recreate the task via `schedule` — the new task will carry your user id automatically.",
        error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
      };
    }

    const dataDir = getDataDir(ctx);

    // Privacy filter on new entry (runs BEFORE read — cheap fail-fast per R5)
    const entryFilter = filterOrganizeField('progressEntry', input.entry);
    if (!entryFilter.ok) {
      log.info({ userId: ctx.userId, reason: entryFilter.reason }, 'organize_log_progress: entry rejected');
      ctx.memory.auditLog.insert({
        category: 'organize.progress',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: { id: input.id, result: 'rejected', reason: entryFilter.reason },
      });
      return {
        ok: false,
        output: `Refused: progress entry — ${entryFilter.reason}.`,
        error: { code: 'PRIVACY_FILTER_REJECTED', message: entryFilter.reason },
      };
    }

    // Read item
    let item;
    try {
      item = await readItem(ctx.userId, dataDir, input.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ITEM_MALFORMED') {
        ctx.memory.auditLog.insert({
          category: 'organize.progress',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { id: input.id, result: 'failed', reason: 'ITEM_MALFORMED' },
        });
        return {
          ok: false,
          output: 'This item file is missing required front-matter fields. Fix it in your editor or delete it.',
          error: { code: 'ITEM_MALFORMED', message: msg },
        };
      }
      ctx.memory.auditLog.insert({
        category: 'organize.progress',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: { id: input.id, result: 'failed', reason: 'FILE_WRITE_FAILED' },
      });
      return {
        ok: false,
        output: `Failed to read item: ${msg}`,
        error: { code: 'FILE_WRITE_FAILED', message: msg },
      };
    }

    if (!item) {
      ctx.memory.auditLog.insert({
        category: 'organize.progress',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: { id: input.id, result: 'failed', reason: 'ITEM_NOT_FOUND' },
      });
      return {
        ok: false,
        output: `Item ${input.id} not found.`,
        error: { code: 'ITEM_NOT_FOUND', message: `${input.id} not found` },
      };
    }

    // Append progress entry
    try {
      await appendProgressEntry(ctx.userId, dataDir, input.id, entryFilter.value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId: ctx.userId, itemId: input.id, err: msg }, 'organize_log_progress: append failed');
      ctx.memory.auditLog.insert({
        category: 'organize.progress',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: { id: input.id, result: 'failed', reason: 'FILE_WRITE_FAILED' },
      });
      return {
        ok: false,
        output: `Failed to append progress: ${msg}`,
        error: { code: 'FILE_WRITE_FAILED', message: msg },
      };
    }

    ctx.memory.auditLog.insert({
      category: 'organize.progress',
      actor_chat_id: ctx.chatId,
      actor_user_id: ctx.userId,
      session_id: ctx.sessionId,
      detail: {
        id: input.id,
        type: item.frontMatter.type,
        result: 'ok',
      },
    });

    log.info({ userId: ctx.userId, itemId: input.id }, 'organize_log_progress: appended');

    return {
      ok: true,
      output: `Logged progress on ${input.id}: "${entryFilter.value}".`,
      data: { id: input.id, type: item.frontMatter.type },
    };
  },
};
