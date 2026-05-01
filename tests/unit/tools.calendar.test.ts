/**
 * Tests for the calendar_list_events tool and its registration logic.
 *
 * - Tool is registered only when google.enabled && google.calendar.enabled
 * - Tool carries adminOnly:true (gates groups via the existing v1.7.10 path)
 * - When no OAuth credentials are on disk, execute returns a helpful error
 *   that names the env var and the auth script to run
 */
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import path from 'path';
import { registerTools } from '../../src/tools/index.js';
import { buildCalendarListEventsTool } from '../../src/tools/calendar_list_events.js';
import { buildCalendarCreateEventTool } from '../../src/tools/calendar_create_event.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { ToolDeps, ToolContext } from '../../src/tools/types.js';
import type { AppConfig } from '../../src/config/schema.js';

const silentLogger = pino({ level: 'silent' });

function deps(cfg: AppConfig): ToolDeps {
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
    safety: { scrub: (s: string) => s, scrubRecord: (r: object) => r } as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
  };
}

describe('calendar tools — registration', () => {
  it('NEITHER list_events NOR create_event is registered when google.enabled=false', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = false;
    cfg.google.calendar.enabled = true;
    const tools = registerTools(deps(cfg));
    expect(tools.find((t) => t.name === 'calendar_list_events')).toBeUndefined();
    expect(tools.find((t) => t.name === 'calendar_create_event')).toBeUndefined();
  });

  it('NEITHER is registered when google.calendar.enabled=false', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = false;
    const tools = registerTools(deps(cfg));
    expect(tools.find((t) => t.name === 'calendar_list_events')).toBeUndefined();
    expect(tools.find((t) => t.name === 'calendar_create_event')).toBeUndefined();
  });

  it('BOTH are registered as admin-only when both flags are true', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    const tools = registerTools(deps(cfg));
    const list = tools.find((t) => t.name === 'calendar_list_events');
    const create = tools.find((t) => t.name === 'calendar_create_event');
    expect(list).toBeDefined();
    expect(list?.adminOnly).toBe(true);
    expect(create).toBeDefined();
    expect(create?.adminOnly).toBe(true);
  });
});

describe('calendar_list_events — no auth path', () => {
  it('returns a helpful error when clientId is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = '';
    cfg.google.oauth.clientSecret = '';
    const tool = buildCalendarListEventsTool(deps(cfg));
    const result = await tool.execute({ maxResults: 10 }, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(result.output).toContain('npm run google-auth');
  });

  it('returns a helpful error when token file is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    cfg.google.oauth.clientSecret = 'fake-secret';
    // tokenPath is set by makeTestConfig to a tmp dir, but no file exists yet
    const tool = buildCalendarListEventsTool(deps(cfg));
    const result = await tool.execute({ maxResults: 10 }, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('npm run google-auth');
    // Should NOT mention env vars when client id is set
    expect(result.output).not.toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(result.output).toContain(path.basename(cfg.google.oauth.tokenPath));
  });
});

describe('calendar_create_event — no auth path', () => {
  const validInput = {
    summary: 'Test event',
    startTime: '2026-04-17T14:00:00-07:00',
    endTime: '2026-04-17T15:00:00-07:00',
    allDay: false,
    addGoogleMeetUrl: false,
    notificationLevel: 'NONE' as const,
  };

  it('returns a helpful error when clientId is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = '';
    cfg.google.oauth.clientSecret = '';
    const tool = buildCalendarCreateEventTool(deps(cfg));
    const result = await tool.execute(validInput, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('GOOGLE_OAUTH_CLIENT_ID');
  });

  it('returns a helpful error when token file is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    cfg.google.oauth.clientSecret = 'fake-secret';
    const tool = buildCalendarCreateEventTool(deps(cfg));
    const result = await tool.execute(validInput, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('npm run google-auth');
    expect(result.output).toContain(path.basename(cfg.google.oauth.tokenPath));
  });
});

describe('calendar_create_event — input schema', () => {
  it('rejects missing required fields (summary, startTime, endTime)', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    const tool = buildCalendarCreateEventTool(deps(cfg));
    expect(tool.parameters.safeParse({}).success).toBe(false);
    expect(
      tool.parameters.safeParse({ summary: 'x', startTime: '2026-04-17T10:00:00Z' }).success,
    ).toBe(false);
  });

  it('accepts the minimum valid shape', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    const tool = buildCalendarCreateEventTool(deps(cfg));
    const result = tool.parameters.safeParse({
      summary: 'Coffee with Sam',
      startTime: '2026-04-17T14:00:00-07:00',
      endTime: '2026-04-17T15:00:00-07:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed attendee emails', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = true;
    const tool = buildCalendarCreateEventTool(deps(cfg));
    const result = tool.parameters.safeParse({
      summary: 'x',
      startTime: '2026-04-17T14:00:00Z',
      endTime: '2026-04-17T15:00:00Z',
      attendees: ['valid@example.com', 'not-an-email'],
    });
    expect(result.success).toBe(false);
  });
});
