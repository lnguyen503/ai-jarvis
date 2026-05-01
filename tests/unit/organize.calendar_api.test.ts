/**
 * Tests for CalendarApi.updateEvent and CalendarApi.deleteEvent (§16.11.8)
 *
 * We do NOT have real OAuth credentials in tests; instead we inject a mock
 * `_api` object by casting through `unknown`. Pattern: replace the private
 * `_api` field on the instance after construction with a mock that records
 * calls and returns canned responses.
 */

import { describe, expect, it, vi } from 'vitest';
import { CalendarApi } from '../../src/google/calendar.js';
import type { UpdateEventOptions, DeleteEventOptions } from '../../src/google/calendar.js';
import type { OAuth2Client } from 'google-auth-library';

// ---------------------------------------------------------------------------
// Mock OAuth2Client (CalendarApi just passes it to google.calendar — we will
// override `_api` directly so the auth client doesn't need to work).
// ---------------------------------------------------------------------------
const fakeAuth = {} as OAuth2Client;

// ---------------------------------------------------------------------------
// Helper: build a CalendarApi with a mock _api
// ---------------------------------------------------------------------------

interface MockEventsApi {
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function buildApiWithMock(): { api: CalendarApi; mockEvents: MockEventsApi } {
  const api = new CalendarApi(fakeAuth);

  const mockEvents: MockEventsApi = {
    patch: vi.fn(),
    delete: vi.fn(),
  };

  // Inject mock _api. CalendarApi stores _api as a private property.
  // We cast to access it.
  (api as unknown as { _api: { events: MockEventsApi } })._api = {
    events: mockEvents,
  };

  return { api, mockEvents };
}

// ---------------------------------------------------------------------------
// Normalised event return fixture
// ---------------------------------------------------------------------------

const MOCK_EVENT_RESPONSE = {
  data: {
    id: 'event123',
    summary: 'Updated Event',
    start: { dateTime: '2026-05-01T10:00:00Z' },
    end: { dateTime: '2026-05-01T11:00:00Z' },
    location: 'Conference Room',
    description: 'Notes here',
    attendees: [{ email: 'alice@example.com' }],
    htmlLink: 'https://calendar.google.com/event123',
    status: 'confirmed',
  },
};

// ---------------------------------------------------------------------------
// updateEvent — maps UpdateEventOptions to events.patch
// ---------------------------------------------------------------------------

describe('CalendarApi.updateEvent', () => {
  it('calls events.patch with exactly the supplied fields (summary only)', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.patch.mockResolvedValue(MOCK_EVENT_RESPONSE);

    const opts: UpdateEventOptions = {
      calendarId: 'primary',
      eventId: 'event123',
      summary: 'New Title',
    };

    const result = await api.updateEvent(opts);

    expect(mockEvents.patch).toHaveBeenCalledOnce();
    const callArgs = mockEvents.patch.mock.calls[0]![0] as {
      calendarId: string;
      eventId: string;
      sendUpdates: string;
      requestBody: Record<string, unknown>;
    };
    expect(callArgs.calendarId).toBe('primary');
    expect(callArgs.eventId).toBe('event123');
    expect(callArgs.requestBody.summary).toBe('New Title');
    // description/location should NOT be set (undefined → not in body).
    expect(callArgs.requestBody.description).toBeUndefined();
    expect(callArgs.requestBody.location).toBeUndefined();

    expect(result.id).toBe('event123');
    expect(result.summary).toBe('Updated Event');
  });

  it('maps attendees correctly (email objects)', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.patch.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.updateEvent({
      calendarId: 'primary',
      eventId: 'event123',
      attendees: ['bob@example.com', 'carol@example.com'],
    });

    const callArgs = mockEvents.patch.mock.calls[0]![0] as {
      requestBody: { attendees?: Array<{ email: string }> };
    };
    expect(callArgs.requestBody.attendees).toEqual([
      { email: 'bob@example.com' },
      { email: 'carol@example.com' },
    ]);
  });

