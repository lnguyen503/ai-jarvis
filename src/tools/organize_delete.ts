/**
 * Tool: organize_delete — soft-delete an organize item (moves to .trash/).
 *
 * For event items: calls CalendarApi.deleteEvent FIRST (ADR 003 §6).
 * - 404/410 from Google → treat as success (event already gone).
 * - Other GCal errors → abort; local file NOT touched; return CALENDAR_DELETE_FAILED.
 * - /calendar off → skip GCal; soft-delete locally; emit organize.inconsistency audit row.
 *
 * If rename to .trash/ fails after successful GCal delete: returns FILE_DELETE_FAILED
 * and emits organize.inconsistency with kind:'orphan-local'.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { CalendarApi, isCalendarEnabledForChat } from '../google/calendar.js';
import { readItem, softDeleteItem } from '../organize/storage.js';
import { ItemIdSchema, getDataDir } from './organize_shared.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  id: ItemIdSchema.describe('Item id (YYYY-MM-DD-xxxx).'),
});

type OrganizeDeleteInput = z.infer<typeof parameters>;

export function buildOrganizeDeleteTool(deps: ToolDeps): Tool<OrganizeDeleteInput> {
  let cachedAuth: OAuth2Client | null = null;
  let triedLoad = false;

  async function getAuth(): Promise<OAuth2Client | null> {
    if (cachedAuth) return cachedAuth;
    if (triedLoad) return cachedAuth;
    triedLoad = true;
    cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
    return cachedAuth;
  }

  return {
    name: 'organize_delete',
    description:
      'Soft-delete an organize item (moves to .trash/). ' +
      'For calendar events, removes from Google Calendar first. ' +
      'Recoverable: say "restore item <id>" to undo (future feature). ',
    parameters,
    adminOnly: false,

    async execute(input: OrganizeDeleteInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.organize_delete' });

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
            category: 'organize.delete',
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
          category: 'organize.delete',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { id: input.id, result: 'failed', reason: 'FILE_DELETE_FAILED' },
        });
        return {
          ok: false,
          output: `Failed to read item: ${msg}`,
          error: { code: 'FILE_DELETE_FAILED', message: msg },
        };
      }

      if (!item) {
        ctx.memory.auditLog.insert({
          category: 'organize.delete',
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

      const { calendarEventId } = item.frontMatter;
      const hadCalendar = Boolean(calendarEventId);

      // --- Event path: handle GCal ---
      if (hadCalendar && calendarEventId) {
        // /calendar off → skip GCal, soft-delete locally, emit inconsistency
        if (!isCalendarEnabledForChat(ctx.chatId)) {
          try {
            await softDeleteItem(ctx.userId, dataDir, input.id);
          } catch (trashErr) {
            const trashMsg = trashErr instanceof Error ? trashErr.message : String(trashErr);
            const errCode = (trashErr as NodeJS.ErrnoException).code;
            if (errCode === 'ORGANIZE_TRASH_INVALID') {
              ctx.memory.auditLog.insert({
                category: 'organize.delete',
                actor_chat_id: ctx.chatId,
                actor_user_id: ctx.userId,
                session_id: ctx.sessionId,
                detail: { id: input.id, result: 'failed', reason: 'ORGANIZE_TRASH_INVALID' },
              });
              return {
                ok: false,
                output: `Storage path error (trash dir invalid): ${trashMsg}`,
                error: { code: 'ORGANIZE_TRASH_INVALID', message: trashMsg },
              };
            }
            ctx.memory.auditLog.insert({
              category: 'organize.delete',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: { id: input.id, result: 'failed', reason: 'FILE_DELETE_FAILED' },
            });
            return {
              ok: false,
              output: `Failed to soft-delete item: ${trashMsg}`,
              error: { code: 'FILE_DELETE_FAILED', message: trashMsg },
            };
          }

          // Emit deferred-orphan-gcal inconsistency
          ctx.memory.auditLog.insert({
            category: 'organize.inconsistency',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              kind: 'deferred-orphan-gcal',
              eventId: calendarEventId,
              itemId: input.id,
              rootCause: 'calendar disabled for this chat; GCal delete skipped',
            },
          });
          ctx.memory.auditLog.insert({
            category: 'organize.delete',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              id: input.id,
              type: item.frontMatter.type,
              result: 'ok',
              calendarSkipped: true,
              reason: 'CALENDAR_DISABLED_FOR_CHAT_SOFT',
            },
          });
          log.info({ userId: ctx.userId, itemId: input.id, calendarEventId }, 'organize_delete: soft-deleted (calendar off; GCal skipped)');
          return {
            ok: true,
            output: `Deleted ${input.id} locally. Calendar event was NOT removed (Calendar is OFF for this chat). Either /calendar on + retry delete, or remove it manually from Google Calendar (event id: ${calendarEventId}).`,
            data: { id: input.id, type: item.frontMatter.type, hadCalendar: true, calendarDeleteResult: 'skipped' },
            error: { code: 'CALENDAR_DISABLED_FOR_CHAT_SOFT', message: 'calendar disabled for this chat' },
          };
        }

        // GCal delete first
        const auth = await getAuth();
        if (auth) {
          const calendarId = ctx.config.google.calendar.defaultCalendarId;
          const api = new CalendarApi(auth);

          try {
            await api.deleteEvent({ calendarId, eventId: calendarEventId });
          } catch (gcalErr) {
            const gcalMsg = gcalErr instanceof Error ? gcalErr.message : String(gcalErr);
            // Check for 404/410 (already gone) — treat as success.
            // Prefer numeric code on GaxiosError shape; fall back to string match.
            const gcalErrTyped = gcalErr as { response?: { status?: number }; code?: number | string };
            const numericStatus =
              typeof gcalErrTyped.code === 'number'
                ? gcalErrTyped.code
                : gcalErrTyped.response?.status;
            const isGone =
              numericStatus === 404 ||
              numericStatus === 410 ||
              gcalMsg.includes('status: 404') ||
              gcalMsg.includes('status: 410');

            if (!isGone) {
              log.error({ userId: ctx.userId, itemId: input.id, calendarEventId, err: gcalMsg }, 'organize_delete: GCal delete failed');
              ctx.memory.auditLog.insert({
                category: 'organize.delete',
                actor_chat_id: ctx.chatId,
                actor_user_id: ctx.userId,
                session_id: ctx.sessionId,
                detail: {
                  id: input.id,
                  type: item.frontMatter.type,
                  result: 'failed',
                  reason: 'CALENDAR_DELETE_FAILED',
                },
              });
              return {
                ok: false,
                output: `Couldn't delete the Calendar event: ${gcalMsg}. Local file NOT soft-deleted.`,
                error: { code: 'CALENDAR_DELETE_FAILED', message: gcalMsg },
              };
            }
            // 404/410 — already gone, continue
            log.info({ userId: ctx.userId, itemId: input.id, calendarEventId }, 'organize_delete: GCal event already gone (404/410), proceeding');
          }
        } else {
          // No auth — treat as soft calendar skip but still delete locally
          log.warn({ userId: ctx.userId, itemId: input.id }, 'organize_delete: no GCal auth; deleting locally only');
        }

        // Soft-delete local file (after GCal success)
        try {
          await softDeleteItem(ctx.userId, dataDir, input.id);
        } catch (trashErr) {
          const trashMsg = trashErr instanceof Error ? trashErr.message : String(trashErr);
          const errCode = (trashErr as NodeJS.ErrnoException).code;

          if (errCode === 'ORGANIZE_TRASH_INVALID') {
            ctx.memory.auditLog.insert({
              category: 'organize.delete',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: { id: input.id, result: 'failed', reason: 'ORGANIZE_TRASH_INVALID' },
            });
            return {
              ok: false,
              output: `Storage path error (trash dir invalid): ${trashMsg}`,
              error: { code: 'ORGANIZE_TRASH_INVALID', message: trashMsg },
            };
          }

          // FILE_DELETE_FAILED — GCal succeeded but local rename failed
          log.error({ userId: ctx.userId, itemId: input.id, err: trashMsg }, 'organize_delete: local rename failed after GCal success');
          ctx.memory.auditLog.insert({
            category: 'organize.inconsistency',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              kind: 'orphan-local',
              itemId: input.id,
              rootCause: `GCal delete succeeded but local rename failed: ${trashMsg}`,
            },
          });
          ctx.memory.auditLog.insert({
            category: 'organize.delete',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              id: input.id,
              type: item.frontMatter.type,
              result: 'failed',
              reason: 'FILE_DELETE_FAILED',
            },
          });
          return {
            ok: false,
            output: `Calendar event was deleted but local file rename failed — manual cleanup required at data/organize/${ctx.userId}/${input.id}.md. Error: ${trashMsg}`,
            error: { code: 'FILE_DELETE_FAILED', message: trashMsg },
          };
        }

        ctx.memory.auditLog.insert({
          category: 'organize.delete',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: {
            id: input.id,
            type: item.frontMatter.type,
            result: 'ok',
            calendarSynced: true,
          },
        });
        log.info({ userId: ctx.userId, itemId: input.id, calendarEventId }, 'organize_delete: deleted (GCal + local)');
        return {
          ok: true,
          output: `Deleted ${input.id} (removed from Calendar). Soft-deleted to .trash/ — ask me to restore if this was a mistake.`,
          data: { id: input.id, type: item.frontMatter.type, hadCalendar: true, calendarDeleteResult: 'deleted' },
        };
      }

      // --- Non-event or no calendarEventId: local soft-delete only ---
      try {
        await softDeleteItem(ctx.userId, dataDir, input.id);
      } catch (trashErr) {
        const trashMsg = trashErr instanceof Error ? trashErr.message : String(trashErr);
        const errCode = (trashErr as NodeJS.ErrnoException).code;

        if (errCode === 'ORGANIZE_TRASH_INVALID') {
          ctx.memory.auditLog.insert({
            category: 'organize.delete',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: { id: input.id, result: 'failed', reason: 'ORGANIZE_TRASH_INVALID' },
          });
          return {
            ok: false,
            output: `Storage path error (trash dir invalid): ${trashMsg}`,
            error: { code: 'ORGANIZE_TRASH_INVALID', message: trashMsg },
          };
        }

        log.error({ userId: ctx.userId, itemId: input.id, err: trashMsg }, 'organize_delete: local rename failed');
        ctx.memory.auditLog.insert({
          category: 'organize.delete',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { id: input.id, result: 'failed', reason: 'FILE_DELETE_FAILED' },
        });
        return {
          ok: false,
          output: `Failed to delete item: ${trashMsg}`,
          error: { code: 'FILE_DELETE_FAILED', message: trashMsg },
        };
      }

      ctx.memory.auditLog.insert({
        category: 'organize.delete',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: {
          id: input.id,
          type: item.frontMatter.type,
          result: 'ok',
          calendarSynced: false,
        },
      });
      log.info({ userId: ctx.userId, itemId: input.id }, 'organize_delete: soft-deleted (local only)');
      return {
        ok: true,
        output: `Deleted ${input.id}. Soft-deleted to .trash/ — ask me to restore if this was a mistake.`,
        data: { id: input.id, type: item.frontMatter.type, hadCalendar: false, calendarDeleteResult: 'n/a' },
      };
    },
  };
}
