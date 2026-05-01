/**
 * §15.7 — Session scoping invariant tests (W3).
 * Every query against messages/command_log MUST filter by session_id.
 * Every sessions lookup MUST filter by telegram_chat_id.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import path from 'path';
import os from 'os';

function freshMemory(): MemoryApi {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-scoping-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({
    memory: { dbPath, maxHistoryMessages: 50 },
  });
  return initMemory(cfg);
}

describe('memory scoping invariant (§15.7)', () => {
  let mem: MemoryApi;

  beforeEach(() => {
    mem = freshMemory();
  });

  it('MessagesRepo.listRecent(sessionId) returns no rows from other sessions', () => {
    const s1 = mem.sessions.getOrCreate(111);
    const s2 = mem.sessions.getOrCreate(222);

    mem.messages.insert({ session_id: s1.id, role: 'user', content: 'hello from s1' });
    mem.messages.insert({ session_id: s2.id, role: 'user', content: 'hello from s2' });

    const s1Messages = mem.messages.listRecent(s1.id, 50);
    expect(s1Messages.every((m) => m.session_id === s1.id)).toBe(true);
    expect(s1Messages.some((m) => m.content === 'hello from s1')).toBe(true);
    expect(s1Messages.some((m) => m.content === 'hello from s2')).toBe(false);
  });

  it('CommandLogRepo.listForSession(sessionId) does not leak other sessions', () => {
    const s1 = mem.sessions.getOrCreate(111);
    const s2 = mem.sessions.getOrCreate(222);

    mem.commandLog.insert({
      session_id: s1.id,
      command: 'echo s1',
      working_dir: '/',
    });
    mem.commandLog.insert({
      session_id: s2.id,
      command: 'echo s2',
      working_dir: '/',
    });

    const s1Logs = mem.commandLog.listForSession(s1.id, 50);
    expect(s1Logs.every((r) => r.session_id === s1.id)).toBe(true);
    expect(s1Logs.some((r) => r.command === 'echo s1')).toBe(true);
    expect(s1Logs.some((r) => r.command === 'echo s2')).toBe(false);
  });

  it('SessionsRepo.getOrCreate(chatId) returns existing only when telegram_chat_id matches', () => {
    const s1 = mem.sessions.getOrCreate(111);
    const again = mem.sessions.getOrCreate(111);
    expect(again.id).toBe(s1.id);

    const s2 = mem.sessions.getOrCreate(222);
    expect(s2.id).not.toBe(s1.id);
  });

  it('SessionsRepo.getById enforces telegram_chat_id scope', () => {
    const s1 = mem.sessions.getOrCreate(111);
    expect(mem.sessions.getById(s1.id, 111)).toBeDefined();
    // Wrong chatId — must return undefined
    expect(mem.sessions.getById(s1.id, 222)).toBeUndefined();
  });
});
