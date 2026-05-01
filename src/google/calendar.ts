/**
 * Google Calendar API wrapper.
 *
 * Thin layer on top of googleapis: takes a pre-authenticated OAuth2Client
 * (from `loadGoogleAuth`), exposes the operations Jarvis tools need, and
 * normalises responses into plain objects so tools don't have to know about
 * googleapis internals.
 *
 * MVP surface: list_events + create/update/delete events + listCalendars +
 * createCalendar + extendedProperties support (v1.19.0 ADR 019 D8/D9).
 */

import { google, calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export interface ListEventsOptions {
  calendarId: string;
  startTime?: string; // ISO 8601; defaults to now in the API
  endTime?: string;   // ISO 8601
  maxResults?: number;
  query?: string;     // free-text search across summary/description/location/attendees
  timeZone?: string;  // IANA TZ; defaults to the calendar's TZ
}

export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string | null;        // ISO 8601 datetime, or YYYY-MM-DD for all-day
  end: string | null;
  allDay: boolean;
  location?: string;
  description?: string;
  attendees?: string[];        // email addresses
  htmlLink?: string;           // canonical event URL
  status?: string;             // confirmed | tentative | cancelled
  hangoutLink?: string;        // Google Meet URL when present
  /** v1.19.0 ADR 019 D9 — app-internal itemId for round-trip identity. undefined when absent. */
  itemId?: string;
  /** v1.19.0 — Google's event last-modified timestamp (RFC 3339). Used for conflict resolution (D7). */
  updated?: string;
  /** v1.20.0 ADR 020 D6.c — Google's recurringEventId; set on recurring event instances. */
  recurringEventId?: string;
}

export interface CreateEventOptions {
  calendarId: string;
  summary: string;
  startTime: string;           // ISO 8601 datetime, OR YYYY-MM-DD when allDay
  endTime: string;             // exclusive end (Google convention)
  allDay?: boolean;
  description?: string;
  location?: string;
  attendees?: string[];        // email addresses
  timeZone?: string;           // IANA TZ; required when start/end are timezone-naive ISO strings
  addGoogleMeetUrl?: boolean;
  notificationLevel?: 'NONE' | 'EXTERNAL_ONLY' | 'ALL';
  /**
   * v1.19.0 ADR 019 D9 — app-internal round-trip identity.
   * ONLY the itemId is stored; NO PII (no title, no notes, no email).
   * extendedProperties.shared is never set by Jarvis.
   */
  itemId?: string;
}

/**
 * v1.19.0 ADR 019 D8 — Calendar list entry (minimal fields for ensureJarvisCalendar).
 */
export interface CalendarListEntry {
  id: string;
  summary: string;
  accessRole?: string;
  primary?: boolean;
}

/**
 * Options for patching an existing Calendar event (§16.4).
 * PATCH semantics: only fields present are sent to Google. undefined = leave as-is.
 * null is not accepted — use empty string to clear a description.
 */
export interface UpdateEventOptions {
  calendarId: string;
  eventId: string;
  /** PATCH: only supplied if caller wants to change the summary. */
  summary?: string;
  /** ISO 8601 datetime (timed) or YYYY-MM-DD (all-day). Must be paired with endTime. */
  startTime?: string;
  /** ISO 8601 datetime (timed) or YYYY-MM-DD (all-day). Must be paired with startTime. */
  endTime?: string;
  /** If toggled, start/end must also be provided in the matching shape or the call throws. */
  allDay?: boolean;
  description?: string;
  location?: string;
  /** Full-replace semantics: omitting = leave as-is; [] = clear all attendees. */
  attendees?: string[];
  timeZone?: string;
  notificationLevel?: 'NONE' | 'EXTERNAL_ONLY' | 'ALL';
  /**
   * v1.19.0 ADR 019 D9 — update the app-internal round-trip identity.
   * ONLY the itemId is stored; NO PII.
   */
  itemId?: string;
}

/**
 * Options for deleting a Calendar event (§16.4).
 */
export interface DeleteEventOptions {
  calendarId: string;
  eventId: string;
  notificationLevel?: 'NONE' | 'EXTERNAL_ONLY' | 'ALL';
}

/**
 * Returns true if the error shape indicates a Google 404 (event not found)
 * or 410 (gone). Used by calendar_* tools to translate to tool-level codes.
 */
export function isNotFoundError(err: unknown): boolean {
  if (!(err && typeof err === 'object')) return false;
  const e = err as {
    code?: number | string;
    response?: { status?: number };
    errors?: Array<{ reason?: string }>;
  };
  if (e.code === 404 || e.code === 410 || e.code === '404' || e.code === '410') return true;
  if (e.response?.status === 404 || e.response?.status === 410) return true;
  if (e.errors?.[0]?.reason === 'notFound') return true;
  return false;
}

export class CalendarApi {
  private readonly _api: calendar_v3.Calendar;

  constructor(auth: OAuth2Client) {
    this._api = google.calendar({ version: 'v3', auth });
  }

