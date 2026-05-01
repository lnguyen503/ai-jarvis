/**
 * Unit tests for src/tools/send_file.ts
 *
 * All tests use a mocked TelegramAdapter — no live Telegram calls.
 * Files are created in a tmp directory that is registered as the allowed root.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import sendFileTool from '../../src/tools/send_file.js';
import { makeTestConfig, cleanupTmpRoot } from '../fixtures/makeConfig.js';
import { makeMockTelegramAdapter } from '../fixtures/mockTelegramAdapter.js';
import { initMemory, type MemoryApi } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { ToolContext } from '../../src/tools/types.js';

let cfg: AppConfig;
let mem: MemoryApi;
let safety: ReturnType<typeof initSafety>;
let root: string;

function setup() {
  _resetDb();
  cfg = makeTestConfig();
  root = cfg.filesystem.allowedPaths[0]!;
  cfg.memory.dbPath = path.join(root, 'send_file_test.db');
  mem = initMemory(cfg);
  safety = initSafety(cfg, mem);
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: mem.sessions.getOrCreate(7001).id,
    chatId: 7001,
    logger: getLogger(),
    config: cfg,
    memory: mem,
    safety,
    abortSignal: new AbortController().signal,
    telegram: makeMockTelegramAdapter(),
    ...overrides,
  };
}

beforeEach(() => setup());

afterEach(() => {
  vi.clearAllMocks();
  if (cfg) cleanupTmpRoot(cfg);
  _resetDb();
});

describe('send_file tool — metadata', () => {
  it('has name send_file', () => {
    expect(sendFileTool.name).toBe('send_file');
  });

  it('has a non-empty description mentioning 50MB and allowed extensions', () => {
    expect(sendFileTool.description).toContain('50MB');
    expect(sendFileTool.description).toContain('.html');
    expect(sendFileTool.description).toContain('.md');
  });
});

describe('send_file tool — happy path: document', () => {
  it('sends an .md file as a document, adapter called once, row inserted, ok:true', async () => {
    const filePath = path.join(root, 'report.md');
    fs.writeFileSync(filePath, '# Report\nSome content');

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });
    const session = mem.sessions.getOrCreate(ctx.chatId);

    const result = await sendFileTool.execute(
      { path: filePath, caption: 'Here is your report', preview: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('report.md');
    expect(result.data?.['kind']).toBe('document');

    // Adapter: sendDocument called once, sendPhoto NOT called
    expect(mockTelegram.sendDocument).toHaveBeenCalledOnce();
    expect(mockTelegram.sendPhoto).not.toHaveBeenCalled();

    const [callChatId, callPath, callOpts] = mockTelegram.sendDocument.mock.calls[0]!;
    expect(callChatId).toBe(ctx.chatId);
    expect(callPath).toBe(filePath);
    expect(callOpts?.caption).toBe('Here is your report');

    // Audit row inserted with ok=true
    const rows = mem.fileSends.listRecent(session.id, 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row.ok).toBe(1);
    expect(row.basename).toBe('report.md');
    expect(row.kind).toBe('document');
    expect(row.telegram_message_id).toBe(42); // mock default
  });
});

describe('send_file tool — happy path: photo preview', () => {
  it('sends a .png as a photo when preview:true, sendPhoto called', async () => {
    const imgPath = path.join(root, 'screenshot.png');
    fs.writeFileSync(imgPath, Buffer.from('fake-png-data'));

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: imgPath, preview: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.['kind']).toBe('photo');
    expect(mockTelegram.sendPhoto).toHaveBeenCalledOnce();
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();

    const [callChatId, callPath] = mockTelegram.sendPhoto.mock.calls[0]!;
    expect(callChatId).toBe(ctx.chatId);
    expect(callPath).toBe(imgPath);
  });

  it('sends a .jpg as a photo when preview:true', async () => {
    const imgPath = path.join(root, 'photo.jpg');
    fs.writeFileSync(imgPath, Buffer.from('fake-jpg-data'));

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: imgPath, preview: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data?.['kind']).toBe('photo');
    expect(mockTelegram.sendPhoto).toHaveBeenCalledOnce();
  });
});

describe('send_file tool — path sandbox checks', () => {
  it('rejects a path outside allowed roots with PATH_DENIED, no adapter call', async () => {
    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: 'C:\\Windows\\System32\\cmd.exe', preview: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();
    expect(mockTelegram.sendPhoto).not.toHaveBeenCalled();
  });

  it('rejects .env inside allowed root (read denylist), PATH_DENIED', async () => {
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, 'SECRET=abc123');

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: envPath, preview: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PATH_DENIED');
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();
  });
});

describe('send_file tool — extension allowlist', () => {
  it('rejects an unsupported extension (.exe), no adapter call', async () => {
    const exePath = path.join(root, 'malware.exe');
    fs.writeFileSync(exePath, 'MZ...');

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: exePath, preview: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_EXTENSION');
    expect(result.output).toContain('.exe');
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();
  });

  it('extension check is case-insensitive (.PNG works)', async () => {
    const imgPath = path.join(root, 'IMAGE.PNG');
    fs.writeFileSync(imgPath, Buffer.from('fake-png'));

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: imgPath, preview: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(mockTelegram.sendDocument).toHaveBeenCalledOnce();
  });

  it('rejects .bat extension', async () => {
    const batPath = path.join(root, 'script.bat');
    fs.writeFileSync(batPath, '@echo off');

    const ctx = makeCtx({ telegram: makeMockTelegramAdapter() });

    const result = await sendFileTool.execute({ path: batPath }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_EXTENSION');
  });
});

describe('send_file tool — size limit', () => {
  it('rejects a file larger than 50MB, no adapter call', async () => {
    const bigPath = path.join(root, 'toobig.zip');
    fs.writeFileSync(bigPath, 'x'); // real content doesn't matter — we mock stat

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    // Mock fs.statSync to return a huge size
    const statSpy = vi.spyOn(fs, 'statSync').mockReturnValueOnce({
      isFile: () => true,
      size: 51 * 1024 * 1024, // 51 MB
    } as fs.Stats);

    const result = await sendFileTool.execute(
      { path: bigPath, preview: false },
      ctx,
    );

    statSpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FILE_TOO_LARGE');
    expect(result.output).toContain('51.0 MB');
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at 50MB boundary', async () => {
    const bigPath = path.join(root, 'exact.zip');
    fs.writeFileSync(bigPath, 'x');

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const statSpy = vi.spyOn(fs, 'statSync').mockReturnValueOnce({
      isFile: () => true,
      size: 50 * 1024 * 1024, // exactly 50 MB
    } as fs.Stats);

    const result = await sendFileTool.execute(
      { path: bigPath, preview: false },
      ctx,
    );

    statSpy.mockRestore();

    expect(result.ok).toBe(true);
    expect(mockTelegram.sendDocument).toHaveBeenCalledOnce();
  });
});

describe('send_file tool — file system edge cases', () => {
  it('rejects a path that is a directory, NOT_A_FILE', async () => {
    // root itself is a directory
    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: root, preview: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_A_FILE');
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();
  });

  it('rejects a non-existent file cleanly, STAT_ERROR', async () => {
    const ghostPath = path.join(root, 'doesnotexist.txt');

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute(
      { path: ghostPath, preview: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STAT_ERROR');
    expect(mockTelegram.sendDocument).not.toHaveBeenCalled();
  });
});

describe('send_file tool — Telegram API error handling', () => {
  it('returns ok:false with scrubbed error when adapter throws; row inserted with ok=false', async () => {
    const filePath = path.join(root, 'problematic.txt');
    fs.writeFileSync(filePath, 'content');

    const mockTelegram = makeMockTelegramAdapter();
    mockTelegram.sendDocument.mockRejectedValueOnce(
      new Error('Telegram returned 400 Bad Request: PHOTO_INVALID_DIMENSIONS'),
    );

    const session = mem.sessions.getOrCreate(7001);
    const ctx = makeCtx({ telegram: mockTelegram, sessionId: session.id });

    const result = await sendFileTool.execute(
      { path: filePath, preview: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TELEGRAM_ERROR');
    // The error message must not contain a raw secret (scrubber ran)
    expect(result.output).toContain('problematic.txt');

    // Audit row inserted with ok=false and error set
    const rows = mem.fileSends.listRecent(session.id, 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row.ok).toBe(0);
    expect(row.error).toBeTruthy();
  });
});

describe('send_file tool — no telegram adapter', () => {
  it('returns ok:false with NO_TELEGRAM_ADAPTER when ctx.telegram is missing', async () => {
    const filePath = path.join(root, 'test.txt');
    fs.writeFileSync(filePath, 'hello');

    // Build ctx without telegram
    const ctx = makeCtx({ telegram: undefined });

    const result = await sendFileTool.execute(
      { path: filePath, preview: false },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NO_TELEGRAM_ADAPTER');
  });
});

describe('send_file tool — output format', () => {
  it('output includes basename and human-readable size', async () => {
    const filePath = path.join(root, 'notes.txt');
    // Write exactly 2048 bytes
    fs.writeFileSync(filePath, Buffer.alloc(2048, 'x'));

    const mockTelegram = makeMockTelegramAdapter();
    const ctx = makeCtx({ telegram: mockTelegram });

    const result = await sendFileTool.execute({ path: filePath }, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('notes.txt');
    // 2048 bytes = 2 KB
    expect(result.output).toContain('2 KB');
  });

  it('result data includes path, bytes, kind, messageId', async () => {
    const filePath = path.join(root, 'data.json');
    fs.writeFileSync(filePath, '{}');

    const ctx = makeCtx({ telegram: makeMockTelegramAdapter() });
    const result = await sendFileTool.execute({ path: filePath }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data?.['path']).toBe(filePath);
    expect(typeof result.data?.['bytes']).toBe('number');
    expect(result.data?.['kind']).toBe('document');
    expect(result.data?.['messageId']).toBe(42); // mock default
  });
});
