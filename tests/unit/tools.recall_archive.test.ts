/**
 * Unit tests for src/tools/recall_archive.ts — v1.4.1
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import recallArchiveTool from '../../src/tools/recall_archive.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { SearchHit } from '../../src/memory/conversationArchive.js';

let cfg: AppConfig;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  cfg = makeTestConfig();
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  const session = mem.sessions.getOrCreate(8001);
  return {
    sessionId: session.id,
    chatId: 8001,
    logger: getLogger(),
    config: cfg,
    memory: mem,
    safety,
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

afterEach(() => {
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

describe('recall_archive tool', () => {
  it('has the correct name and description', () => {
    expect(recallArchiveTool.name).toBe('recall_archive');
    expect(recallArchiveTool.description).toContain('archived pre-compaction');
    expect(recallArchiveTool.description).toContain('matching snippets');
  });

  it('returns empty-match message when no archives exist', async () => {
    const ctx = makeContext();
    const result = await recallArchiveTool.execute(
      { query: 'some keyword here', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('No matches in archive');
    expect(result.data?.['matches']).toBe(0);
  });

  it('returns hits when archive contains matching content', async () => {
    const ctx = makeContext();

    // Seed an archive row with known content
    const historyJson = JSON.stringify([
      {
        id: 200,
        session_id: ctx.sessionId,
        role: 'user',
        content: 'please deploy the kubernetes cluster now',
        tool_name: null,
        tool_input: null,
        tool_output: null,
        tool_use_id: null,
        created_at: '2026-04-14T18:00:00.000Z',
      },
    ]);

    ctx.memory.conversationArchive.insert({
      session_id: ctx.sessionId,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 50,
      compressed_tokens: 10,
      original_message_count: 1,
      full_history_json: historyJson,
      summary_text: 'Kubernetes deploy requested.',
      first_message_id: 200,
      last_message_id: 200,
    });

    const result = await recallArchiveTool.execute(
      { query: 'kubernetes deploy', max_results: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('kubernetes');
    expect(result.output).toContain('msg 200');
    expect((result.data?.['matches'] as number)).toBeGreaterThan(0);
  });

  it('scrubs secrets from returned snippets', async () => {
    const ctx = makeContext();

    // Embed a fake secret in the archived content
    const historyJson = JSON.stringify([
      {
        id: 210,
        session_id: ctx.sessionId,
        role: 'user',
        content: 'my api key is sk-ant-api03-' + 'abcdefghijklmnopqrstuvwx01234567890123456789012345678901234567890123-AAAAAAA',
        tool_name: null,
        tool_input: null,
        tool_output: null,
        tool_use_id: null,
        created_at: '2026-04-14T18:01:00.000Z',
      },
    ]);

    ctx.memory.conversationArchive.insert({
      session_id: ctx.sessionId,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 50,
      compressed_tokens: 10,
      original_message_count: 1,
      full_history_json: historyJson,
      summary_text: 'Key discussion.',
      first_message_id: 210,
      last_message_id: 210,
    });

    const result = await recallArchiveTool.execute(
      { query: 'api key', max_results: 5 },
      ctx,
    );

    // The tool calls ctx.safety.scrub() on each snippet — secret should be redacted
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain('sk-ant-');
    expect(result.output).toContain('REDACTED');
  });

  it('empty-match case returns ok:true (not an error)', async () => {
    const ctx = makeContext();
    const result = await recallArchiveTool.execute(
      { query: 'nonexistent xyzzy frobulation', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('No matches');
  });

  it('limits results to max_results', async () => {
    const ctx = makeContext();

    const messages = Array.from({ length: 8 }, (_, i) => ({
      id: 300 + i,
      session_id: ctx.sessionId,
      role: 'user',
      content: `database migration step ${i}`,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      tool_use_id: null,
      created_at: '2026-04-14T18:00:00.000Z',
    }));

    ctx.memory.conversationArchive.insert({
      session_id: ctx.sessionId,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 100,
      compressed_tokens: 20,
      original_message_count: 8,
      full_history_json: JSON.stringify(messages),
      summary_text: 'Database migrations.',
      first_message_id: 300,
      last_message_id: 307,
    });

    const result = await recallArchiveTool.execute(
      { query: 'database migration', max_results: 3 },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.['matches']).toBe(3);
  });

  it('scopes search to archive_id when provided', async () => {
    const ctx = makeContext();

    const historyA = JSON.stringify([
      {
        id: 400,
        session_id: ctx.sessionId,
        role: 'user',
        content: 'webpack bundling configuration options',
        tool_name: null,
        tool_input: null,
        tool_output: null,
        tool_use_id: null,
        created_at: '2026-04-14T18:00:00.000Z',
      },
    ]);
    const historyB = JSON.stringify([
      {
        id: 410,
        session_id: ctx.sessionId,
        role: 'user',
        content: 'vite configuration options',
        tool_name: null,
        tool_input: null,
        tool_output: null,
        tool_use_id: null,
        created_at: '2026-04-14T18:05:00.000Z',
      },
    ]);

    const archiveIdA = ctx.memory.conversationArchive.insert({
      session_id: ctx.sessionId,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 30,
      compressed_tokens: 10,
      original_message_count: 1,
      full_history_json: historyA,
      summary_text: 'Webpack.',
      first_message_id: 400,
      last_message_id: 400,
    });

    ctx.memory.conversationArchive.insert({
      session_id: ctx.sessionId,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 30,
      compressed_tokens: 10,
      original_message_count: 1,
      full_history_json: historyB,
      summary_text: 'Vite.',
      first_message_id: 410,
      last_message_id: 410,
    });

    // Search archive A for "webpack" — should only return archiveA's result
    const result = await recallArchiveTool.execute(
      { query: 'webpack', archive_id: archiveIdA, max_results: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('webpack');
    // Should not see vite content
    expect(result.output).not.toContain('vite');
  });

  it('returns empty when archive_id does not belong to this session', async () => {
    const ctx = makeContext();

    const result = await recallArchiveTool.execute(
      { query: 'anything useful here', archive_id: 999999, max_results: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('No matches');
  });
});
