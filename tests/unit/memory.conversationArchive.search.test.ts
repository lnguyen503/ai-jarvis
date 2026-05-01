/**
 * Unit tests for ConversationArchiveRepo.search() — v1.4.1
 */

import { describe, it, expect, afterEach } from 'vitest';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import type { AppConfig } from '../../src/config/schema.js';

let cfg: AppConfig;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  return initMemory(cfg);
}

afterEach(() => {
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

/** Build a minimal scrubbed JSON blob for seeding. */
function makeHistoryJson(messages: Array<{ id: number; role: string; content: string }>): string {
  return JSON.stringify(
    messages.map((m) => ({
      id: m.id,
      session_id: 1,
      role: m.role,
      content: m.content,
      tool_name: null,
      tool_input: null,
      tool_output: null,
      tool_use_id: null,
      created_at: '2026-04-14T18:00:00.000Z',
    })),
  );
}

describe('ConversationArchiveRepo.search()', () => {
  it('happy path: finds a message containing the query keyword', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9001);

    const historyJson = makeHistoryJson([
      { id: 10, role: 'user', content: 'Can you refactor the authentication module?' },
      { id: 11, role: 'assistant', content: 'Sure, I will update the authentication logic.' },
    ]);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 100,
      compressed_tokens: 20,
      original_message_count: 2,
      full_history_json: historyJson,
      summary_text: 'Discussed authentication refactor.',
      first_message_id: 10,
      last_message_id: 11,
    });

    const hits = mem.conversationArchive.search(session.id, null, 'authentication');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain('authentication');
  });

  it('returns empty array when no messages match', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9002);

    const historyJson = makeHistoryJson([
      { id: 20, role: 'user', content: 'Hello world' },
    ]);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 10,
      compressed_tokens: 5,
      original_message_count: 1,
      full_history_json: historyJson,
      summary_text: 'Said hello.',
      first_message_id: 20,
      last_message_id: 20,
    });

    const hits = mem.conversationArchive.search(session.id, null, 'authentication refactor database');
    expect(hits).toHaveLength(0);
  });

  it('stopword-only query returns empty (no tokens after filtering)', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9003);

    const historyJson = makeHistoryJson([
      { id: 30, role: 'user', content: 'the quick brown fox' },
    ]);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 10,
      compressed_tokens: 5,
      original_message_count: 1,
      full_history_json: historyJson,
      summary_text: 'Fox message.',
      first_message_id: 30,
      last_message_id: 30,
    });

    // All tokens are either stopwords or < 3 chars: "the", "a", "is", "to", "in", "or"
    const hits = mem.conversationArchive.search(session.id, null, 'the a is to in or');
    expect(hits).toHaveLength(0);
  });

  it('scopes to specific archive_id when provided', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9004);

    const historyA = makeHistoryJson([
      { id: 40, role: 'user', content: 'deploy the kubernetes cluster' },
    ]);
    const historyB = makeHistoryJson([
      { id: 50, role: 'user', content: 'setup the webpack configuration' },
    ]);

    const idA = mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 10,
      compressed_tokens: 5,
      original_message_count: 1,
      full_history_json: historyA,
      summary_text: 'Kubernetes.',
      first_message_id: 40,
      last_message_id: 40,
    });

    const idB = mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 10,
      compressed_tokens: 5,
      original_message_count: 1,
      full_history_json: historyB,
      summary_text: 'Webpack.',
      first_message_id: 50,
      last_message_id: 50,
    });

    // Search only archive B for "webpack" — should not see kubernetes result
    const hitsB = mem.conversationArchive.search(session.id, idB, 'webpack');
    expect(hitsB.length).toBeGreaterThan(0);
    expect(hitsB.every((h) => h.archive_id === idB)).toBe(true);

    // Search only archive A for "kubernetes"
    const hitsA = mem.conversationArchive.search(session.id, idA, 'kubernetes');
    expect(hitsA.length).toBeGreaterThan(0);
    expect(hitsA.every((h) => h.archive_id === idA)).toBe(true);

    // Searching archive A for "webpack" should return empty
    const none = mem.conversationArchive.search(session.id, idA, 'webpack');
    expect(none).toHaveLength(0);
  });

  it('ranks hits by number of matching tokens, then recency', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9005);

    // msg 60 matches 1 token; msg 61 matches 2 tokens → msg 61 should rank higher
    const historyJson = makeHistoryJson([
      { id: 60, role: 'user', content: 'please refactor the module' },
      { id: 61, role: 'assistant', content: 'refactor the authentication module completely' },
    ]);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 30,
      compressed_tokens: 10,
      original_message_count: 2,
      full_history_json: historyJson,
      summary_text: 'Refactor discussed.',
      first_message_id: 60,
      last_message_id: 61,
    });

    // Query matches "authentication" and "module"
    const hits = mem.conversationArchive.search(session.id, null, 'authentication module');
    expect(hits.length).toBeGreaterThan(0);
    // The message matching both tokens should appear first
    expect(hits[0]!.message_id).toBe(61);
  });

  it('respects maxMatches cap', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9006);

    // 10 messages all containing "database"
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: 70 + i,
      role: 'user',
      content: `database query number ${i}`,
    }));
    const historyJson = makeHistoryJson(messages);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 100,
      compressed_tokens: 20,
      original_message_count: 10,
      full_history_json: historyJson,
      summary_text: 'Many database queries.',
      first_message_id: 70,
      last_message_id: 79,
    });

    const hits = mem.conversationArchive.search(session.id, null, 'database', { maxMatches: 3 });
    expect(hits).toHaveLength(3);
  });

  it('searches tool_input and tool_output fields as well as content', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9007);

    const historyJson = JSON.stringify([
      {
        id: 90,
        session_id: session.id,
        role: 'assistant',
        content: null,
        tool_name: 'run_command',
        tool_input: JSON.stringify({ command: 'sacred-incantation foo-bar-baz-42' }),
        tool_output: null,
        tool_use_id: 'tu_01',
        created_at: '2026-04-14T18:22:00.000Z',
      },
    ]);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 50,
      compressed_tokens: 10,
      original_message_count: 1,
      full_history_json: historyJson,
      summary_text: 'Ran a command.',
      first_message_id: 90,
      last_message_id: 90,
    });

    const hits = mem.conversationArchive.search(session.id, null, 'incantation');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain('incantation');
  });

  it('tolerates NULL first/last message ids in legacy rows', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9008);

    const historyJson = makeHistoryJson([
      { id: 100, role: 'user', content: 'legacy message about legacy system' },
    ]);

    // Insert without first_message_id / last_message_id (legacy row)
    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 20,
      compressed_tokens: 5,
      original_message_count: 1,
      full_history_json: historyJson,
      summary_text: 'Legacy stuff.',
      // deliberately omit first_message_id and last_message_id
    });

    // Should still be searchable
    const hits = mem.conversationArchive.search(session.id, null, 'legacy');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('getById returns the row by id and session_id', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(9009);

    const insertedId = mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 100,
      compressed_tokens: 20,
      original_message_count: 5,
      full_history_json: '[]',
      summary_text: 'Test.',
      first_message_id: 1,
      last_message_id: 5,
    });

    const row = mem.conversationArchive.getById(insertedId, session.id);
    expect(row).toBeDefined();
    expect(row!.id).toBe(insertedId);
    expect(row!.session_id).toBe(session.id);
  });

  it('getById returns undefined for wrong session_id', () => {
    const mem = setup();
    const s1 = mem.sessions.getOrCreate(9010);
    const s2 = mem.sessions.getOrCreate(9011);

    const insertedId = mem.conversationArchive.insert({
      session_id: s1.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 10,
      compressed_tokens: 5,
      original_message_count: 1,
      full_history_json: '[]',
      summary_text: 'Test.',
    });

    // Looking up with the wrong session_id should return undefined
    const row = mem.conversationArchive.getById(insertedId, s2.id);
    expect(row).toBeUndefined();
  });
});
