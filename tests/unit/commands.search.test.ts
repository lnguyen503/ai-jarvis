/**
 * /search command handler tests — fetch and grammY ctx are mocked.
 * Tests: happy path, disabled tavily, missing query, error handling, HTML escaping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSearch } from '../../src/commands/search.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { initSafety } from '../../src/safety/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { getLogger } from '../../src/logger/index.js';
import path from 'path';
import os from 'os';
import type { Context } from 'grammy';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeGrammyCtx(messageText: string): Context {
  const reply = vi.fn().mockResolvedValue({});
  const sendChatAction = vi.fn().mockResolvedValue({});
  return {
    chat: { id: 12345 },
    message: { text: messageText },
    api: { sendChatAction },
    reply,
  } as unknown as Context;
}

function makeTestDeps(overrides: { tavilyEnabled?: boolean; apiKey?: string } = {}) {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-search-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({
    memory: { dbPath, maxHistoryMessages: 50 },
    tavily: {
      enabled: overrides.tavilyEnabled ?? true,
      apiKey: overrides.apiKey ?? 'tvly-test-key',
      baseUrl: 'https://api.tavily.com',
    },
  });
  const memory = initMemory(cfg);
  const safety = initSafety(cfg, memory);
  return { config: cfg, memory, safety, logger: getLogger() };
}

function mockSuccessResponse() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({
        results: [
          { title: 'Test Result', url: 'https://example.com', content: 'Some content here' },
        ],
      }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/search command', () => {
  it('returns results when tavily is enabled and query is provided', async () => {
    const ctx = makeGrammyCtx('/search react hooks');
    const deps = makeTestDeps();
    mockSuccessResponse();

    await handleSearch(ctx, deps);

    const replyCalls = vi.mocked(ctx.reply).mock.calls;
    expect(replyCalls.length).toBe(1);
    const [replyText] = replyCalls[0]!;
    expect(typeof replyText).toBe('string');
    expect(replyText as string).toContain('Test Result');
  });

  it('replies with HTML parse_mode', async () => {
    const ctx = makeGrammyCtx('/search test');
    const deps = makeTestDeps();
    mockSuccessResponse();

    await handleSearch(ctx, deps);

    const [, options] = vi.mocked(ctx.reply).mock.calls[0]!;
    expect((options as { parse_mode: string })?.parse_mode).toBe('HTML');
  });

  it('replies with disabled message when tavily.enabled is false', async () => {
    const ctx = makeGrammyCtx('/search react');
    const deps = makeTestDeps({ tavilyEnabled: false });

    await handleSearch(ctx, deps);

    const [replyText] = vi.mocked(ctx.reply).mock.calls[0]!;
    expect(replyText as string).toContain('disabled');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows usage when query is empty', async () => {
    const ctx = makeGrammyCtx('/search');
    const deps = makeTestDeps();

    await handleSearch(ctx, deps);

    const [replyText] = vi.mocked(ctx.reply).mock.calls[0]!;
    expect(replyText as string).toContain('Usage');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows usage when query is only whitespace', async () => {
    const ctx = makeGrammyCtx('/search   ');
    const deps = makeTestDeps();

    await handleSearch(ctx, deps);

    const [replyText] = vi.mocked(ctx.reply).mock.calls[0]!;
    expect(replyText as string).toContain('Usage');
  });

  it('HTML-escapes output to prevent injection', async () => {
    const ctx = makeGrammyCtx('/search <script>alert(1)</script>');
    const deps = makeTestDeps();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              title: '<b>Injected</b>',
              url: 'https://evil.com',
              content: '<script>alert("xss")</script>',
            },
          ],
        }),
    });

    await handleSearch(ctx, deps);

    const [replyText] = vi.mocked(ctx.reply).mock.calls[0]!;
    // Dangerous content must be escaped
    expect(replyText as string).not.toContain('<script>');
    expect(replyText as string).toContain('&lt;script&gt;');
  });

  it('replies with error message when fetch fails', async () => {
    const ctx = makeGrammyCtx('/search test query');
    const deps = makeTestDeps();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server error'),
    });

    await handleSearch(ctx, deps);

    const [replyText] = vi.mocked(ctx.reply).mock.calls[0]!;
    expect(replyText as string).toContain('❌');
  });

  it('calls sendChatAction typing before searching', async () => {
    const ctx = makeGrammyCtx('/search test');
    const deps = makeTestDeps();
    mockSuccessResponse();

    await handleSearch(ctx, deps);

    expect(vi.mocked(ctx.api.sendChatAction)).toHaveBeenCalledWith(12345, 'typing');
  });

  it('extracts query correctly after /search prefix', async () => {
    const ctx = makeGrammyCtx('/search what is the meaning of life?');
    const deps = makeTestDeps();
    mockSuccessResponse();

    await handleSearch(ctx, deps);

    // Fetch should have been called with the correct query
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('what is the meaning of life?'),
      }),
    );
  });
});
