/**
 * Tests for CalendarApi.listCalendars + createCalendar + extendedProperties
 * support (v1.19.0 ADR 019 D8 + D9 — commit 0e).
 *
 * Pattern mirrors organize.calendar_api.test.ts: inject a mock `_api` object
 * by casting through `unknown` after construction.
 */

import { describe, expect, it, vi } from 'vitest';
import { CalendarApi } from '../../src/google/calendar.js';
import type { OAuth2Client } from 'google-auth-library';

const fakeAuth = {} as OAuth2Client;

// ---------------------------------------------------------------------------
// Mock shape helpers
// ---------------------------------------------------------------------------

type MockCalendarListApi = {
  list: ReturnType<typeof vi.fn>;
};
type MockCalendarsApi = {
  insert: ReturnType<typeof vi.fn>;
};
type MockEventsApi = {
  insert: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

interface MockInternalApi {
  calendarList: MockCalendarListApi;
  calendars: MockCalendarsApi;
  events: MockEventsApi;
}

function buildApiWithMock(): { api: CalendarApi; mock: MockInternalApi } {
  const api = new CalendarApi(fakeAuth);

  const mock: MockInternalApi = {
    calendarList: { list: vi.fn() },
    calendars: { insert: vi.fn() },
    events: { insert: vi.fn(), patch: vi.fn() },
  };

  (api as unknown as { _api: MockInternalApi })._api = mock;
  return { api, mock };
}

// ---------------------------------------------------------------------------
// Fixture responses
// ---------------------------------------------------------------------------

const MOCK_CALENDAR_LIST_RESPONSE = {
  data: {
    items: [
      { id: 'primary', summary: 'My Calendar', accessRole: 'owner', primary: true },
      { id: 'cal_abc123@group.calendar.google.com', summary: 'Jarvis Organize', accessRole: 'owner' },
    ],
    nextPageToken: undefined,
  },
};

const MOCK_EMPTY_CALENDAR_LIST = {
  data: { items: [], nextPageToken: undefined },
};

const MOCK_CREATE_CALENDAR_RESPONSE = {
  data: { id: 'new_cal_xyz@group.calendar.google.com', summary: 'Jarvis Organize' },
};

const MOCK_EVENT_RESPONSE = {
  data: {
    id: 'event123',
    summary: 'Test Event',
    start: { dateTime: '2026-05-01T10:00:00Z' },
    end: { dateTime: '2026-05-01T11:00:00Z' },
    status: 'confirmed',
    extendedProperties: { private: { itemId: '2026-05-01-abcd' } },
    updated: '2026-05-01T09:00:00Z',
  },
};

// ---------------------------------------------------------------------------
// listCalendars
// ---------------------------------------------------------------------------

describe('CalendarApi.listCalendars', () => {
  it('returns normalised CalendarListEntry array from single page', async () => {
    const { api, mock } = buildApiWithMock();
    mock.calendarList.list.mockResolvedValue(MOCK_CALENDAR_LIST_RESPONSE);

    const result = await api.listCalendars();

    expect(mock.calendarList.list).toHaveBeenCalledOnce();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'primary', summary: 'My Calendar', primary: true });
    expect(result[1]).toMatchObject({ id: 'cal_abc123@group.calendar.google.com', summary: 'Jarvis Organize' });
  });

  it('returns empty array when no calendars exist', async () => {
    const { api, mock } = buildApiWithMock();
    mock.calendarList.list.mockResolvedValue(MOCK_EMPTY_CALENDAR_LIST);

    const result = await api.listCalendars();
    expect(result).toHaveLength(0);
  });

  it('follows nextPageToken for paginated results', async () => {
    const { api, mock } = buildApiWithMock();
    // Page 1 has nextPageToken, page 2 does not.
    mock.calendarList.list
      .mockResolvedValueOnce({
        data: {
          items: [{ id: 'cal1', summary: 'First' }],
          nextPageToken: 'token123',
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ id: 'cal2', summary: 'Second' }],
          nextPageToken: undefined,
        },
      });

    const result = await api.listCalendars();
    expect(mock.calendarList.list).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('cal1');
    expect(result[1]!.id).toBe('cal2');
  });

  it('propagates API errors', async () => {
    const { api, mock } = buildApiWithMock();
    mock.calendarList.list.mockRejectedValue(new Error('Google API error'));

    await expect(api.listCalendars()).rejects.toThrow('Google API error');
  });
});

// ---------------------------------------------------------------------------
// createCalendar
// ---------------------------------------------------------------------------

