/**
 * Tests for the browse_url tool — registration gate, adminOnly flag, schema
 * validation, and the config-disabled error path. We deliberately do NOT
 * launch Chromium here — that's an integration test concern. The path
 * through the SSRF guard + browser launch is heavy enough that we defer it
 * to a manual smoke test and rely on dedicated unit tests for ssrfGuard and
 * extractor to cover the pieces.
 */
import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { registerTools } from '../../src/tools/index.js';
import { buildBrowseUrlTool } from '../../src/tools/browse_url.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import type { ToolDeps, ToolContext } from '../../src/tools/types.js';
import type { AppConfig } from '../../src/config/schema.js';

const silent = pino({ level: 'silent' });

function deps(cfg: AppConfig): ToolDeps {
  return {
    config: cfg,
    logger: silent,
    safety: {} as ToolDeps['safety'],
    memory: {} as ToolDeps['memory'],
  };
}

function ctx(cfg: AppConfig): ToolContext {
  return {
    sessionId: 1,
    chatId: 100,
    logger: silent,
    config: cfg,
    memory: {} as ToolContext['memory'],
    safety: { scrub: (s: string) => s, scrubRecord: (r: object) => r } as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
  };
}

describe('browse_url — registration', () => {
  it('is NOT registered when browser.enabled=false', () => {
    const cfg = makeTestConfig();
    cfg.browser.enabled = false;
    const tools = registerTools(deps(cfg));
    expect(tools.find((t) => t.name === 'browse_url')).toBeUndefined();
  });

  it('IS registered as admin-only when browser.enabled=true', () => {
    const cfg = makeTestConfig();
    cfg.browser.enabled = true;
    const tools = registerTools(deps(cfg));
    const tool = tools.find((t) => t.name === 'browse_url');
    expect(tool).toBeDefined();
    expect(tool?.adminOnly).toBe(true);
  });
});

describe('browse_url — input schema', () => {
  const cfg = makeTestConfig();

  it('requires url', () => {
    const tool = buildBrowseUrlTool(deps(cfg));
    expect(tool.parameters.safeParse({}).success).toBe(false);
  });

  it('rejects empty url', () => {
    const tool = buildBrowseUrlTool(deps(cfg));
    expect(tool.parameters.safeParse({ url: '' }).success).toBe(false);
  });

  it('accepts a url-only input (defaults fill in)', () => {
    const tool = buildBrowseUrlTool(deps(cfg));
    const r = tool.parameters.safeParse({ url: 'https://example.com' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.waitForMs).toBe(2000);
      expect(r.data.screenshot).toBe(false);
      expect(r.data.includeRawHtml).toBe(false);
    }
  });

  it('caps waitForMs at 15000', () => {
    const tool = buildBrowseUrlTool(deps(cfg));
    expect(
      tool.parameters.safeParse({ url: 'https://x.com', waitForMs: 20000 }).success,
    ).toBe(false);
  });

  it('accepts all options together', () => {
    const tool = buildBrowseUrlTool(deps(cfg));
    const r = tool.parameters.safeParse({
      url: 'https://x.com',
      waitForMs: 5000,
      screenshot: true,
      includeRawHtml: true,
    });
    expect(r.success).toBe(true);
  });
});

describe('browse_url — config-disabled error', () => {
  it('returns BROWSER_DISABLED when the tool is called while disabled', async () => {
    const cfg = makeTestConfig();
    cfg.browser.enabled = false;
    const tool = buildBrowseUrlTool(deps(cfg));
    const result = await tool.execute(
      { url: 'https://example.com', waitForMs: 0, screenshot: false, includeRawHtml: false },
      ctx(cfg),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('BROWSER_DISABLED');
  });
});

describe('browse_url — SSRF short-circuit', () => {
  it('rejects private-IP URLs without launching Chromium', async () => {
    const cfg = makeTestConfig();
    cfg.browser.enabled = true;
    const tool = buildBrowseUrlTool(deps(cfg));
    const result = await tool.execute(
      { url: 'http://127.0.0.1/', waitForMs: 0, screenshot: false, includeRawHtml: false },
      ctx(cfg),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SSRF_BLOCKED');
    expect(result.error?.message).toBe('private-ip-literal');
  });

  it('rejects unsupported schemes', async () => {
    const cfg = makeTestConfig();
    cfg.browser.enabled = true;
    const tool = buildBrowseUrlTool(deps(cfg));
    const result = await tool.execute(
      { url: 'file:///etc/passwd', waitForMs: 0, screenshot: false, includeRawHtml: false },
      ctx(cfg),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SSRF_BLOCKED');
  });

  it('rejects config-denied hosts', async () => {
    const cfg = makeTestConfig();
    cfg.browser.enabled = true;
    cfg.browser.denyHosts = ['*.internal'];
    const tool = buildBrowseUrlTool(deps(cfg));
    const result = await tool.execute(
      {
        url: 'http://secrets.internal/',
        waitForMs: 0,
        screenshot: false,
        includeRawHtml: false,
      },
      ctx(cfg),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SSRF_BLOCKED');
  });
});
