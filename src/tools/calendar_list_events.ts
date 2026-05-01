/**
 * Tool: calendar_list_events
 *
 * Read events from the user's Google Calendar within an optional time window.
 * Admin-only — Calendar tools never appear in group chats. The OAuth flow is
 * a one-time setup the user runs via `npm run google-auth`; once tokens are
 * on disk, this tool calls Google directly.
 *
 * Returns a human-readable list (one line per event) plus structured `data`
 * for any downstream consumer.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { CalendarApi, type CalendarEventSummary } from '../google/calendar.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  startTime: z
    .string()
    .optional()
    .describe(
      'ISO 8601 lower bound (inclusive) for event end time. Defaults to "now". ' +
        'Examples: "2026-04-17T00:00:00-07:00", "2026-04-17T07:00:00Z".',
    ),
  endTime: z
    .string()
    .optional()
    .describe('ISO 8601 upper bound (exclusive) for event start time. Omit for "no upper limit".'),
  maxResults: z.number().int().min(1).max(50).default(10),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar to query. Omit to use the configured default ("primary").'),
  query: z
    .string()
    .optional()
    .describe('Free-text search across title, description, location, attendees.'),
  timeZone: z
    .string()
    .optional()
    .describe('IANA TZ name (e.g. "America/Los_Angeles"). Defaults to the calendar\'s TZ.'),
});

type CalendarListEventsInput = z.infer<typeof parameters>;

/**
 * Build the tool with deps closed over. Followed the recall_archive pattern
 * but with a factory because we need a single shared OAuth2Client across
 * tool invocations (token refresh state lives on it).
 */
export function buildCalendarListEventsTool(deps: ToolDeps): Tool<CalendarListEventsInput> {
  // Lazy: don't load auth until first call. Keeps boot fast and lets the
  // user fix the token file without restarting Jarvis.
  let cachedAuth: OAuth2Client | null = null;
  let triedLoad = false;

  async function getAuth(): Promise<OAuth2Client | null> {
    if (cachedAuth) return cachedAuth;
    if (triedLoad) {
      // Re-attempt: maybe the user just ran the auth CLI. Cheap retry.
      cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
      return cachedAuth;
    }
    triedLoad = true;
    cachedAuth = await loadGoogleAuth(deps.config, deps.logger);
    return cachedAuth;
  }

  return {
    name: 'calendar_list_events',
    description:
      'List events from the user\'s Google Calendar. ' +
      'Use this for any question about upcoming meetings, today\'s schedule, ' +
      'free/busy times, or to search for a specific event. ' +
      'Returns events ordered by start time with title, start, end, location, and link.',
    parameters,
    adminOnly: true,

    async execute(input: CalendarListEventsInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.calendar_list_events' });

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

      let events: CalendarEventSummary[];
      try {
        events = await api.listEvents({
          calendarId,
          startTime: input.startTime,
          endTime: input.endTime,
          maxResults: input.maxResults,
          query: input.query,
          timeZone: input.timeZone,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, calendarId }, 'Calendar API call failed');
        return {
          ok: false,
          output: `Calendar query failed: ${message}`,
          error: { code: 'GOOGLE_API_ERROR', message },
        };
      }

      if (events.length === 0) {
        const window = describeWindow(input.startTime, input.endTime);
        return {
          ok: true,
          output: `No events found ${window} on calendar "${calendarId}".`,
          data: { calendarId, count: 0 },
        };
      }

      const lines = events.map(formatEventLine);
      const header = `${events.length} event${events.length === 1 ? '' : 's'} on "${calendarId}":`;
      const output = [header, '', ...lines].join('\n');

      log.info({ calendarId, count: events.length }, 'Calendar list_events complete');

      return {
        ok: true,
        output,
        data: { calendarId, count: events.length },
      };
    },
  };
}

function formatEventLine(ev: CalendarEventSummary): string {
  const when = formatTimeRange(ev.start, ev.end, ev.allDay);
  const parts: string[] = [`• ${when} — ${ev.summary}`];
  if (ev.location) parts.push(`    📍 ${ev.location}`);
  if (ev.attendees && ev.attendees.length > 0) {
    const shown = ev.attendees.slice(0, 3).join(', ');
    const more = ev.attendees.length > 3 ? ` (+${ev.attendees.length - 3} more)` : '';
    parts.push(`    👥 ${shown}${more}`);
  }
  if (ev.htmlLink) parts.push(`    🔗 ${ev.htmlLink}`);
  return parts.join('\n');
}

function formatTimeRange(start: string | null, end: string | null, allDay: boolean): string {
  if (!start) return '(no start time)';
  if (allDay) {
    if (end && end !== start) return `${start} → ${end} (all day)`;
    return `${start} (all day)`;
  }
  const startStr = start.replace('T', ' ').replace(/:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/, '');
  const endStr = end ? end.replace('T', ' ').replace(/:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/, '') : '';
  return endStr ? `${startStr} → ${endStr}` : startStr;
}

function describeWindow(startTime?: string, endTime?: string): string {
  if (!startTime && !endTime) return 'in the upcoming window';
  if (startTime && endTime) return `between ${startTime} and ${endTime}`;
  if (startTime) return `after ${startTime}`;
  return `before ${endTime}`;
}
