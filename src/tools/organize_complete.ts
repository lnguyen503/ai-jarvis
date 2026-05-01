/**
 * Tool: organize_complete — mark an organize item as done.
 *
 * Shorthand for status=done + optional dated progress note.
 * NEVER touches Google Calendar (ADR 003 §6).
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext } from './types.js';
import { readItem, updateItem, appendProgressEntry } from '../organize/storage.js';
import { filterOrganizeField } from '../organize/privacy.js';
import { ItemIdSchema, getDataDir } from './organize_shared.js';

const parameters = z.object({
  id: ItemIdSchema.describe('Item id (YYYY-MM-DD-xxxx).'),
  completionNote: z
    .string()
    .max(500)
    .optional()
    .describe('Optional note to append to the Progress section.'),
});

type OrganizeCompleteInput = z.infer<typeof parameters>;

export const organizeCompleteTool: Tool<OrganizeCompleteInput> = {
  name: 'organize_complete',
  description:
    'Mark an organize item (task, event, or goal) as done. ' +
    'Optionally appends a completion note to the progress log. ' +
    'Never modifies Google Calendar — the event stays as history.',
  parameters,
  adminOnly: false,

  async execute(input: OrganizeCompleteInput, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.organize_complete' });

    if (!ctx.userId || !Number.isFinite(ctx.userId)) {
      return {
        ok: false,
        output: "Jarvis couldn't identify you for this action. /organize requires a DM with a user we can identify. If this came from a scheduled task created before v1.10.0 or without an owner, recreate the task via `schedule` — the new task will carry your user id automatically.",
        error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
      };
    }

    const dataDir = getDataDir(ctx);

    // Read item
    let item;
    try {
      item = await readItem(ctx.userId, dataDir, input.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ITEM_MALFORMED') {
        ctx.memory.auditLog.insert({
          category: 'organize.complete',
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
        category: 'organize.complete',
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
        category: 'organize.complete',
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

    if (item.frontMatter.status === 'done') {
      ctx.memory.auditLog.insert({
        category: 'organize.complete',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: { id: input.id, type: item.frontMatter.type, result: 'failed', reason: 'ALREADY_COMPLETE' },
      });
      return {
        ok: false,
        output: `Item ${input.id} is already marked done.`,
        error: { code: 'ALREADY_COMPLETE', message: 'already done' },
      };
    }

    // Privacy filter on completionNote if provided
    let filteredNote: string | undefined;
    if (input.completionNote !== undefined) {
      const f = filterOrganizeField('progressEntry', input.completionNote);
      if (!f.ok) {
        log.info({ userId: ctx.userId, reason: f.reason }, 'organize_complete: completionNote rejected');
        ctx.memory.auditLog.insert({
          category: 'organize.complete',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { id: input.id, result: 'rejected', reason: f.reason },
        });
        return {
          ok: false,
          output: `Refused: completion note — ${f.reason}.`,
          error: { code: 'PRIVACY_FILTER_REJECTED', message: f.reason },
        };
      }
      filteredNote = f.value;
    }

    // Mark done
    try {
      await updateItem(ctx.userId, dataDir, input.id, { status: 'done' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.memory.auditLog.insert({
        category: 'organize.complete',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: { id: input.id, result: 'failed', reason: 'FILE_WRITE_FAILED' },
      });
      return {
        ok: false,
        output: `Failed to mark item done: ${msg}`,
        error: { code: 'FILE_WRITE_FAILED', message: msg },
      };
    }

    // Append progress note if provided
    if (filteredNote !== undefined) {
      try {
        await appendProgressEntry(ctx.userId, dataDir, input.id, filteredNote);
      } catch (err) {
        // Non-fatal: status is already done, just the note append failed.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ userId: ctx.userId, itemId: input.id, err: msg }, 'organize_complete: progress append failed (non-fatal)');
      }
    }

    ctx.memory.auditLog.insert({
      category: 'organize.complete',
      actor_chat_id: ctx.chatId,
      actor_user_id: ctx.userId,
      session_id: ctx.sessionId,
      detail: {
        id: input.id,
        type: item.frontMatter.type,
        result: 'ok',
      },
    });

    log.info({ userId: ctx.userId, itemId: input.id }, 'organize_complete: marked done');

    const noteStr = filteredNote ? ` with note: "${filteredNote}"` : '';
    return {
      ok: true,
      output: `Marked ${input.id} done${noteStr}.`,
      data: { id: input.id, type: item.frontMatter.type, status: 'done' },
    };
  },
};
