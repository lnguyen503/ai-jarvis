/**
 * Tool: calendar_create_event
 *
 * Add a new event to the user's Google Calendar. Admin-only — Calendar tools
 * never appear in group chats.
 *
 * MVP: timed and all-day events, attendees, optional Google Meet link.
 * Update / delete are separate tools (TODO) so destructive ops can route
 * through the existing confirmation flow without entangling create's UX.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { CalendarApi, type CalendarEventSummary } from '../google/calendar.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  summary: z.string().min(1).describe('Event title.'),
  startTime: z
    .string()
    .min(1)
    .describe(
      'ISO 8601 start. For timed events: "2026-04-17T14:00:00-07:00" or "2026-04-17T21:00:00Z". ' +
        'For all-day events (allDay=true): "2026-04-17".',
    ),
  endTime: z
    .string()
    .min(1)
    .describe(
      'ISO 8601 end (exclusive). For all-day events the end date is the day AFTER the last day ' +
        '(e.g. "2026-04-18" for an event on the 17th).',
    ),
  allDay: z.boolean().default(false),
  description: z.string().optional().describe('Free-form notes / agenda.'),
  location: z.string().optional().describe('Physical address or virtual link.'),
  attendees: z
    .array(z.string().email())
    .optional()
    .describe('Email addresses to invite.'),
  timeZone: z
    .string()
    .optional()
    .describe(
      'IANA TZ (e.g. "America/Los_Angeles") used when start/end are timezone-naive ISO strings. ' +
        'Ignored for allDay events. Defaults to the calendar\'s timezone.',
    ),
  addGoogleMeetUrl: z
    .boolean()
    .default(false)
    .describe('If true, attach a Google Meet conference link.'),
  notificationLevel: z
    .enum(['NONE', 'EXTERNAL_ONLY', 'ALL'])
    .default('NONE')
    .describe(
      'Whether to email invitations to attendees: NONE (silent), EXTERNAL_ONLY, or ALL.',
    ),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar to add the event to. Omit for the configured default ("primary").'),
});

type CalendarCreateEventInput = z.infer<typeof parameters>;

export function buildCalendarCreateEventTool(deps: ToolDeps): Tool<CalendarCreateEventInput> {
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
    name: 'calendar_create_event',
    description:
      'Create a new event on the user\'s Google Calendar. ' +
      'Use this when the user asks to schedule, add, book, or set up a meeting/event/reminder. ' +
      'Returns the created event\'s title, time, link, and (if requested) Meet URL.',
    parameters,
    adminOnly: true,

    async execute(input: CalendarCreateEventInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.calendar_create_event' });

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

      let event: CalendarEventSummary;
      try {
        event = await api.createEvent({
          calendarId,
          summary: input.summary,
          startTime: input.startTime,
          endTime: input.endTime,
          allDay: input.allDay,
          description: input.description,
          location: input.location,
          attendees: input.attendees,
          timeZone: input.timeZone,
          addGoogleMeetUrl: input.addGoogleMeetUrl,
          notificationLevel: input.notificationLevel,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, calendarId, summary: input.summary }, 'Calendar create failed');
        return {
          ok: false,
          output: `Couldn't create the event: ${message}`,
          error: { code: 'GOOGLE_API_ERROR', message },
        };
      }

      const lines: string[] = [`✅ Created "${event.summary}"`];
      if (event.start) {
        const when = event.allDay
          ? `${event.start} (all day)`
          : `${event.start}${event.end ? ` → ${event.end}` : ''}`;
        lines.push(`   when: ${when}`);
      }
      if (event.location) lines.push(`   where: ${event.location}`);
      if (event.attendees && event.attendees.length > 0) {
        lines.push(`   attendees: ${event.attendees.join(', ')}`);
      }
      if (event.hangoutLink) lines.push(`   meet: ${event.hangoutLink}`);
      if (event.htmlLink) lines.push(`   link: ${event.htmlLink}`);

      log.info(
        { calendarId, eventId: event.id, summary: event.summary },
        'Calendar event created',
      );

      return {
        ok: true,
        output: lines.join('\n'),
        data: { calendarId, eventId: event.id },
      };
    },
  };
}
