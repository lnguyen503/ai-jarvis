/**
 * Tests for the gmail_search / gmail_read tools and their registration.
 *
 * Mirrors tests/unit/tools.calendar.test.ts:
 * - Tools register only when google.enabled && google.gmail.enabled.
 * - Both carry adminOnly:true (gates groups via the v1.7.10 path).
 * - No-auth paths return helpful errors naming env vars / the auth script.
 * - Input schemas reject invalid shapes and accept the minimum valid shape.
 */
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import path from 'path';
import { registerTools } from '../../src/tools/index.js';
import { buildGmailSearchTool } from '../../src/tools/gmail_search.js';
import { buildGmailReadTool } from '../../src/tools/gmail_read.js';
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

describe('gmail tools — registration', () => {
  it('NEITHER search NOR read is registered when google.enabled=false', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = false;
    cfg.google.gmail.enabled = true;
    const tools = registerTools(deps(cfg));
    expect(tools.find((t) => t.name === 'gmail_search')).toBeUndefined();
    expect(tools.find((t) => t.name === 'gmail_read')).toBeUndefined();
  });

  it('NEITHER is registered when google.gmail.enabled=false', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.gmail.enabled = false;
    const tools = registerTools(deps(cfg));
    expect(tools.find((t) => t.name === 'gmail_search')).toBeUndefined();
    expect(tools.find((t) => t.name === 'gmail_read')).toBeUndefined();
  });

  it('BOTH are registered as admin-only when both flags are true', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.gmail.enabled = true;
    const tools = registerTools(deps(cfg));
    const search = tools.find((t) => t.name === 'gmail_search');
    const read = tools.find((t) => t.name === 'gmail_read');
    expect(search).toBeDefined();
    expect(search?.adminOnly).toBe(true);
    expect(read).toBeDefined();
    expect(read?.adminOnly).toBe(true);
  });

  it('registration is independent of calendar flag', () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.calendar.enabled = false;
    cfg.google.gmail.enabled = true;
    const tools = registerTools(deps(cfg));
    expect(tools.find((t) => t.name === 'calendar_list_events')).toBeUndefined();
    expect(tools.find((t) => t.name === 'gmail_search')).toBeDefined();
  });
});

describe('gmail_search — no auth path', () => {
  it('returns a helpful error when clientId is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.gmail.enabled = true;
    cfg.google.oauth.clientId = '';
    cfg.google.oauth.clientSecret = '';
    const tool = buildGmailSearchTool(deps(cfg));
    const result = await tool.execute({ query: 'is:unread', maxResults: 10 }, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(result.output).toContain('npm run google-auth');
  });

  it('returns a helpful error when token file is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.gmail.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    cfg.google.oauth.clientSecret = 'fake-secret';
    const tool = buildGmailSearchTool(deps(cfg));
    const result = await tool.execute({ query: '', maxResults: 10 }, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('npm run google-auth');
    expect(result.output).not.toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(result.output).toContain(path.basename(cfg.google.oauth.tokenPath));
  });
});

describe('gmail_read — no auth path', () => {
  it('returns a helpful error when clientId is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.gmail.enabled = true;
    cfg.google.oauth.clientId = '';
    cfg.google.oauth.clientSecret = '';
    const tool = buildGmailReadTool(deps(cfg));
    const result = await tool.execute({ id: '18f3a2b4c5d6e7f' }, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('GOOGLE_OAUTH_CLIENT_ID');
  });

  it('returns a helpful error when token file is missing', async () => {
    const cfg = makeTestConfig();
    cfg.google.enabled = true;
    cfg.google.gmail.enabled = true;
    cfg.google.oauth.clientId = 'fake-client';
    cfg.google.oauth.clientSecret = 'fake-secret';
    const tool = buildGmailReadTool(deps(cfg));
    const result = await tool.execute({ id: '18f3a2b4c5d6e7f' }, makeCtx(cfg));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('GOOGLE_NOT_AUTHORISED');
    expect(result.output).toContain('npm run google-auth');
  });
});

describe('gmail_search — input schema', () => {
  it('accepts empty query (defaults to empty string → list inbox)', () => {
    const cfg = makeTestConfig();
    const tool = buildGmailSearchTool(deps(cfg));
    const result = tool.parameters.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe('');
      expect(result.data.maxResults).toBe(10);
    }
  });

  it('rejects maxResults > 50', () => {
    const cfg = makeTestConfig();
    const tool = buildGmailSearchTool(deps(cfg));
    const result = tool.parameters.safeParse({ query: 'x', maxResults: 100 });
    expect(result.success).toBe(false);
  });

  it('accepts a typical query shape', () => {
    const cfg = makeTestConfig();
    const tool = buildGmailSearchTool(deps(cfg));
    const result = tool.parameters.safeParse({
      query: 'from:sam@example.com is:unread',
      maxResults: 5,
      labelIds: ['INBOX'],
    });
    expect(result.success).toBe(true);
  });
});

describe('gmail_read — input schema', () => {
  it('rejects missing id', () => {
    const cfg = makeTestConfig();
    const tool = buildGmailReadTool(deps(cfg));
    expect(tool.parameters.safeParse({}).success).toBe(false);
  });

  it('rejects empty id', () => {
    const cfg = makeTestConfig();
    const tool = buildGmailReadTool(deps(cfg));
    expect(tool.parameters.safeParse({ id: '' }).success).toBe(false);
  });

  it('accepts a plausible Gmail id', () => {
    const cfg = makeTestConfig();
    const tool = buildGmailReadTool(deps(cfg));
    expect(tool.parameters.safeParse({ id: '18f3a2b4c5d6e7f' }).success).toBe(true);
  });
});
