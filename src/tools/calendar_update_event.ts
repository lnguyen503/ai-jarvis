/**
 * Tool: calendar_update_event
 *
 * Patch an existing Google Calendar event. Admin-only — Calendar tools
 * never appear in group chats (stripped at the agent level by the
 * calendar_* filter; no self-check needed per ADR 006 R2).
 *
 * Structural mirror of calendar_create_event.ts. Delegates to the
 * pre-existing CalendarApi.updateEvent — no new wrapper layer (ADR 006 §12).
 *
 * PATCH semantics (ADR 006 R10):
 *   - Omit a field → leave unchanged.
 *   - Pass empty string (description, location) → clear that field.
 *   - Pass empty array (attendees) → clear attendee list.
 *   - Pass non-empty attendees array → REPLACE the full list, NOT add.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { CalendarApi, isNotFoundError } from '../google/calendar.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  eventId: z.string().min(1).describe('The Google Calendar event id to update.'),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar to target. Omit for the configured default ("primary").'),
  summary: z.string().optional().describe('New event title.'),
  startTime: z
    .string()
    .optional()
    .describe(
      'ISO 8601 start (or YYYY-MM-DD for allDay). Must be paired with endTime if either is provided.',
    ),
  endTime: z
    .string()
    .optional()
    .describe('ISO 8601 end (exclusive). All-day events: day AFTER last day.'),
  allDay: z
    .boolean()
    .optional()
    .describe(
      'Toggle all-day. If provided, both startTime and endTime must also be provided in the matching shape.',
    ),
  description: z
    .string()
    .optional()
    .describe('New description. Empty string clears the description; omit to leave as-is.'),
  location: z
    .string()
    .optional()
    .describe('New location. Empty string clears; omit to leave as-is.'),
  attendees: z
    .array(z.string().email())
    .optional()
    .describe(
      'REPLACES the attendee list. [] clears attendees; non-empty ARRAY replaces — it does NOT add. To add without replacing, fetch existing via calendar_list_events and pass the union.',
    ),
  timeZone: z.string().optional().describe('IANA TZ for timed events.'),
  notificationLevel: z.enum(['NONE', 'EXTERNAL_ONLY', 'ALL']).default('NONE'),
});

type CalendarUpdateEventInput = z.infer<typeof parameters>;


export function buildCalendarUpdateEventTool(deps: ToolDeps): Tool<CalendarUpdateEventInput> {
  let cachedAuth: OAuth2Client | null = null;
  let triedLoad = false;

  async function getAuth(): Promise<OAuth2Client | null> {
    if (cachedAuth) return cachedAuth;
    if (triedLoad) {
      cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
      return cachedAuth;
    }
    triedLoad = true;
    cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
    return cachedAuth;
  }

  return {
    name: 'calendar_update_event',
    description:
      'Update (patch) an existing event on the user\'s Google Calendar. ' +
      'Use this for events that exist on the calendar but are NOT tracked by /organize ' +
      '(external invites, events from calendar_list_events output, direct eventId references). ' +
      'Fields use PATCH semantics: omit to leave unchanged; pass empty string to clear ' +
      'description/location; pass empty array to clear attendees; pass non-empty attendees ' +
      'array to REPLACE the full list (not add). ' +
      'For /organize-tracked events, use organize_update instead.',
    parameters,
    adminOnly: true,

    async execute(input: CalendarUpdateEventInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.calendar_update_event' });

      const auth = await getAuth();
      if (!auth) {
        const tokenPath = ctx.config.google.oauth.tokenPath;
        const hint = ctx.config.google.oauth.clientId
          ? `Run \`npm run google-auth\` to authorise.`
          : `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env, then run \`npm run google-auth\`.`;
        return {
          ok: false,
          output: `Google Calendar isn't connected yet. ${hint} (token file expected at ${tokenPath})`,
          error: { code: 'GOOGLE_NOT_AUTHORISED', message: 'no oauth credentials on disk' },
        };
      }

      const calendarId = input.calendarId ?? ctx.config.google.calendar.defaultCalendarId;
      const api = new CalendarApi(auth);

      // Build UpdateEventOptions — only include fields the caller supplied.
      const opts: Parameters<typeof api.updateEvent>[0] = {
        calendarId,
        eventId: input.eventId,
      };
      if (input.summary !== undefined) opts.summary = input.summary;
      if (input.startTime !== undefined) opts.startTime = input.startTime;
      if (input.endTime !== undefined) opts.endTime = input.endTime;
      if (input.allDay !== undefined) opts.allDay = input.allDay;
      if (input.description !== undefined) opts.description = input.description;
      if (input.location !== undefined) opts.location = input.location;
      if (input.attendees !== undefined) opts.attendees = input.attendees;
      if (input.timeZone !== undefined) opts.timeZone = input.timeZone;
      opts.notificationLevel = input.notificationLevel;

      let updatedEvent: Awaited<ReturnType<typeof api.updateEvent>>;
      try {
        updatedEvent = await api.updateEvent(opts);
      } catch (err) {
        if (isNotFoundError(err)) {
          log.info(
            { calendarId, eventId: input.eventId },
            'calendar_update_event: event not found (404/410)',
          );
          return {
            ok: false,
            output:
              `Event not found on calendar "${calendarId}". ` +
              `Double-check the id against calendar_list_events.`,
            error: {
              code: 'EVENT_NOT_FOUND',
              message: `Event ${input.eventId} not found on calendar "${calendarId}"`,
            },
          };
        }

        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message, calendarId, eventId: input.eventId },
          'Calendar update failed',
        );
        return {
          ok: false,
          output: `Couldn't update the event: ${message}`,
          error: { code: 'GOOGLE_API_ERROR', message },
        };
      }

      const lines: string[] = [`Updated "${updatedEvent.summary}"`];
      if (updatedEvent.start) {
        const when = updatedEvent.allDay
          ? `${updatedEvent.start} (all day)`
          : `${updatedEvent.start}${updatedEvent.end ? ` → ${updatedEvent.end}` : ''}`;
        lines.push(`   when: ${when}`);
      }
      if (updatedEvent.location) lines.push(`   where: ${updatedEvent.location}`);
      if (updatedEvent.attendees && updatedEvent.attendees.length > 0) {
        lines.push(`   attendees: ${updatedEvent.attendees.join(', ')}`);
      }
      if (updatedEvent.hangoutLink) lines.push(`   meet: ${updatedEvent.hangoutLink}`);
      if (updatedEvent.htmlLink) lines.push(`   link: ${updatedEvent.htmlLink}`);

      log.info(
        { calendarId, eventId: updatedEvent.id, summary: updatedEvent.summary },
        'Calendar event updated',
      );

      return {
        ok: true,
        output: lines.join('\n'),
        data: { calendarId, eventId: updatedEvent.id },
      };
    },
  };
}