  /**
   * Create a new event on a calendar.
   *
   * Adds a Google Meet link when `addGoogleMeetUrl` is true (requires
   * conferenceDataVersion=1 on the request — Google's API quirk). All-day
   * events use `start.date` / `end.date` (YYYY-MM-DD); timed events use
   * `start.dateTime` / `end.dateTime` plus optional timezone.
   *
   * Returns the normalised event so the caller can show the user what was
   * created (including the htmlLink and any Meet URL).
   */
  async createEvent(opts: CreateEventOptions): Promise<CalendarEventSummary> {
    const requestBody: calendar_v3.Schema$Event = {
      summary: opts.summary,
      description: opts.description,
      location: opts.location,
      attendees: opts.attendees?.map((email) => ({ email })),
    };

    if (opts.allDay) {
      requestBody.start = { date: opts.startTime };
      requestBody.end = { date: opts.endTime };
    } else {
      requestBody.start = { dateTime: opts.startTime, timeZone: opts.timeZone };
      requestBody.end = { dateTime: opts.endTime, timeZone: opts.timeZone };
    }

    if (opts.addGoogleMeetUrl) {
      requestBody.conferenceData = {
        createRequest: {
          // requestId must be unique per request; uuid-style is fine.
          requestId: `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    // v1.19.0 ADR 019 D9: app-internal round-trip identity via extendedProperties.
    // ONLY itemId stored; NO PII. extendedProperties.shared never set.
    if (opts.itemId !== undefined) {
      requestBody.extendedProperties = {
        private: { itemId: opts.itemId },
      };
    }

    const res = await this._api.events.insert({
      calendarId: opts.calendarId,
      conferenceDataVersion: opts.addGoogleMeetUrl ? 1 : 0,
      sendUpdates: opts.notificationLevel === 'ALL' ? 'all' : opts.notificationLevel === 'EXTERNAL_ONLY' ? 'externalOnly' : 'none',
      requestBody,
    });

    return normaliseEvent(res.data);
  }

  /**
   * List events on a calendar within an optional time window.
   *
   * Wraps Google's events.list with `singleEvents:true` so recurring events
   * are expanded into individual instances (what users expect when they ask
   * "what's on my calendar?"), ordered by start time.
   */
  async listEvents(opts: ListEventsOptions): Promise<CalendarEventSummary[]> {
    const res = await this._api.events.list({
      calendarId: opts.calendarId,
      timeMin: opts.startTime,
      timeMax: opts.endTime,
      maxResults: opts.maxResults ?? 25,
      singleEvents: true,
      orderBy: 'startTime',
      q: opts.query,
      timeZone: opts.timeZone,
    });

    const items = res.data.items ?? [];
    return items.map(normaliseEvent);
  }

  /**
   * Patch an existing Calendar event using Google's events.patch API.
   *
   * Only fields supplied by the caller are sent to Google — undefined fields
   * are left unchanged server-side (true PATCH semantics). If `allDay` is
   * explicitly provided, both `startTime` and `endTime` must also be provided
   * in the matching shape (date-only for all-day, datetime for timed), or
   * this method throws before making an API call.
   *
   * Scope: the fields /organize currently syncs. Other event properties
   * (reminders, colorId, recurrence) are deliberately not exposed.
   *
   * Returns the normalised updated event, or throws on API failure.
   */
  async updateEvent(opts: UpdateEventOptions): Promise<CalendarEventSummary> {
    // Validate: if allDay is toggled, both start and end must be provided.
    if (opts.allDay !== undefined) {
      if (opts.startTime === undefined || opts.endTime === undefined) {
        throw new Error(
          'updateEvent: when allDay is specified, both startTime and endTime must be provided',
        );
      }
    }

    const requestBody: calendar_v3.Schema$Event = {};

    if (opts.summary !== undefined) {
      requestBody.summary = opts.summary;
    }
    if (opts.description !== undefined) {
      requestBody.description = opts.description;
    }
    if (opts.location !== undefined) {
      requestBody.location = opts.location;
    }
    if (opts.attendees !== undefined) {
      requestBody.attendees = opts.attendees.map((email) => ({ email }));
    }

    // v1.19.0 ADR 019 D9: update extendedProperties.private.itemId when provided.
    // ONLY itemId; NO PII. extendedProperties.shared never set.
    if (opts.itemId !== undefined) {
      requestBody.extendedProperties = {
        private: { itemId: opts.itemId },
      };
    }

    // Start/end: only set when either allDay is explicitly provided or
    // start/end times are provided (caller can patch times without touching allDay).
    if (opts.startTime !== undefined || opts.endTime !== undefined || opts.allDay !== undefined) {
      const useAllDay = opts.allDay === true;

      if (opts.startTime !== undefined) {
        requestBody.start = useAllDay
          ? { date: opts.startTime }
          : { dateTime: opts.startTime, timeZone: opts.timeZone };
      }
      if (opts.endTime !== undefined) {
        requestBody.end = useAllDay
          ? { date: opts.endTime }
          : { dateTime: opts.endTime, timeZone: opts.timeZone };
      }
    }

    const sendUpdates =
      opts.notificationLevel === 'ALL'
        ? 'all'
        : opts.notificationLevel === 'EXTERNAL_ONLY'
          ? 'externalOnly'
          : 'none';

    const res = await this._api.events.patch({
      calendarId: opts.calendarId,
      eventId: opts.eventId,
      sendUpdates,
      requestBody,
    });

    return normaliseEvent(res.data);
  }

  /**
   * v1.19.0 ADR 019 D8 — List all calendars for the authenticated user.
   *
   * Wraps Google's calendarList.list() with pageToken support (cap 10 pages /
   * 1000 calendars per ADR D8). Used by ensureJarvisCalendar to find-or-create
   * the "Jarvis Organize" calendar.
   */
  async listCalendars(): Promise<CalendarListEntry[]> {
    const entries: CalendarListEntry[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;
    const PAGE_CAP = 10;

    while (pageCount < PAGE_CAP) {
      const res = await this._api.calendarList.list({
        pageToken,
        maxResults: 100,
      });
      const items = res.data.items ?? [];
      for (const item of items) {
        if (item.id && item.summary) {
          entries.push({
            id: item.id,
            summary: item.summary,
            accessRole: item.accessRole ?? undefined,
            primary: item.primary ?? undefined,
          });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
      pageCount++;
      if (!pageToken) break;
    }

    return entries;
  }

  /**
   * v1.19.0 ADR 019 D8 — Create a new calendar in the authenticated user's account.
   *
   * Returns the new calendar's ID. Used by ensureJarvisCalendar when no
   * "Jarvis Organize" calendar exists. Idempotent via find-then-create in
   * the sync module.
   */
  async createCalendar(summary: string, description?: string): Promise<{ id: string }> {
    const res = await this._api.calendars.insert({
      requestBody: {
        summary,
        description,
      },
    });
    if (!res.data.id) {
      throw new Error(`createCalendar: Google API returned no calendar ID for summary "${summary}"`);
    }
    return { id: res.data.id };
  }

  /**
   * Delete a Calendar event.
   *
   * Resolves with void on success (HTTP 204). Google's 404/410 responses
   * (event already gone) are propagated as errors — the caller
   * (organize_delete) is responsible for treating those as success.
   *
   * All other errors propagate faithfully.
   */
  async deleteEvent(opts: DeleteEventOptions): Promise<void> {
    const sendUpdates =
      opts.notificationLevel === 'ALL'
        ? 'all'
        : opts.notificationLevel === 'EXTERNAL_ONLY'
          ? 'externalOnly'
          : 'none';

    await this._api.events.delete({
      calendarId: opts.calendarId,
      eventId: opts.eventId,
      sendUpdates,
    });
  }
}

/**
 * Per-chat toggle for the calendar tools (v1.7.11.2). Mirrors the
 * voice/vision pattern. Default is ENABLED — the set holds chats that have
 * been explicitly disabled. Empty set = enabled everywhere. In-memory only;
 * resets on restart (persistence is on the TODO list alongside voice/vision).
 */
const calendarDisabledChats = new Set<number>();

export function isCalendarEnabledForChat(chatId: number): boolean {
  return !calendarDisabledChats.has(chatId);
}

export function setCalendarEnabledForChat(chatId: number, enabled: boolean): void {
  if (enabled) calendarDisabledChats.delete(chatId);
  else calendarDisabledChats.add(chatId);
}

/** Test-only: clear the toggle state. Not exported to runtime callers. */
export function _resetCalendarToggle(): void {
  calendarDisabledChats.clear();
}

function normaliseEvent(ev: calendar_v3.Schema$Event): CalendarEventSummary {
  // Google returns either { dateTime, timeZone } (timed) or { date }
  // (all-day). Normalise to a single string each side and a boolean flag.
  const startDateTime = ev.start?.dateTime ?? ev.start?.date ?? null;
  const endDateTime = ev.end?.dateTime ?? ev.end?.date ?? null;
  const allDay = Boolean(ev.start?.date && !ev.start.dateTime);

  // v1.19.0 ADR 019 D9: extract itemId from extendedProperties.private for round-trip identity.
  const itemId = ev.extendedProperties?.private?.['itemId'] ?? undefined;

  return {
    id: ev.id ?? '',
    summary: ev.summary ?? '(no title)',
    start: startDateTime,
    end: endDateTime,
    allDay,
    location: ev.location ?? undefined,
    description: ev.description ?? undefined,
    attendees: ev.attendees?.map((a) => a.email ?? '').filter(Boolean),
    htmlLink: ev.htmlLink ?? undefined,
    status: ev.status ?? undefined,
    hangoutLink: ev.hangoutLink ?? undefined,
    itemId: typeof itemId === 'string' ? itemId : undefined,
    updated: ev.updated ?? undefined,
    recurringEventId: ev.recurringEventId ?? undefined,
  };
}
