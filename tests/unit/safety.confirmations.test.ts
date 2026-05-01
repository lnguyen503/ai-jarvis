/**
 * §15.4 — Confirmation flow tests (C6, W5).
 * Single pending per session, action-id matching, TTL expiry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ConfirmationManager } from '../../src/safety/confirmations.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AppConfig } from '../../src/config/schema.js';

function setup(ttlMs = 300000): { cfg: AppConfig; mem: MemoryApi; mgr: ConfirmationManager } {
  _resetDb();
  const dbFile = path.join(os.tmpdir(), `jarvis-confirm-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({
    memory: { dbPath: dbFile, maxHistoryMessages: 50 },
    safety: {
      confirmationTtlMs: ttlMs,
      commandTimeoutMs: 120000,
      maxOutputLength: 4000,
      allowEncodedCommands: false,
      blockedCommands: [],
    },
  });
  const mem = initMemory(cfg);
  const mgr = new ConfirmationManager(cfg, mem);
  mgr._clearAll();
  // Seed a session
  mem.sessions.getOrCreate(99999);
  return { cfg, mem, mgr };
}

describe('safety.confirmations (§15.4)', () => {
  let cfg: AppConfig;
  let mem: MemoryApi;
  let mgr: ConfirmationManager;
  const SESSION_ID = 1;

  beforeEach(() => {
    const s = setup();
    cfg = s.cfg;
    mem = s.mem;
    mgr = s.mgr;
  });

  it('requireConfirmation returns a 4-char hex actionId', () => {
    const { actionId } = mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm D:\\x',
      command: 'Remove-Item D:\\x',
      shell: 'powershell',
    });
    expect(actionId).toMatch(/^[0-9a-f]{4}$/);
  });

  it('new destructive call while one is pending throws CONFIRMATION_PENDING', () => {
    mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'first',
      command: 'Remove-Item D:\\a',
      shell: 'powershell',
    });
    expect(() =>
      mgr.requireConfirmation(SESSION_ID, {
        sessionId: SESSION_ID,
        description: 'second',
        command: 'Remove-Item D:\\b',
        shell: 'powershell',
      }),
    ).toThrow();
  });

  it('YES alone consumes a single pending action', () => {
    mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm',
      command: 'Remove-Item D:\\x',
      shell: 'powershell',
    });
    const consumed = mgr.consumeConfirmation(SESSION_ID, 'YES');
    expect(consumed).not.toBeNull();
    expect(consumed?.command).toBe('Remove-Item D:\\x');
  });

  it('YES <actionId> consumes only the matching action', () => {
    const { actionId } = mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm',
      command: 'Remove-Item D:\\x',
      shell: 'powershell',
    });
    const consumed = mgr.consumeConfirmation(SESSION_ID, `YES ${actionId}`);
    expect(consumed).not.toBeNull();
  });

  it('YES with wrong actionId does NOT consume', () => {
    const { actionId } = mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm',
      command: 'Remove-Item D:\\x',
      shell: 'powershell',
    });
    const wrong = actionId === 'abcd' ? 'aaaa' : 'abcd';
    const consumed = mgr.consumeConfirmation(SESSION_ID, `YES ${wrong}`);
    expect(consumed).toBeNull();
    // Original action is still pending
    expect(mgr.hasPending(SESSION_ID)).toBe(true);
  });

  it('Pending action past TTL returns null and emits expiry row', () => {
    // Use short TTL
    const s = setup(100);
    s.mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm',
      command: 'Remove-Item D:\\x',
      shell: 'powershell',
    });
    // Consume 500ms in the future (past 100ms TTL)
    const consumed = s.mgr.consumeConfirmation(SESSION_ID, 'YES', Date.now() + 500);
    expect(consumed).toBeNull();
    // Expiry row in command_log
    const logs = s.mem.commandLog.listRecent(20);
    const expiryRow = logs.find(
      (r) => r.command === '__confirmation__' && r.stdout_preview?.includes('EXPIRED'),
    );
    expect(expiryRow).toBeDefined();
  });

  it('TTL is read from config.safety.confirmationTtlMs', () => {
    // Verify by creating a manager with 100ms TTL and confirming expiry
    const s = setup(100);
    s.mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm',
      command: 'Remove-Item D:\\x',
      shell: 'powershell',
    });
    expect(s.mgr.hasPending(SESSION_ID)).toBe(true);
    const future = Date.now() + 200;
    expect(s.mgr.consumeConfirmation(SESSION_ID, 'YES', future)).toBeNull();
  });

  it('hasPending returns false after consumption', () => {
    mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm',
      command: 'rm',
      shell: 'powershell',
    });
    expect(mgr.hasPending(SESSION_ID)).toBe(true);
    mgr.consumeConfirmation(SESSION_ID, 'YES');
    expect(mgr.hasPending(SESSION_ID)).toBe(false);
  });

  it('emits confirmation_prompted audit row', () => {
    mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm D:\\x',
      command: 'Remove-Item D:\\x',
      shell: 'powershell',
    });
    const logs = mem.commandLog.listRecent(20);
    const prompted = logs.find(
      (r) => r.command === '__confirmation__' && r.stdout_preview?.includes('PROMPTED'),
    );
    expect(prompted).toBeDefined();
  });

  it('emits confirmation_consumed audit row on YES', () => {
    mgr.requireConfirmation(SESSION_ID, {
      sessionId: SESSION_ID,
      description: 'rm',
      command: 'rm',
      shell: 'powershell',
    });
    mgr.consumeConfirmation(SESSION_ID, 'YES');
    const logs = mem.commandLog.listRecent(20);
    const consumed = logs.find(
      (r) => r.command === '__confirmation__' && r.stdout_preview?.includes('CONSUMED'),
    );
    expect(consumed).toBeDefined();
  });
});
