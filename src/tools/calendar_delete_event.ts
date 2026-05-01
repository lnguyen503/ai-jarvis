/**
 * Tool: calendar_delete_event
 *
 * Delete an existing Google Calendar event. Admin-only — Calendar tools
 * never appear in group chats (stripped at the agent level by the
 * calendar_* filter; no self-check needed per ADR 006 R2).
 *
 * Structural mirror of calendar_create_event.ts. Delegates to the
 * pre-existing CalendarApi.deleteEvent — no new wrapper layer (ADR 006 §12).
 *
 * 404 / 410 handling (ADR 006 R1):
 *   - Returns ok:true with a DISTINGUISHABLE output string and
 *     data.outcome:'404-already-gone' so the caller and audit trail can
 *     tell "successfully deleted" from "event was already gone / id was wrong".
 *   - The system-prompt rule 13 instructs the LLM NOT to paraphrase this as
 *     "I deleted the event" — it must surface the id and let the user verify.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { CalendarApi, isNotFoundError } from '../google/calendar.js';
import type { OAuth2Client } from 'google-auth-library';

const parameters = z.object({
  eventId: z.string().min(1).describe('The Google Calendar event id to delete.'),
  calendarId: z
    .string()
    .optional()
    .describe('Calendar to target. Omit for the configured default ("primary").'),
  notificationLevel: z.enum(['NONE', 'EXTERNAL_ONLY', 'ALL']).default('NONE'),
});

type CalendarDeleteEventInput = z.infer<typeof parameters>;


export function buildCalendarDeleteEventTool(deps: ToolDeps): Tool<CalendarDeleteEventInput> {
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
    name: 'calendar_delete_event',
    description:
      'Delete an event from the user\'s Google Calendar. ' +
      'Use this for events that exist on the calendar but are NOT tracked by /organize ' +
      '(external invites, events from calendar_list_events output, direct eventId references). ' +
      'For /organize-tracked events (those with a calendarEventId in the organize listing), ' +
      'use organize_delete instead — it keeps local organize state and calendar in sync. ' +
      'Returns ok=true on success; also returns ok=true with outcome:"404-already-gone" ' +
      'when the event was not found — do NOT tell the user "deleted" in that case.',
    parameters,
    adminOnly: true,

    async execute(input: CalendarDeleteEventInput, ctx: ToolContext): Promise<ToolResult> {
      const log = ctx.logger.child({ component: 'tools.calendar_delete_event' });

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

      try {
        await api.deleteEvent({
          calendarId,
          eventId: input.eventId,
          notificationLevel: input.notificationLevel,
        });
      } catch (err) {
        // 404 / 410: event already gone — success per ADR 006 R1.
        // Distinguishable output so the LLM cannot paraphrase as "I deleted it."
        if (isNotFoundError(err)) {
          log.info(
            { calendarId, eventId: input.eventId },
            'calendar_delete_event: event not found (404/410) — treating as already-gone',
          );
          return {
            ok: true,
            output:
              `Event ${input.eventId} was not found on calendar "${calendarId}". ` +
              `If this was the event you meant to delete, it's already gone. ` +
              `If the id looks wrong, double-check it against a recent calendar_list_events output.`,
            data: {
              calendarId,
              deletedEventId: input.eventId,
              outcome: '404-already-gone',
            },
          };
        }

        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message, calendarId, eventId: input.eventId },
          'Calendar delete failed',
        );
        return {
          ok: false,
          output: `Couldn't delete the event: ${message}`,
          error: { code: 'GOOGLE_API_ERROR', message },
        };
      }

      log.info(
        { calendarId, eventId: input.eventId },
        'Calendar event deleted',
      );

      return {
        ok: true,
        output: `Deleted event ${input.eventId} from calendar "${calendarId}".`,
        data: {
          calendarId,
          deletedEventId: input.eventId,
          outcome: 'deleted',
        },
      };
    },
  };
}