  it('maps allDay=true to start.date / end.date', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.patch.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.updateEvent({
      calendarId: 'primary',
      eventId: 'event123',
      allDay: true,
      startTime: '2026-05-01',
      endTime: '2026-05-02',
    });

    const callArgs = mockEvents.patch.mock.calls[0]![0] as {
      requestBody: {
        start?: { date?: string; dateTime?: string };
        end?: { date?: string; dateTime?: string };
      };
    };
    expect(callArgs.requestBody.start?.date).toBe('2026-05-01');
    expect(callArgs.requestBody.start?.dateTime).toBeUndefined();
    expect(callArgs.requestBody.end?.date).toBe('2026-05-02');
  });

  it('maps allDay=false to start.dateTime / end.dateTime', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.patch.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.updateEvent({
      calendarId: 'primary',
      eventId: 'event123',
      allDay: false,
      startTime: '2026-05-01T10:00:00Z',
      endTime: '2026-05-01T11:00:00Z',
      timeZone: 'America/Los_Angeles',
    });

    const callArgs = mockEvents.patch.mock.calls[0]![0] as {
      requestBody: {
        start?: { date?: string; dateTime?: string; timeZone?: string };
      };
    };
    expect(callArgs.requestBody.start?.dateTime).toBe('2026-05-01T10:00:00Z');
    expect(callArgs.requestBody.start?.timeZone).toBe('America/Los_Angeles');
    expect(callArgs.requestBody.start?.date).toBeUndefined();
  });

  it('throws when allDay is provided but startTime is missing', async () => {
    const { api } = buildApiWithMock();

    await expect(
      api.updateEvent({
        calendarId: 'primary',
        eventId: 'event123',
        allDay: true,
        endTime: '2026-05-02',
        // startTime missing
      }),
    ).rejects.toThrow(/startTime.*endTime|allDay/i);
  });

  it('throws when allDay is provided but endTime is missing', async () => {
    const { api } = buildApiWithMock();

    await expect(
      api.updateEvent({
        calendarId: 'primary',
        eventId: 'event123',
        allDay: false,
        startTime: '2026-05-01T10:00:00Z',
        // endTime missing
      }),
    ).rejects.toThrow(/startTime.*endTime|allDay/i);
  });

  it('maps notificationLevel ALL → sendUpdates=all', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.patch.mockResolvedValue(MOCK_EVENT_RESPONSE);

    await api.updateEvent({
      calendarId: 'primary',
      eventId: 'event123',
      notificationLevel: 'ALL',
    });

    const callArgs = mockEvents.patch.mock.calls[0]![0] as { sendUpdates: string };
    expect(callArgs.sendUpdates).toBe('all');
  });

  it('propagates errors from events.patch', async () => {
    const { api, mockEvents } = buildApiWithMock();
    const apiError = Object.assign(new Error('Google API error'), { code: 500 });
    mockEvents.patch.mockRejectedValue(apiError);

    await expect(
      api.updateEvent({ calendarId: 'primary', eventId: 'event123', summary: 'Test' }),
    ).rejects.toThrow('Google API error');
  });
});

// ---------------------------------------------------------------------------
// deleteEvent — maps DeleteEventOptions to events.delete
// ---------------------------------------------------------------------------

describe('CalendarApi.deleteEvent', () => {
  it('calls events.delete with correct calendarId and eventId', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.delete.mockResolvedValue({ data: '' });

    const opts: DeleteEventOptions = {
      calendarId: 'primary',
      eventId: 'event-to-delete',
    };

    await api.deleteEvent(opts);

    expect(mockEvents.delete).toHaveBeenCalledOnce();
    const callArgs = mockEvents.delete.mock.calls[0]![0] as {
      calendarId: string;
      eventId: string;
      sendUpdates: string;
    };
    expect(callArgs.calendarId).toBe('primary');
    expect(callArgs.eventId).toBe('event-to-delete');
  });

  it('resolves with void on success', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.delete.mockResolvedValue({ data: '' });

    const result = await api.deleteEvent({ calendarId: 'primary', eventId: 'evt1' });
    expect(result).toBeUndefined();
  });

  it('propagates 404 error faithfully (caller handles)', async () => {
    const { api, mockEvents } = buildApiWithMock();
    const notFoundError = Object.assign(new Error('Not Found'), { code: 404 });
    mockEvents.delete.mockRejectedValue(notFoundError);

    await expect(api.deleteEvent({ calendarId: 'primary', eventId: 'gone' })).rejects.toMatchObject(
      { code: 404 },
    );
  });

  it('propagates 410 error faithfully (caller handles)', async () => {
    const { api, mockEvents } = buildApiWithMock();
    const goneError = Object.assign(new Error('Gone'), { code: 410 });
    mockEvents.delete.mockRejectedValue(goneError);

    await expect(api.deleteEvent({ calendarId: 'primary', eventId: 'gone' })).rejects.toMatchObject(
      { code: 410 },
    );
  });

  it('propagates non-404 errors faithfully', async () => {
    const { api, mockEvents } = buildApiWithMock();
    const serverError = Object.assign(new Error('Internal Server Error'), { code: 500 });
    mockEvents.delete.mockRejectedValue(serverError);

    await expect(api.deleteEvent({ calendarId: 'primary', eventId: 'evt1' })).rejects.toMatchObject(
      { code: 500 },
    );
  });

  it('maps notificationLevel EXTERNAL_ONLY → sendUpdates=externalOnly', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.delete.mockResolvedValue({ data: '' });

    await api.deleteEvent({
      calendarId: 'primary',
      eventId: 'evt1',
      notificationLevel: 'EXTERNAL_ONLY',
    });

    const callArgs = mockEvents.delete.mock.calls[0]![0] as { sendUpdates: string };
    expect(callArgs.sendUpdates).toBe('externalOnly');
  });

  it('maps notificationLevel NONE → sendUpdates=none (default)', async () => {
    const { api, mockEvents } = buildApiWithMock();
    mockEvents.delete.mockResolvedValue({ data: '' });

    await api.deleteEvent({ calendarId: 'primary', eventId: 'evt1' });

    const callArgs = mockEvents.delete.mock.calls[0]![0] as { sendUpdates: string };
    expect(callArgs.sendUpdates).toBe('none');
  });
});
