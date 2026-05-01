/**
 * Tests for the calendar_delete_event tool.
 *
 * Mocking pattern mirrors organize.tools.test.ts: CalendarApi is mocked with
 * a function constructor so `new CalendarApi(auth)` works correctly, and
 * per-test behaviour is set by reassigning the module-scoped spy functions.
 *
 * Key behaviors tested:
 *   - Happy path: resolves → ok:true, data.outcome:'deleted'
 *   - 404: throws with code 404 → ok:true, data.outcome:'404-already-gone' (ADR 006 R1)
 *   - 410: treated identically to 404
 *   - response.status 404: also treated as 404-already-gone
 *   - Other error (403, 500): ok:false, code:GOOGLE_API_ERROR
 *   - calendarId defaults to config defaultCalendarId when omitted
 *   - No auth: ok:false, code:GOOGLE_NOT_AUTHORISED
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ToolDeps, ToolContext } from '../../src/tools/types.js';
import type { AppConfig } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Mocks — declared before imports that load the mocked modules.
// ---------------------------------------------------------------------------

const mockDeleteEvent = vi.fn();

vi.mock('../../src/google/calendar.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/google/calendar.js')>();
  return {
    ...original,
    CalendarApi: vi.fn().mockImplementation(function (this: unknown) {
      (this as Record<string, unknown>).deleteEvent = (...args: unknown[]) =>
        mockDeleteEvent(...args);
    }),
  };
});

vi.mock('../../src/google/oauth.js', () => ({
  loadGoogleAuth: vi.fn(),
}));

import { loadGoogleAuth } from '../../src/google/oauth.js';
import { buildCalendarDeleteEventTool } from '../../src/tools/calendar_delete_event.js';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calendar_delete_event — no auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteEvent.mockReset();
  });

  it('returns GOOGLE_NOT_AUTHORISED when clientId is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = '';
    cfg.google.oauth.clientSecret = '';
    mockLoadGoogleAuth.mockResolvedValue(null);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('GOOGLE_OAUTH_CLIENT_ID');
  });

  it('returns GOOGLE_NOT_AUTHORISED with run-google-auth hint when clientId is set but no token', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    cfg.google.oauth.clientSecret = 'fake-secret';
    mockLoadGoogleAuth.mockResolvedValue(null);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
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

describe('calendar_delete_event — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteEvent.mockReset();
  });

  it('returns ok:true, "Deleted event…" output, data.outcome:"deleted"', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    mockDeleteEvent.mockResolvedValue(undefined);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-to-delete', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Deleted event evt-to-delete');
    expect(result.data?.outcome).toBe('deleted');
    expect(result.data?.deletedEventId).toBe('evt-to-delete');
  });

  it('calendarId defaults to config.google.calendar.defaultCalendarId ("primary") when omitted', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    mockDeleteEvent.mockResolvedValue(undefined);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    await tool.execute(
      { eventId: 'evt-001', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    const callArgs = mockDeleteEvent.mock.calls[0][0];
    expect(callArgs.calendarId).toBe('primary');
    expect(callArgs.eventId).toBe('evt-001');
  });

  it('passes explicit calendarId when provided', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    mockDeleteEvent.mockResolvedValue(undefined);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      {
        eventId: 'evt-001',
        calendarId: 'work@group.calendar.google.com',
        notificationLevel: 'NONE',
      },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    const callArgs = mockDeleteEvent.mock.calls[0][0];
    expect(callArgs.calendarId).toBe('work@group.calendar.google.com');
    expect(result.data?.calendarId).toBe('work@group.calendar.google.com');
  });
});

describe('calendar_delete_event — 404 "already gone" (ADR 006 R1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteEvent.mockReset();
  });

  it('returns ok:true, data.outcome:"404-already-gone" when Google returns 404 via .code', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const notFoundErr = Object.assign(new Error('Not Found'), { code: 404 });
    mockDeleteEvent.mockRejectedValue(notFoundErr);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-ghost', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    expect(result.data?.outcome).toBe('404-already-gone');
    expect(result.data?.deletedEventId).toBe('evt-ghost');
    // Output must be distinguishable — must NOT start with "Deleted event"
    expect(result.output).not.toMatch(/^Deleted event/);
    expect(result.output).toContain('was not found');
    expect(result.output).toContain('evt-ghost');
    expect(result.output).toContain('calendar_list_events');
  });

  it('returns ok:true, data.outcome:"404-already-gone" when Google returns 410 via .code', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const goneErr = Object.assign(new Error('Gone'), { code: 410 });
    mockDeleteEvent.mockRejectedValue(goneErr);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-ghost', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    expect(result.data?.outcome).toBe('404-already-gone');
  });

  it('returns ok:true, data.outcome:"404-already-gone" when error has response.status 404', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const notFoundErr = Object.assign(new Error('Not Found'), { response: { status: 404 } });
    mockDeleteEvent.mockRejectedValue(notFoundErr);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-ghost', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(true);
    expect(result.data?.outcome).toBe('404-already-gone');
  });
});

describe('calendar_delete_event — other errors (GOOGLE_API_ERROR)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteEvent.mockReset();
  });

  it('returns ok:false, code:GOOGLE_API_ERROR for a 403 permission error', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const forbiddenErr = Object.assign(
      new Error('The user does not have the necessary permissions'),
      { code: 403 },
    );
    mockDeleteEvent.mockRejectedValue(forbiddenErr);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-shared', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_API_ERROR');
    expect(result.output).toContain('permissions');
  });

  it('returns ok:false, code:GOOGLE_API_ERROR for a 500 server error', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    mockLoadGoogleAuth.mockResolvedValue({} as import('google-auth-library').OAuth2Client);
    const serverErr = Object.assign(new Error('Internal Server Error'), { code: 500 });
    mockDeleteEvent.mockRejectedValue(serverErr);

    const tool = buildCalendarDeleteEventTool(makeDeps(cfg));
    const result = await tool.execute(
      { eventId: 'evt-001', notificationLevel: 'NONE' },
      makeCtx(cfg),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_API_ERROR');
  });
});

describe('calendar_delete_event — input schema', () => {
  it('rejects missing eventId', () => {
    const tool = buildCalendarDeleteEventTool(makeDeps(makeTestConfig()));
    expect(tool.parameters.safeParse({}).success).toBe(false);
  });

  it('rejects empty string eventId', () => {
    const tool = buildCalendarDeleteEventTool(makeDeps(makeTestConfig()));
    expect(tool.parameters.safeParse({ eventId: '' }).success).toBe(false);
  });

  it('accepts minimum valid shape (eventId only)', () => {
    const tool = buildCalendarDeleteEventTool(makeDeps(makeTestConfig()));
    expect(tool.parameters.safeParse({ eventId: 'abc' }).success).toBe(true);
  });

  it('is adminOnly:true', () => {
    const tool = buildCalendarDeleteEventTool(makeDeps(makeTestConfig()));
    expect(tool.adminOnly).toBe(true);
  });

  it('has the correct tool name', () => {
    const tool = buildCalendarDeleteEventTool(makeDeps(makeTestConfig()));
    expect(tool.name).toBe('calendar_delete_event');
  });
});
