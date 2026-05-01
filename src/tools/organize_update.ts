/**
 * Tool: organize_update — patch-style update of an existing organize item.
 *
 * Only new (changed) content runs through the privacy filter (CP1 R5).
 * Pre-existing persisted title/notes/tags are NOT re-validated.
 *
 * For event items with sync-relevant field changes, attempts to update
 * Google Calendar. On GCal failure, returns ok:true with a soft-warning
 * code (CALENDAR_SYNC_FAILED_SOFT) — local state is correct.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { CalendarApi, isCalendarEnabledForChat } from '../google/calendar.js';
import { filterOrganizeField } from '../organize/privacy.js';
import { readItem, updateItem } from '../organize/storage.js';
import { OrganizeStatusSchema, TagListSchema, ItemIdSchema, getDataDir } from './organize_shared.js';
import type { OAuth2Client } from 'google-auth-library';

// Sync-relevant fields (ADR 003 §6): changes to these trigger GCal updateEvent.
const GCAL_SYNC_FIELDS = new Set(['title', 'due', 'endTime', 'allDay', 'location', 'attendees', 'timeZone']);

const parameters = z.object({
  id: ItemIdSchema.describe('Item id (YYYY-MM-DD-xxxx).'),
  title: z.string().min(1).max(500).optional().describe('New title (privacy-filtered).'),
  due: z.string().optional().describe('New due date / start time.'),
  status: OrganizeStatusSchema.optional().describe('New status: active, done, or abandoned.'),
  notes: z.string().max(5000).optional().describe('Replace the Notes body.'),
  tags: TagListSchema.describe('Replace the tags list.'),
  // event-only
  endTime: z.string().optional().describe('New event end time.'),
  allDay: z.boolean().optional().describe('Toggle all-day semantics.'),
  location: z.string().max(500).optional().describe('New location.'),
  attendees: z.array(z.string().email()).max(50).optional().describe('New attendees list (full replace).'),
  timeZone: z.string().optional().describe('New IANA timezone.'),
});

type OrganizeUpdateInput = z.infer<typeof parameters>;

export function buildOrganizeUpdateTool(deps: ToolDeps): Tool<OrganizeUpdateInput> {
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
    name: 'organize_update',
    description:
      'Update an existing organize item (task, event, or goal). ' +
      'Supports partial updates — only supplied fields are changed. ' +
      'For event items, syncs relevant field changes to Google Calendar.',
    parameters,
    adminOnly: false,

    async execute(input: OrganizeUpdateInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.organize_update' });

      if (!ctx.userId || !Number.isFinite(ctx.userId)) {
        return {
          ok: false,
          output: "Jarvis couldn't identify you for this action. /organize requires a DM with a user we can identify. If this came from a scheduled task created before v1.10.0 or without an owner, recreate the task via `schedule` — the new task will carry your user id automatically.",
          error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
        };
      }

      const dataDir = getDataDir(ctx);

      // --- Read existing item ---
      let item;
      try {
        item = await readItem(ctx.userId, dataDir, input.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === 'ITEM_MALFORMED') {
          ctx.memory.auditLog.insert({
            category: 'organize.update',
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
          category: 'organize.update',
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
          category: 'organize.update',
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

      // --- Privacy filter — only NEW content (R5) ---
      if (input.title !== undefined) {
        const f = filterOrganizeField('title', input.title);
        if (!f.ok) {
          log.info({ userId: ctx.userId, reason: f.reason }, 'organize_update: title rejected');
          ctx.memory.auditLog.insert({
            category: 'organize.update',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: { id: input.id, result: 'rejected', reason: f.reason },
          });
          return {
            ok: false,
            output: `Refused to update: title — ${f.reason}.`,
            error: { code: 'PRIVACY_FILTER_REJECTED', message: f.reason },
          };
        }
        input = { ...input, title: f.value };
      }

      if (input.notes !== undefined) {
        const f = filterOrganizeField('notes', input.notes);
        if (!f.ok) {
          log.info({ userId: ctx.userId, reason: f.reason }, 'organize_update: notes rejected');
          ctx.memory.auditLog.insert({
            category: 'organize.update',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: { id: input.id, result: 'rejected', reason: f.reason },
          });
          return {
            ok: false,
            output: `Refused to update: notes — ${f.reason}.`,
            error: { code: 'PRIVACY_FILTER_REJECTED', message: f.reason },
          };
        }
        input = { ...input, notes: f.value };
      }

      if (input.tags !== undefined) {
        for (const tag of input.tags) {
          const f = filterOrganizeField('tag', tag);
          if (!f.ok) {
            log.info({ userId: ctx.userId, reason: f.reason }, 'organize_update: tag rejected');
            ctx.memory.auditLog.insert({
              category: 'organize.update',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: { id: input.id, result: 'rejected', reason: f.reason },
            });
            return {
              ok: false,
              output: `Refused to update: tag — ${f.reason}.`,
              error: { code: 'PRIVACY_FILTER_REJECTED', message: f.reason },
            };
          }
        }
      }

      if (input.attendees !== undefined) {
        for (const a of input.attendees) {
          const f = filterOrganizeField('attendee', a);
          if (!f.ok) {
            log.info({ userId: ctx.userId, reason: f.reason }, 'organize_update: attendee rejected');
            ctx.memory.auditLog.insert({
              category: 'organize.update',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: { id: input.id, result: 'rejected', reason: f.reason },
            });
            return {
              ok: false,
              output: `Refused to update: attendee — ${f.reason}.`,
              error: { code: 'PRIVACY_FILTER_REJECTED', message: f.reason },
            };
          }
        }
      }

      // --- Determine changed fields ---
      const changedFields: string[] = [];
      const fm = item.frontMatter;

      if (input.title !== undefined && input.title !== fm.title) changedFields.push('title');
      if (input.due !== undefined && input.due !== fm.due) changedFields.push('due');
      if (input.status !== undefined && input.status !== fm.status) changedFields.push('status');
      if (input.notes !== undefined) changedFields.push('notes'); // always considered changed if supplied
      if (input.tags !== undefined) changedFields.push('tags');
      if (input.endTime !== undefined) changedFields.push('endTime');
      if (input.allDay !== undefined) changedFields.push('allDay');
      if (input.location !== undefined) changedFields.push('location');
      if (input.attendees !== undefined) changedFields.push('attendees');
      if (input.timeZone !== undefined) changedFields.push('timeZone');

      if (changedFields.length === 0) {
        ctx.memory.auditLog.insert({
          category: 'organize.update',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { id: input.id, type: fm.type, result: 'ok', reason: 'NO_CHANGES', fieldsChanged: [] },
        });
        return {
          ok: true,
          output: 'No changes needed — all fields already at those values.',
          data: { id: input.id, changedFields: [] },
        };
      }

      // --- Write local file ---
      try {
        await updateItem(ctx.userId, dataDir, input.id, {
          title: input.title,
          due: input.due,
          status: input.status,
          notes: input.notes,
          tags: input.tags,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errCode = (err as NodeJS.ErrnoException).code;

        if (errCode === 'ITEM_MALFORMED') {
          ctx.memory.auditLog.insert({
            category: 'organize.update',
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

        log.error({ userId: ctx.userId, itemId: input.id, err: msg }, 'organize_update: file write failed');
        ctx.memory.auditLog.insert({
          category: 'organize.update',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { id: input.id, result: 'failed', reason: 'FILE_WRITE_FAILED' },
        });
        return {
          ok: false,
          output: `Failed to update item: ${msg}`,
          error: { code: 'FILE_WRITE_FAILED', message: msg },
        };
      }

      // --- GCal sync (event items with sync-relevant field changes) ---
      const hasSyncRelevantChange = changedFields.some((f) => GCAL_SYNC_FIELDS.has(f));
      const hasCalendarEventId = Boolean(fm.calendarEventId);

      if (fm.type === 'event' && hasSyncRelevantChange && hasCalendarEventId) {
        // Check calendar toggle
        if (!isCalendarEnabledForChat(ctx.chatId)) {
          ctx.memory.auditLog.insert({
            category: 'organize.update',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              id: input.id,
              type: 'event',
              result: 'ok',
              reason: 'CALENDAR_DISABLED_FOR_CHAT_SOFT',
              calendarSkipped: true,
              fieldsChanged: changedFields,
            },
          });
          return {
            ok: true,
            output: `Updated ${input.id}. Fields changed: ${changedFields.join(', ')}. Calendar sync skipped (Calendar is OFF for this chat).`,
            data: { id: input.id, changedFields, calendarSynced: false, calendarSoftFailed: false },
            error: { code: 'CALENDAR_DISABLED_FOR_CHAT_SOFT', message: 'calendar disabled for this chat' },
          };
        }

        // Attempt GCal patch
        const auth = await getAuth();
        if (auth) {
          const calendarId = ctx.config.google.calendar.defaultCalendarId;
          const api = new CalendarApi(auth);

          try {
            await api.updateEvent({
              calendarId,
              eventId: fm.calendarEventId!,
              summary: input.title,
              startTime: input.due,
              endTime: input.endTime,
              allDay: input.allDay,
              location: input.location,
              attendees: input.attendees,
              timeZone: input.timeZone,
            });

            ctx.memory.auditLog.insert({
              category: 'organize.update',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                id: input.id,
                type: 'event',
                result: 'ok',
                calendarSynced: true,
                fieldsChanged: changedFields,
              },
            });
            log.info({ userId: ctx.userId, itemId: input.id, changedFields }, 'organize_update: updated + GCal synced');
            return {
              ok: true,
              output: `Updated ${input.id}. Fields changed: ${changedFields.join(', ')} (synced to Calendar).`,
              data: { id: input.id, changedFields, calendarSynced: true, calendarSoftFailed: false },
            };
          } catch (gcalErr) {
            const gcalMsg = gcalErr instanceof Error ? gcalErr.message : String(gcalErr);
            log.warn({ userId: ctx.userId, itemId: input.id, err: gcalMsg }, 'organize_update: GCal sync failed (soft)');
            ctx.memory.auditLog.insert({
              category: 'organize.update',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                id: input.id,
                type: 'event',
                result: 'ok',
                reason: 'CALENDAR_SYNC_FAILED_SOFT',
                calendarSynced: false,
                fieldsChanged: changedFields,
              },
            });
            return {
              ok: true,
              output: `Updated ${input.id} locally. Fields changed: ${changedFields.join(', ')}. Calendar sync failed — will retry on next update.`,
              data: { id: input.id, changedFields, calendarSynced: false, calendarSoftFailed: true },
              error: { code: 'CALENDAR_SYNC_FAILED_SOFT', message: gcalMsg },
            };
          }
        }

        // No auth — soft fail
        ctx.memory.auditLog.insert({
          category: 'organize.update',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: {
            id: input.id,
            type: 'event',
            result: 'ok',
            reason: 'CALENDAR_SYNC_FAILED_SOFT',
            calendarSynced: false,
            fieldsChanged: changedFields,
          },
        });
        return {
          ok: true,
          output: `Updated ${input.id} locally. Fields changed: ${changedFields.join(', ')}. Calendar sync failed (not authorized) — will retry on next update.`,
          data: { id: input.id, changedFields, calendarSynced: false, calendarSoftFailed: true },
          error: { code: 'CALENDAR_SYNC_FAILED_SOFT', message: 'no oauth credentials' },
        };
      }

      // Non-event or no sync-relevant changes
      ctx.memory.auditLog.insert({
        category: 'organize.update',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: {
          id: input.id,
          type: fm.type,
          result: 'ok',
          calendarSynced: false,
          fieldsChanged: changedFields,
        },
      });
      log.info({ userId: ctx.userId, itemId: input.id, changedFields }, 'organize_update: updated (no GCal)');
      return {
        ok: true,
        output: `Updated ${input.id}. Fields changed: ${changedFields.join(', ')}.`,
        data: { id: input.id, changedFields, calendarSynced: false, calendarSoftFailed: false },
      };
    },
  };
}
