/**
 * Tool: organize_create — create a task, event, or goal for the user.
 *
 * For type=event: creates the Google Calendar event FIRST (ADR 003 §6),
 * then writes the local file. If the file write fails after a successful
 * GCal create, compensates by calling deleteEvent on GCal.
 *
 * For type=task/goal: local file write only (no GCal interaction).
 *
 * Privacy filter runs on every user-supplied free-text field before any
 * write (new-content-only per CP1 R5; all fields are new on create).
 * Cap check: at most 200 active items per user (ADR 003 §2, §10).
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolContext, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { CalendarApi, isCalendarEnabledForChat } from '../google/calendar.js';
import { filterOrganizeField } from '../organize/privacy.js';
import { createItem, isBelowActiveCap, countActiveItems } from '../organize/storage.js';
import { OrganizeTypeSchema, TagListSchema, ItemIdSchema, getDataDir } from './organize_shared.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  type: OrganizeTypeSchema.describe('Item type: task, event, or goal.'),
  title: z.string().min(1).max(500).describe('Short title for the item.'),
  due: z
    .string()
    .optional()
    .describe('ISO date (YYYY-MM-DD) for tasks/goals; ISO datetime for events.'),
  // event-only
  endTime: z
    .string()
    .optional()
    .describe('Event end time (ISO 8601). Required for type=event when allDay=false.'),
  allDay: z.boolean().optional().describe('If true, the GCal event is all-day.'),
  location: z.string().max(500).optional().describe('Physical address or virtual link.'),
  attendees: z
    .array(z.string().email())
    .max(50)
    .optional()
    .describe('Email addresses to invite (event only).'),
  timeZone: z.string().optional().describe('IANA TZ (e.g. "America/Los_Angeles").'),
  notes: z.string().max(5000).optional().describe('Free-form notes / body.'),
  tags: TagListSchema.describe('Up to 10 tags, each ≤40 chars.'),
  parentId: ItemIdSchema.optional().describe('Id of a parent goal (optional).'),
});

type OrganizeCreateInput = z.infer<typeof parameters>;

export function buildOrganizeCreateTool(deps: ToolDeps): Tool<OrganizeCreateInput> {
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
    name: 'organize_create',
    description:
      'Create a new task, event, or goal in the user\'s /organize list. ' +
      'For type=event, also creates the event on Google Calendar (if enabled). ' +
      'Privacy-filtered: rejects credentials, phone numbers, disease/prescription terms.',
    parameters,
    adminOnly: false,

    async execute(input: OrganizeCreateInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.organize_create' });

      // Guard: userId required.
      if (!ctx.userId || !Number.isFinite(ctx.userId)) {
        return {
          ok: false,
          output: "Jarvis couldn't identify you for this action. /organize requires a DM with a user we can identify. If this came from a scheduled task created before v1.10.0, recreate it — the new task will carry your user id automatically.",
          error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
        };
      }

      const dataDir = getDataDir(ctx);

      // --- type=event: fast-fail if /calendar is off ---
      if (input.type === 'event') {
        if (!isCalendarEnabledForChat(ctx.chatId)) {
          ctx.memory.auditLog.insert({
            category: 'organize.create',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              type: 'event',
              result: 'failed',
              reason: 'CALENDAR_DISABLED_FOR_CHAT',
              calendarSkipped: true,
            },
          });
          return {
            ok: false,
            output: 'Google Calendar is OFF for this chat. Say `/calendar on` first, or create this as type=task.',
            error: { code: 'CALENDAR_DISABLED_FOR_CHAT', message: 'calendar disabled for this chat' },
          };
        }
      }

      // --- Privacy filter: every user-supplied free-text field ---
      const titleFilter = filterOrganizeField('title', input.title);
      if (!titleFilter.ok) {
        log.info({ userId: ctx.userId, reason: titleFilter.reason }, 'organize_create: title rejected by privacy filter');
        ctx.memory.auditLog.insert({
          category: 'organize.create',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: {
            type: input.type,
            result: 'rejected',
            reason: titleFilter.reason,
          },
        });
        return {
          ok: false,
          output: `Refused to create: title — ${titleFilter.reason}.`,
          error: { code: 'PRIVACY_FILTER_REJECTED', message: titleFilter.reason },
        };
      }

      if (input.notes !== undefined) {
        const notesFilter = filterOrganizeField('notes', input.notes);
        if (!notesFilter.ok) {
          log.info({ userId: ctx.userId, reason: notesFilter.reason }, 'organize_create: notes rejected by privacy filter');
          ctx.memory.auditLog.insert({
            category: 'organize.create',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              type: input.type,
              result: 'rejected',
              reason: notesFilter.reason,
            },
          });
          return {
            ok: false,
            output: `Refused to create: notes — ${notesFilter.reason}.`,
            error: { code: 'PRIVACY_FILTER_REJECTED', message: notesFilter.reason },
          };
        }
      }

      if (input.tags) {
        for (const tag of input.tags) {
          const tagFilter = filterOrganizeField('tag', tag);
          if (!tagFilter.ok) {
            log.info({ userId: ctx.userId, reason: tagFilter.reason }, 'organize_create: tag rejected by privacy filter');
            ctx.memory.auditLog.insert({
              category: 'organize.create',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                type: input.type,
                result: 'rejected',
                reason: tagFilter.reason,
              },
            });
            return {
              ok: false,
              output: `Refused to create: tag — ${tagFilter.reason}.`,
              error: { code: 'PRIVACY_FILTER_REJECTED', message: tagFilter.reason },
            };
          }
        }
      }

      if (input.attendees) {
        for (const attendee of input.attendees) {
          const attendeeFilter = filterOrganizeField('attendee', attendee);
          if (!attendeeFilter.ok) {
            log.info({ userId: ctx.userId, reason: attendeeFilter.reason }, 'organize_create: attendee rejected by privacy filter');
            ctx.memory.auditLog.insert({
              category: 'organize.create',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                type: input.type,
                result: 'rejected',
                reason: attendeeFilter.reason,
              },
            });
            return {
              ok: false,
              output: `Refused to create: attendee — ${attendeeFilter.reason}.`,
              error: { code: 'PRIVACY_FILTER_REJECTED', message: attendeeFilter.reason },
            };
          }
        }
      }

      // --- Type-shape guard: goals are top-level (R13 BLOCKING from CP1 v1.14.3) ---
      // Goals must not have a parentId. Pre-v1.14.3, this was silently accepted and stored;
      // v1.14.3 ships a hierarchy renderer that drops goal-with-parent items silently (they
      // don't appear in flat group-header rendering). The fix is a create-time guard that
      // rejects the invalid shape before any disk write occurs.
      if (input.type === 'goal' && input.parentId) {
        ctx.memory.auditLog.insert({
          category: 'organize.create',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { type: 'goal', result: 'rejected', reason: 'GOAL_CANNOT_HAVE_PARENT' },
        });
        return {
          ok: false,
          output: 'Goals are top-level; only tasks and events can have a parent goal.',
          error: { code: 'GOAL_CANNOT_HAVE_PARENT', message: 'goal with parentId rejected' },
        };
      }

      // --- Cap check: max 200 active items ---
      // v1.9.1: use the fast `isBelowActiveCap` helper which skips the full
      // front-matter parse when total .md file count is already below cap.
      // Falls through to the strict `countActiveItems` exactly when needed.
      let belowCap: boolean;
      try {
        belowCap = await isBelowActiveCap(ctx.userId, dataDir, 200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ userId: ctx.userId, err: msg }, 'organize_create: failed to check active cap');
        return {
          ok: false,
          output: `Failed to check active item count: ${msg}`,
          error: { code: 'FILE_WRITE_FAILED', message: msg },
        };
      }

      if (!belowCap) {
        // v1.10.0 R4: distinguish "at cap" vs "couldn't verify cap"
        // isBelowActiveCap returns false on both a real cap breach AND a readdir
        // error (fail-closed). We do a best-effort exact count to distinguish:
        // if the count confirms ≥200 active items → real cap exceeded.
        // If the count itself also fails (or is < 200) → readdir is broken → surface actionable error.
        const exactCount = await countActiveItems(ctx.userId, dataDir).catch(() => -1);
        if (exactCount >= 0 && exactCount >= 200) {
          ctx.memory.auditLog.insert({
            category: 'organize.create',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              type: input.type,
              result: 'failed',
              reason: 'ACTIVE_CAP_EXCEEDED',
            },
          });
          return {
            ok: false,
            output: 'You have 200 active items — complete or delete some before creating new ones.',
            error: { code: 'ACTIVE_CAP_EXCEEDED', message: 'active item cap (200) reached' },
          };
        }
        // Couldn't verify the cap — readdir error path
        log.warn({ userId: ctx.userId, exactCount }, 'organize_create: isBelowActiveCap failed; could not verify cap');
        ctx.memory.auditLog.insert({
          category: 'organize.create',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: {
            type: input.type,
            result: 'failed',
            reason: 'ACTIVE_CAP_CHECK_FAILED',
          },
        });
        return {
          ok: false,
          output: "Couldn't verify your item cap right now — please try again in a moment.",
          error: { code: 'ACTIVE_CAP_CHECK_FAILED', message: "Couldn't verify your item cap right now — please try again in a moment." },
        };
      }

      // v1.9.1: the 150-threshold approaching-cap warn was dropped to preserve
      // the fast-path savings (we no longer have the exact count cheap).
      // Filed as a v1.9.2 follow-up for a separate telemetry path if needed.

      // --- type=event: validate required event fields ---
      if (input.type === 'event') {
        const startTime = input.due; // for events, 'due' is the startTime
        const endTime = input.endTime;
        const allDay = input.allDay ?? false;

        if (!allDay) {
          if (!startTime || !endTime) {
            ctx.memory.auditLog.insert({
              category: 'organize.create',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                type: 'event',
                result: 'failed',
                reason: 'MISSING_EVENT_FIELDS',
              },
            });
            return {
              ok: false,
              output: 'Events require both a start time (due) and an end time. Please provide both.',
              error: { code: 'MISSING_EVENT_FIELDS', message: 'startTime and endTime required for timed events' },
            };
          }
        } else {
          // all-day: require start date
          if (!startTime) {
            ctx.memory.auditLog.insert({
              category: 'organize.create',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                type: 'event',
                result: 'failed',
                reason: 'MISSING_EVENT_FIELDS',
              },
            });
            return {
              ok: false,
              output: 'All-day events require a start date (due). Please provide it.',
              error: { code: 'MISSING_EVENT_FIELDS', message: 'startTime required for all-day events' },
            };
          }
        }

        // --- GCal create (event path) ---
        const auth = await getAuth();
        if (!auth) {
          ctx.memory.auditLog.insert({
            category: 'organize.create',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              type: 'event',
              result: 'failed',
              reason: 'CALENDAR_CREATE_FAILED',
            },
          });
          return {
            ok: false,
            output: 'Google Calendar isn\'t connected. Run `npm run google-auth` to authorise.',
            error: { code: 'CALENDAR_CREATE_FAILED', message: 'no oauth credentials on disk' },
          };
        }

        const calendarId = ctx.config.google.calendar.defaultCalendarId;
        const api = new CalendarApi(auth);

        let gcalEventId: string;
        let gcalHtmlLink: string | undefined;

        try {
          const event = await api.createEvent({
            calendarId,
            summary: titleFilter.value,
            startTime: startTime!,
            endTime: endTime ?? startTime!,
            allDay: input.allDay,
            description: input.notes,
            location: input.location,
            attendees: input.attendees,
            timeZone: input.timeZone,
          });
          gcalEventId = event.id;
          gcalHtmlLink = event.htmlLink;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err: msg, calendarId }, 'organize_create: GCal createEvent failed');
          ctx.memory.auditLog.insert({
            category: 'organize.create',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: {
              type: 'event',
              result: 'failed',
              reason: 'CALENDAR_CREATE_FAILED',
            },
          });
          return {
            ok: false,
            output: `Couldn't create the Calendar event: ${msg}`,
            error: { code: 'CALENDAR_CREATE_FAILED', message: msg },
          };
        }

        // --- Write local file with calendarEventId ---
        let item;
        try {
          item = await createItem(ctx.userId, dataDir, {
            type: 'event',
            title: titleFilter.value,
            due: startTime,
            calendarEventId: gcalEventId,
            tags: input.tags,
            notes: input.notes,
            parentId: input.parentId,
          });
        } catch (fileErr) {
          const fileMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
          log.error({ err: fileMsg, gcalEventId }, 'organize_create: file write failed after GCal success; attempting rollback');

          // Compensating delete
          try {
            await api.deleteEvent({ calendarId, eventId: gcalEventId });
            log.info({ gcalEventId }, 'organize_create: rollback GCal delete succeeded');

            ctx.memory.auditLog.insert({
              category: 'organize.create',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                type: 'event',
                result: 'failed',
                reason: 'FILE_WRITE_FAILED_EVENT_ROLLED_BACK',
                calendarSynced: false,
              },
            });
            return {
              ok: false,
              output: `Event created on Calendar but local file write failed. Calendar event was rolled back. Error: ${fileMsg}`,
              error: { code: 'FILE_WRITE_FAILED_EVENT_ROLLED_BACK', message: fileMsg },
            };
          } catch (rollbackErr) {
            const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            log.error({ err: rollbackMsg, gcalEventId }, 'organize_create: rollback GCal delete ALSO failed — orphan');

            // Emit inconsistency audit row
            ctx.memory.auditLog.insert({
              category: 'organize.inconsistency',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                kind: 'orphan-gcal',
                eventId: gcalEventId,
                rootCause: `file write failed: ${fileMsg}; rollback failed: ${rollbackMsg}`,
              },
            });
            ctx.memory.auditLog.insert({
              category: 'organize.create',
              actor_chat_id: ctx.chatId,
              actor_user_id: ctx.userId,
              session_id: ctx.sessionId,
              detail: {
                type: 'event',
                result: 'failed',
                reason: 'FILE_WRITE_FAILED_EVENT_ORPHANED',
                calendarSynced: false,
              },
            });
            return {
              ok: false,
              output: `Event created on Calendar but local file write failed AND rollback failed. You have an orphan calendar event id: ${gcalEventId}. Delete it manually from Google Calendar.`,
              error: { code: 'FILE_WRITE_FAILED_EVENT_ORPHANED', message: `eventId=${gcalEventId}` },
            };
          }
        }

        const itemId = item.frontMatter.id;
        const dueStr = input.due ? ` — due ${input.due}` : '';
        const calStr = ` (synced to Calendar)`;

        ctx.memory.auditLog.insert({
          category: 'organize.create',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: {
            id: itemId,
            type: 'event',
            result: 'ok',
            calendarSynced: true,
          },
        });

        log.info({ userId: ctx.userId, itemId, gcalEventId }, 'organize_create: event created');

        return {
          ok: true,
          output: `Created event: "${titleFilter.value}"${dueStr}. id=${itemId}${calStr}.`,
          data: { id: itemId, type: 'event', status: 'active', calendarEventId: gcalEventId, htmlLink: gcalHtmlLink },
        };
      }

      // --- type=task or type=goal (no GCal) ---
      let item;
      try {
        item = await createItem(ctx.userId, dataDir, {
          type: input.type,
          title: titleFilter.value,
          due: input.due,
          tags: input.tags,
          notes: input.notes,
          parentId: input.parentId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errCode = (err as NodeJS.ErrnoException).code;

        if (errCode === 'ORGANIZE_USER_DIR_SYMLINK') {
          ctx.memory.auditLog.insert({
            category: 'organize.create',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: { type: input.type, result: 'failed', reason: 'ORGANIZE_USER_DIR_SYMLINK' },
          });
          return {
            ok: false,
            output: `Storage path error: ${msg}`,
            error: { code: 'ORGANIZE_USER_DIR_SYMLINK', message: msg },
          };
        }

        if (errCode === 'ID_COLLISION') {
          ctx.memory.auditLog.insert({
            category: 'organize.create',
            actor_chat_id: ctx.chatId,
            actor_user_id: ctx.userId,
            session_id: ctx.sessionId,
            detail: { type: input.type, result: 'failed', reason: 'ID_COLLISION' },
          });
          return {
            ok: false,
            output: `Failed to generate a unique item id: ${msg}`,
            error: { code: 'ID_COLLISION', message: msg },
          };
        }

        log.error({ userId: ctx.userId, err: msg }, 'organize_create: file write failed');
        ctx.memory.auditLog.insert({
          category: 'organize.create',
          actor_chat_id: ctx.chatId,
          actor_user_id: ctx.userId,
          session_id: ctx.sessionId,
          detail: { type: input.type, result: 'failed', reason: 'FILE_WRITE_FAILED' },
        });
        return {
          ok: false,
          output: `Failed to create item: ${msg}`,
          error: { code: 'FILE_WRITE_FAILED', message: msg },
        };
      }

      const itemId = item.frontMatter.id;
      const dueStr = input.due ? ` — due ${input.due}` : '';

      ctx.memory.auditLog.insert({
        category: 'organize.create',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: {
          id: itemId,
          type: input.type,
          result: 'ok',
          calendarSynced: false,
        },
      });

      log.info({ userId: ctx.userId, itemId, type: input.type }, 'organize_create: created');

      return {
        ok: true,
        output: `Created ${input.type}: "${titleFilter.value}"${dueStr}. id=${itemId}.`,
        data: { id: itemId, type: input.type, status: 'active', calendarEventId: null },
      };
    },
  };
}
