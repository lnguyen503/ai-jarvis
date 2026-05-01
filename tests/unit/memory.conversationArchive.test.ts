/**
 * Unit tests for src/memory/conversationArchive.ts
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

describe('ConversationArchiveRepo', () => {
  it('inserts and retrieves a row', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(1001);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 5000,
      compressed_tokens: 200,
      original_message_count: 40,
      full_history_json: '[{"role":"user","content":"hello"}]',
      summary_text: 'User said hello.',
    });

    const rows = mem.conversationArchive.listForSession(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toBe('auto');
    expect(rows[0]!.original_tokens).toBe(5000);
    expect(rows[0]!.summary_text).toBe('User said hello.');
  });

  it('listForSession returns rows ordered by compacted_at DESC', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(1002);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 1000,
      compressed_tokens: 100,
      original_message_count: 10,
      full_history_json: '[]',
      summary_text: 'First summary.',
    });

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'manual',
      provider: 'ollama-cloud',
      model: 'glm-5.1:cloud',
      original_tokens: 2000,
      compressed_tokens: 150,
      original_message_count: 20,
      full_history_json: '[]',
      summary_text: 'Second summary.',
    });

    const rows = mem.conversationArchive.listForSession(session.id);
    expect(rows).toHaveLength(2);
    // Most recent first
    expect(rows[0]!.summary_text).toBe('Second summary.');
  });

  it('latestForSession returns the most recent row', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(1003);

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 100,
      compressed_tokens: 50,
      original_message_count: 5,
      full_history_json: '[]',
      summary_text: 'Old summary.',
    });

    mem.conversationArchive.insert({
      session_id: session.id,
      trigger: 'manual',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 200,
      compressed_tokens: 80,
      original_message_count: 10,
      full_history_json: '[]',
      summary_text: 'New summary.',
    });

    const latest = mem.conversationArchive.latestForSession(session.id);
    expect(latest).toBeDefined();
    expect(latest!.summary_text).toBe('New summary.');
  });

  it('latestForSession returns undefined for session with no archives', () => {
    const mem = setup();
    const session = mem.sessions.getOrCreate(1004);
    const latest = mem.conversationArchive.latestForSession(session.id);
    expect(latest).toBeUndefined();
  });

  it('does not leak rows across sessions', () => {
    const mem = setup();
    const s1 = mem.sessions.getOrCreate(2001);
    const s2 = mem.sessions.getOrCreate(2002);

    mem.conversationArchive.insert({
      session_id: s1.id,
      trigger: 'auto',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      original_tokens: 100,
      compressed_tokens: 50,
      original_message_count: 5,
      full_history_json: '[]',
      summary_text: 'Session 1.',
    });

    const s2Rows = mem.conversationArchive.listForSession(s2.id);
    expect(s2Rows).toHaveLength(0);
  });
});
