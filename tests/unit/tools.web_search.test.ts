/**
 * Tavily web_search tool unit tests — fetch is mocked.
 * Tests: happy path, missing key, empty results, HTTP error, parse error, abort.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import webSearchTool from '../../src/tools/web_search.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { initSafety } from '../../src/safety/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { getLogger } from '../../src/logger/index.js';
import type { ToolContext } from '../../src/tools/types.js';
import path from 'path';
import os from 'os';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeCtx(overrides: Partial<{ tavilyEnabled: boolean; apiKey: string }> = {}): ToolContext {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-websearch-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({
    memory: { dbPath, maxHistoryMessages: 50 },
    tavily: {
      enabled: overrides.tavilyEnabled ?? true,
      apiKey: overrides.apiKey ?? 'tvly-test-key',
      baseUrl: 'https://api.tavily.com',
    },
  });
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  return {
    sessionId: 1,
    chatId: 1,
    logger: getLogger(),
    config: cfg,
    memory: mem,
    safety,
    abortSignal: new AbortController().signal,
  };
}

function mockSuccessResponse(results: Array<{ title?: string; url?: string; content?: string }>) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ results }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('web_search tool', () => {
  it('has correct name and description', () => {
    expect(webSearchTool.name).toBe('web_search');
    expect(webSearchTool.description).toContain('Tavily');
  });

  it('happy path — returns formatted results', async () => {
    const ctx = makeCtx();
    mockSuccessResponse([
      { title: 'React Docs', url: 'https://react.dev', content: 'React is a library for building user interfaces' },
      { title: 'Next.js', url: 'https://nextjs.org', content: 'The React framework for production' },
    ]);

    const result = await webSearchTool.execute({ query: 'react tutorial', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('react tutorial');
    expect(result.output).toContain('React Docs');
    expect(result.output).toContain('https://react.dev');
    expect(result.output).toContain('Next.js');
  });

  it('sends correct Authorization header with Bearer token', async () => {
    const ctx = makeCtx({ apiKey: 'tvly-my-secret-key' });
    mockSuccessResponse([{ title: 'Result', url: 'https://example.com', content: 'Content' }]);

    await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tvly-my-secret-key');
  });

  it('returns error when API key is missing', async () => {
    const ctx = makeCtx({ apiKey: '' });
    const result = await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TAVILY_NO_KEY');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty result message when no results found', async () => {
    const ctx = makeCtx();
    mockSuccessResponse([]);

    const result = await webSearchTool.execute({ query: 'very obscure query xyz', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('No results found');
  });

  it('returns error on HTTP 401', async () => {
    const ctx = makeCtx();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const result = await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TAVILY_HTTP_ERROR');
    expect(result.output).toContain('401');
  });

  it('returns error on HTTP 500', async () => {
    const ctx = makeCtx();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    const result = await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TAVILY_HTTP_ERROR');
  });

  it('returns error on fetch network failure', async () => {
    const ctx = makeCtx();
    mockFetch.mockRejectedValueOnce(new Error('network unreachable'));

    const result = await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TAVILY_FETCH_ERROR');
    expect(result.output).toContain('network unreachable');
  });

  it('returns error on invalid JSON response', async () => {
    const ctx = makeCtx();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new Error('Invalid JSON')),
    });

    const result = await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TAVILY_PARSE_ERROR');
  });

  it('returns Tavily API error when response includes error field', async () => {
    const ctx = makeCtx();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ error: 'Invalid API key' }),
    });

    const result = await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TAVILY_API_ERROR');
    expect(result.output).toContain('Invalid API key');
  });

  it('respects maxResults parameter in request body', async () => {
    const ctx = makeCtx();
    mockSuccessResponse([{ title: 'R1', url: 'https://example.com', content: 'Content' }]);

    await webSearchTool.execute({ query: 'test', maxResults: 3, searchDepth: 'basic' }, ctx);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { max_results: number };
    expect(body.max_results).toBe(3);
  });

  it('respects searchDepth parameter', async () => {
    const ctx = makeCtx();
    mockSuccessResponse([{ title: 'R1', url: 'https://example.com', content: 'Content' }]);

    await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'advanced' }, ctx);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { search_depth: string };
    expect(body.search_depth).toBe('advanced');
  });

  it('truncates long snippets to 300 chars in output', async () => {
    const ctx = makeCtx();
    mockSuccessResponse([
      { title: 'Long Result', url: 'https://example.com', content: 'A'.repeat(500) },
    ]);

    const result = await webSearchTool.execute({ query: 'test', maxResults: 5, searchDepth: 'basic' }, ctx);

    expect(result.ok).toBe(true);
    // The snippet in the output should be at most 300 chars (plus surrounding text)
    expect(result.output).toContain('A'.repeat(300));
    expect(result.output).not.toContain('A'.repeat(301));
  });
});
