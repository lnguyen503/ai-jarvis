/**
 * Unit tests for the `schedule` agent tool (v1.10.0).
 *
 * Coverage:
 *   - Happy path: insert, audit row (scheduler.create), ok:true output
 *   - Invalid cron → INVALID_CRON
 *   - Missing userId → NO_USER_ID
 *   - DB insert throws → SCHEDULE_INSERT_FAILED
 *   - schedulerApi.reload throws → tool still returns ok:true (non-fatal per R11)
 *   - schedulerApi absent → tool returns ok:true without calling reload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { scheduleTool } from '../../src/tools/schedule.js';
import type { ToolContext } from '../../src/tools/types.js';
import type { InsertAuditParams } from '../../src/memory/auditLog.js';

const silentLogger = pino({ level: 'silent' });

const USER_ID = 42;
const CHAT_ID = 100;
const SESSION_ID = 7;

// ---------------------------------------------------------------------------
// Mock memory builder
// ---------------------------------------------------------------------------

function makeMemory(opts: {
  insertResult?: number | Error;
} = {}) {
  const auditRows: InsertAuditParams[] = [];
  const insertFn = vi.fn(() => {
    if (opts.insertResult instanceof Error) throw opts.insertResult;
    return opts.insertResult ?? 1;
  });

  return {
    scheduledTasks: {
      insert: insertFn,
    },
    auditLog: {
      insert: (params: InsertAuditParams) => { auditRows.push(params); },
    },
    // Store audit rows for test assertions
    _auditRows: auditRows,
    _insertFn: insertFn,
  };
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> & {
  _memory?: ReturnType<typeof makeMemory>;
  schedulerApi?: { reload(): void } | null;
} = {}): ToolContext & { _memory: ReturnType<typeof makeMemory> } {
  const mem = overrides._memory ?? makeMemory();
  return {
    sessionId: SESSION_ID,
    chatId: CHAT_ID,
    userId: USER_ID,
    logger: silentLogger,
    config: {} as ToolContext['config'],
    memory: mem as unknown as ToolContext['memory'],
    safety: { scrub: (s: string) => s, scrubRecord: (r: object) => r } as unknown as ToolContext['safety'],
    abortSignal: new AbortController().signal,
    schedulerApi: overrides.schedulerApi === null ? undefined : (overrides.schedulerApi ?? undefined),
    ...overrides,
    _memory: mem,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tools.schedule', () => {
  it('happy path: inserts task, emits scheduler.create audit row, returns ok:true', async () => {
    const mem = makeMemory({ insertResult: 42 });
    const ctx = makeCtx({ _memory: mem });

    const result = await scheduleTool.execute(
      { description: 'morning goals', cron: '0 8 * * *', command: 'list my active organize items' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Scheduled:');
    expect(result.output).toContain('morning goals');
    expect(result.output).toContain('0 8 * * *');

    expect(mem._insertFn).toHaveBeenCalledOnce();
    expect(mem._insertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'morning goals',
        cron_expression: '0 8 * * *',
        command: 'list my active organize items',
        chat_id: CHAT_ID,
        owner_user_id: USER_ID,
      }),
    );

    const audit = mem._auditRows.find((r) => r.category === 'scheduler.create');
    expect(audit).toBeDefined();
    expect(audit?.actor_user_id).toBe(USER_ID);
    expect(audit?.detail.taskId).toBe(42);
    expect(audit?.detail.description).toBe('morning goals');
    expect(audit?.detail.cron).toBe('0 8 * * *');
  });

  it('invalid cron → INVALID_CRON, no DB insert', async () => {
    const mem = makeMemory();
    const ctx = makeCtx({ _memory: mem });

    const result = await scheduleTool.execute(
      { description: 'bad', cron: 'not a cron', command: 'do something' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_CRON');
    expect(result.output).toContain('invalid');
    expect(mem._insertFn).not.toHaveBeenCalled();
  });

  it('missing userId → NO_USER_ID', async () => {
    const mem = makeMemory();
    const ctx = makeCtx({ _memory: mem, userId: undefined });

    const result = await scheduleTool.execute(
      { description: 'test', cron: '0 8 * * *', command: 'do it' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_USER_ID');
    expect(mem._insertFn).not.toHaveBeenCalled();
  });

  it('DB insert throws → SCHEDULE_INSERT_FAILED, no audit row', async () => {
    const mem = makeMemory({ insertResult: new Error('disk full') });
    const ctx = makeCtx({ _memory: mem });

    const result = await scheduleTool.execute(
      { description: 'test', cron: '0 8 * * *', command: 'do it' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SCHEDULE_INSERT_FAILED');
    expect(result.output).toContain('disk full');
    // No audit row should be emitted when the insert failed
    expect(mem._auditRows.find((r) => r.category === 'scheduler.create')).toBeUndefined();
  });

  it('schedulerApi.reload throws → tool still returns ok:true (non-fatal per R11)', async () => {
    const mem = makeMemory({ insertResult: 5 });
    const schedulerApi = {
      reload: vi.fn(() => { throw new Error('scheduler error'); }),
    };
    const ctx = makeCtx({ _memory: mem, schedulerApi });

    const result = await scheduleTool.execute(
      { description: 'test', cron: '*/15 * * * *', command: 'check stuff' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(schedulerApi.reload).toHaveBeenCalledOnce();
    // Audit still emitted
    expect(mem._auditRows.find((r) => r.category === 'scheduler.create')).toBeDefined();
  });

  it('schedulerApi absent → ok:true, no reload attempt', async () => {
    const mem = makeMemory({ insertResult: 3 });
    const ctx = makeCtx({ _memory: mem });
    // schedulerApi is undefined by default in makeCtx

    const result = await scheduleTool.execute(
      { description: 'test', cron: '0 9 * * 1-5', command: 'do weekday stuff' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Scheduled:');
  });

  it('schedulerApi provided and healthy → reload called once', async () => {
    const mem = makeMemory({ insertResult: 99 });
    const schedulerApi = { reload: vi.fn() };
    const ctx = makeCtx({ _memory: mem, schedulerApi });

    const result = await scheduleTool.execute(
      { description: 'weekly summary', cron: '0 9 * * 1', command: 'summarize last week' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(schedulerApi.reload).toHaveBeenCalledOnce();
  });

  it('tool has adminOnly: false', () => {
    expect(scheduleTool.adminOnly).toBe(false);
  });

  it('tool name is "schedule"', () => {
    expect(scheduleTool.name).toBe('schedule');
  });

  it('audit row carries commandPreview truncated at 100 chars', async () => {
    const longCommand = 'x'.repeat(200);
    const mem = makeMemory({ insertResult: 10 });
    const ctx = makeCtx({ _memory: mem });

    await scheduleTool.execute(
      { description: 'long command task', cron: '0 8 * * *', command: longCommand },
      ctx,
    );

    const audit = mem._auditRows.find((r) => r.category === 'scheduler.create');
    expect(audit?.detail.commandPreview).toHaveLength(100);
  });
});
