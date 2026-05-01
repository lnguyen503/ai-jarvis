/**
 * Tests for the calendar_update_event tool.
 *
 * Mocking pattern mirrors organize.tools.test.ts: CalendarApi is mocked with
 * a function constructor so `new CalendarApi(auth)` works correctly, and
 * per-test behaviour is set by reassigning the module-scoped spy functions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ToolDeps, ToolContext } from '../../src/tools/types.js';
import type { AppConfig } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that load the mocked modules.
// ---------------------------------------------------------------------------

// Spy functions per-method — reassigned in individual tests via .mockResolvedValue etc.
const mockUpdateEvent = vi.fn();

vi.mock('../../src/google/calendar.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/google/calendar.js')>();
  return {
    ...original,
    CalendarApi: vi.fn().mockImplementation(function (this: unknown) {
      (this as Record<string, unknown>).updateEvent = (...args: unknown[]) =>
        mockUpdateEvent(...args);
    }),
  };
});

vi.mock('../../src/google/oauth.js', () => ({
  loadGoogleAuth: vi.fn(),
}));

import { loadGoogleAuth } from '../../src/google/oauth.js';
import { buildCalendarUpdateEventTool } from '../../src/tools/calendar_update_event.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

const mockLoadGoogleAuth = vi.mocked(loadGoogleAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' });

function makeDeps(cfg: AppConfig): ToolDeps {
  return {
    config: cfg,
    logger: silentLogger,
    safety: {} as ToolDeps['safety'],
    memory: {} as ToolDeps['memory'],
  };
}

function makeCtx(cfg: AppConfig): ToolContext {
  return {
    sessionId: 1,
    chatId: 2,
    logger: silentLogger,
    config: cfg,
    memory: {} as ToolContext['memory'],
    safety: {
      scrub: (s: string) => s,
      scrubRecord: (r: object) => r,
    } as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
  };
}

function fakeUpdatedEvent(overrides: object = {}) {
  return {
    id: 'event-abc-123',
    summary: 'Updated Meeting',
    start: '2026-04-17T14:00:00-07:00',
    end: '2026-04-17T15:00:00-07:00',
    allDay: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calendar_update_event — no auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEvent.mockReset();
  });

  it('returns GOOGLE_NOT_AUTHORISED when clientId is missing (no token path hint)', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = '';
    cfg.google.oauth.clientSecret = '';
    mockLoadGoogleAuth.mockResolvedValue(null);

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('GOOGLE_OAUTH_CLIENT_ID');
  });

  it('returns GOOGLE_NOT_AUTHORISED with run-google-auth hint when clientId set but no token', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    cfg.google.oauth.clientSecret = 'fake-secret';
    mockLoadGoogleAuth.mockResolvedValue(null);

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('npm run google-auth');
    expect(result.output).not.toContain('GOOGLE_OAUTH_CLIENT_ID');
  });
});

describe('calendar_update_event — partial update (happy path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEvent.mockReset();
  });

  it('passes only the supplied fields to updateEvent', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    mockUpdateEvent.mockResolvedValue(fakeUpdatedEvent());

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', summary: 'New Title', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    expect(mockUpdateEvent).toHaveBeenCalledOnce();
    const callArgs = mockUpdateEvent.mock.calls[0][0];
    expect(callArgs.eventId).toBe('evt-001');
    expect(callArgs.summary).toBe('New Title');
    // calendarId should default to 'primary' from config
    expect(callArgs.calendarId).toBe('primary');
    // fields not passed should be absent (patch semantics)
    expect(callArgs.description).toBeUndefined();
    expect(callArgs.location).toBeUndefined();
    expect(callArgs.attendees).toBeUndefined();
  });

  it('includes calendarId and eventId in the returned data', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    mockUpdateEvent.mockResolvedValue(fakeUpdatedEvent());

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', summary: 'Updated', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    expect(result.data?.calendarId).toBe('primary');
    expect(result.data?.eventId).toBe('event-abc-123');
  });
});

describe('calendar_update_event — attendees semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEvent.mockReset();
  });

  it('passes attendees: [] to updateEvent when caller sends empty array (clear semantics)', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    mockUpdateEvent.mockResolvedValue(fakeUpdatedEvent({ attendees: [] }));

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', attendees: [], notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    const callArgs = mockUpdateEvent.mock.calls[0][0];
    // Must forward the empty array — not undefined — so Google clears attendees
    expect(callArgs.attendees).toEqual([]);
  });
});

describe('calendar_update_event — 404 (EVENT_NOT_FOUND)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEvent.mockReset();
  });

  it('returns ok:false, code:EVENT_NOT_FOUND when Google returns 404 via .code', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const notFoundErr = Object.assign(new Error('Not Found'), { code: 404 });
    mockUpdateEvent.mockRejectedValue(notFoundErr);

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-unknown', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EVENT_NOT_FOUND');
    expect(result.output).toContain('not found');
    expect(result.output).toContain('calendar_list_events');
  });

  it('returns EVENT_NOT_FOUND for response.status 404 shape (GaxiosError format)', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const notFoundErr = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mockUpdateEvent.mockRejectedValue(notFoundErr);

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-unknown', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EVENT_NOT_FOUND');
  });
});

describe('calendar_update_event — other errors (GOOGLE_API_ERROR)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEvent.mockReset();
  });

  it('returns ok:false, code:GOOGLE_API_ERROR for a 500 server error', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const serverErr = Object.assign(new Error('Internal Server Error'), { code: 500 });
    mockUpdateEvent.mockRejectedValue(serverErr);

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_API_ERROR');
    expect(result.output).toContain('Internal Server Error');
  });

  it('returns GOOGLE_API_ERROR for a network-level error (no code property)', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const networkErr = new Error('ECONNREFUSED');
    mockUpdateEvent.mockRejectedValue(networkErr);

    const tool = buildCalendarUpdateEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_API_ERROR');
  });
});

describe('calendar_update_event — input schema', () => {
  it('rejects missing eventId', () => {
    const tool = buildCalendarUpdateEventTool(makeDeps(makeTestConfig()));
    expect(tool.parameters.safeParse({}).success).toBe(false);
  });

  it('rejects empty string eventId', () => {
    const tool = buildCalendarUpdateEventTool(makeDeps(makeTestConfig()));
    expect(tool.parameters.safeParse({ eventId: '' }).success).toBe(false);
  });

  it('accepts the minimum valid shape (eventId only)', () => {
    const tool = buildCalendarUpdateEventTool(makeDeps(makeTestConfig()));
    expect(tool.parameters.safeParse({ eventId: 'abc' }).success).toBe(true);
  });

  it('rejects malformed attendee emails', () => {
    const tool = buildCalendarUpdateEventTool(makeDeps(makeTestConfig()));
    expect(
      tool.parameters.safeParse({
        eventId: 'abc',
        attendees: ['valid@example.com', 'not-an-email'],
      }).success,
    ).toBe(false);
  });

  it('is adminOnly:true', () => {
    const tool = buildCalendarUpdateEventTool(makeDeps(makeTestConfig()));
    expect(tool.adminOnly).toBe(true);
  });
});
