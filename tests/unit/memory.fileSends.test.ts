/**
 * Unit tests for src/memory/fileSends.ts
 *
 * Covers: insert, listRecent (session scoping invariant W3), ok/error fields.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import type { AppConfig } from '../../src/config/schema.js';
import path from 'path';

let cfg: AppConfig;
let mem: MemoryApi;

function setup(): { cfg: AppConfig; mem: MemoryApi } {
  _resetDb();
  cfg = makeTestConfig();
  cfg.memory.dbPath = path.join(cfg.filesystem.allowedPaths[0]!, 'filesends.db');
  mem = initMemory(cfg);
  return { cfg, mem };
}

afterEach(() => {
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

describe('memory.fileSends', () => {
  it('inserts a successful send row and retrieves it with listRecent', () => {
    const { mem } = setup();
    const session = mem.sessions.getOrCreate(9001);

    const id = mem.fileSends.insert({
      session_id: session.id,
      chat_id: 9001,
      path: '/tmp/test.md',
      basename: 'test.md',
      bytes: 1024,
      ext: '.md',
      kind: 'document',
      telegram_message_id: 42,
      ok: true,
      error: null,
    });

    expect(id).toBeGreaterThan(0);

    const rows = mem.fileSends.listRecent(session.id, 10);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.session_id).toBe(session.id);
    expect(row.chat_id).toBe(9001);
    expect(row.path).toBe('/tmp/test.md');
    expect(row.basename).toBe('test.md');
    expect(row.bytes).toBe(1024);
    expect(row.ext).toBe('.md');
    expect(row.kind).toBe('document');
    expect(row.telegram_message_id).toBe(42);
    expect(row.ok).toBe(1); // SQLite boolean = 1
    expect(row.error).toBeNull();
    expect(row.created_at).toBeTruthy();
  });

  it('inserts a failed send row with error text', () => {
    const { mem } = setup();
    const session = mem.sessions.getOrCreate(9002);

    mem.fileSends.insert({
      session_id: session.id,
      chat_id: 9002,
      path: '/tmp/fail.png',
      basename: 'fail.png',
      bytes: 2048,
      ext: '.png',
      kind: 'document',
      telegram_message_id: null,
      ok: false,
      error: 'Telegram API returned 400',
    });

    const rows = mem.fileSends.listRecent(session.id, 10);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.ok).toBe(0);
    expect(row.error).toBe('Telegram API returned 400');
    expect(row.telegram_message_id).toBeNull();
  });

  it('listRecent is scoped by session_id (W3 invariant)', () => {
    const { mem } = setup();
    const sessionA = mem.sessions.getOrCreate(9003);
    const sessionB = mem.sessions.getOrCreate(9004);

    mem.fileSends.insert({
      session_id: sessionA.id,
      chat_id: 9003,
      path: '/tmp/a.txt',
      basename: 'a.txt',
      bytes: 100,
      ext: '.txt',
      kind: 'document',
      telegram_message_id: 10,
      ok: true,
    });

    mem.fileSends.insert({
      session_id: sessionB.id,
      chat_id: 9004,
      path: '/tmp/b.txt',
      basename: 'b.txt',
      bytes: 200,
      ext: '.txt',
      kind: 'document',
      telegram_message_id: 20,
      ok: true,
    });

    const rowsA = mem.fileSends.listRecent(sessionA.id, 10);
    const rowsB = mem.fileSends.listRecent(sessionB.id, 10);

    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.basename).toBe('a.txt');

    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.basename).toBe('b.txt');
  });

  it('listRecent respects the limit parameter', () => {
    const { mem } = setup();
    const session = mem.sessions.getOrCreate(9005);

    for (let i = 0; i < 5; i++) {
      mem.fileSends.insert({
        session_id: session.id,
        chat_id: 9005,
        path: `/tmp/file${i}.txt`,
        basename: `file${i}.txt`,
        bytes: i * 100,
        ext: '.txt',
        kind: 'document',
        telegram_message_id: i + 1,
        ok: true,
      });
    }

    const rows = mem.fileSends.listRecent(session.id, 3);
    expect(rows).toHaveLength(3);
  });

  it('listRecent returns rows newest-first', () => {
    const { mem } = setup();
    const session = mem.sessions.getOrCreate(9006);

    const id1 = mem.fileSends.insert({
      session_id: session.id,
      chat_id: 9006,
      path: '/tmp/first.txt',
      basename: 'first.txt',
      bytes: 100,
      ext: '.txt',
      kind: 'document',
      ok: true,
    });

    const id2 = mem.fileSends.insert({
      session_id: session.id,
      chat_id: 9006,
      path: '/tmp/second.txt',
      basename: 'second.txt',
      bytes: 200,
      ext: '.txt',
      kind: 'document',
      ok: true,
    });

    const rows = mem.fileSends.listRecent(session.id, 10);
    expect(rows.length).toBe(2);
    // Higher id (more recent) should come first
    expect(rows[0]!.id).toBe(id2);
    expect(rows[1]!.id).toBe(id1);
  });

  it('inserts a photo kind row', () => {
    const { mem } = setup();
    const session = mem.sessions.getOrCreate(9007);

    mem.fileSends.insert({
      session_id: session.id,
      chat_id: 9007,
      path: '/tmp/image.png',
      basename: 'image.png',
      bytes: 512000,
      ext: '.png',
      kind: 'photo',
      telegram_message_id: 99,
      ok: true,
    });

    const rows = mem.fileSends.listRecent(session.id, 10);
    expect(rows[0]!.kind).toBe('photo');
  });
});