describe('CalendarApi.createCalendar', () => {
  it('creates a calendar and returns the new id', async () => {
    const { api, mock } = buildApiWithMock();
    mock.calendars.insert.mockResolvedValue(MOCK_CREATE_CALENDAR_RESPONSE);

    const result = await api.createCalendar('Jarvis Organize', 'Items synced from Jarvis');

    expect(mock.calendars.insert).toHaveBeenCalledOnce();
    const callArgs = mock.calendars.insert.mock.calls[0]![0] as {
      requestBody: { summary: string; description?: string };
    };
    expect(callArgs.requestBody.summary).toBe('Jarvis Organize');
    expect(callArgs.requestBody.description).toBe('Items synced from Jarvis');
    expect(result.id).toBe('new_cal_xyz@group.calendar.google.com');
  });

  it('creates a calendar without description', async () => {
    const { api, mock } = buildApiWithMock();
    mock.calendars.insert.mockResolvedValue(MOCK_CREATE_CALENDAR_RESPONSE);

    await api.createCalendar('Jarvis Organize');

    const callArgs = mock.calendars.insert.mock.calls[0]![0] as {
      requestBody: { description?: string };
    };
    // description may be undefined or absent — both acceptable
    expect(callArgs.requestBody.description).toBeUndefined();
  });

  it('throws when API returns no id', async () => {
    const { api, mock } = buildApiWithMock();
    mock.calendars.insert.mockResolvedValue({ data: { summary: 'Jarvis Organize' } });

    await expect(api.createCalendar('Jarvis Organize')).rejects.toThrow(/no calendar ID/);
  });

  it('propagates API errors', async () => {
    const { api, mock } = buildApiWithMock();
    mock.calendars.insert.mockRejectedValue(new Error('Quota exceeded'));

    await expect(api.createCalendar('Jarvis Organize')).rejects.toThrow('Quota exceeded');
  });
});

// ---------------------------------------------------------------------------
// createEvent with extendedProperties.private.itemId
// ---------------------------------------------------------------------------

describe('CalendarApi.createEvent — extendedProperties.private.itemId', () => {
  it('includes extendedProperties.private.itemId when itemId is provided', async () => {
    const { api, mock } = buildApiWithMock();
    mock.events.insert.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.createEvent({
      calendarId: 'cal_abc123@group.calendar.google.com',
      summary: 'Test Task',
      startTime: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
      itemId: '2026-05-01-abcd',
    });

    const callArgs = mock.events.insert.mock.calls[0]![0] as {
      requestBody: { extendedProperties?: { private?: Record<string, string> } };
    };
    expect(callArgs.requestBody.extendedProperties?.private?.['itemId']).toBe('2026-05-01-abcd');
  });

  it('does NOT include extendedProperties when itemId is absent', async () => {
    const { api, mock } = buildApiWithMock();
    mock.events.insert.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.createEvent({
      calendarId: 'primary',
      summary: 'No itemId event',
      startTime: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
    });

    const callArgs = mock.events.insert.mock.calls[0]![0] as {
      requestBody: { extendedProperties?: unknown };
    };
    expect(callArgs.requestBody.extendedProperties).toBeUndefined();
  });

  it('normaliseEvent returns itemId from extendedProperties.private', async () => {
    const { api, mock } = buildApiWithMock();
    mock.events.insert.mockResolvedValue(MOCK_EVENT_RESPONSE);

    const result = await api.createEvent({
      calendarId: 'cal_abc123@group.calendar.google.com',
      summary: 'Test Task',
      startTime: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
      itemId: '2026-05-01-abcd',
    });

    // normaliseEvent should extract itemId from the response's extendedProperties
    expect(result.itemId).toBe('2026-05-01-abcd');
    expect(result.updated).toBe('2026-05-01T09:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// updateEvent with extendedProperties.private.itemId
// ---------------------------------------------------------------------------

describe('CalendarApi.updateEvent — extendedProperties.private.itemId', () => {
  it('includes extendedProperties.private.itemId in PATCH when provided', async () => {
    const { api, mock } = buildApiWithMock();
    mock.events.patch.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.updateEvent({
      calendarId: 'cal_abc123@group.calendar.google.com',
      eventId: 'event123',
      summary: 'Updated title',
      itemId: '2026-05-01-abcd',
    });

    const callArgs = mock.events.patch.mock.calls[0]![0] as {
      requestBody: { extendedProperties?: { private?: Record<string, string> } };
    };
    expect(callArgs.requestBody.extendedProperties?.private?.['itemId']).toBe('2026-05-01-abcd');
  });

  it('does NOT include extendedProperties when itemId is absent from PATCH', async () => {
    const { api, mock } = buildApiWithMock();
    mock.events.patch.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.updateEvent({
      calendarId: 'primary',
      eventId: 'event123',
      summary: 'No itemId',
    });

    const callArgs = mock.events.patch.mock.calls[0]![0] as {
      requestBody: { extendedProperties?: unknown };
    };
    expect(callArgs.requestBody.extendedProperties).toBeUndefined();
  });
});
