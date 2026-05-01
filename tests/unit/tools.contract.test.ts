/**
 * Sub-Phase C — Tool contract tests.
 * Assert:
 *   - registerTools() produces the MVP tool set (no web_fetch when web.enabled=false)
 *   - toClaudeToolDefs produces a JSON Schema with properties matching zod shape
 *   - All tool names are unique and have non-empty descriptions
 *   - Every ToolResult error shape has { code, message }
 */
import { describe, it, expect } from 'vitest';
import { registerTools, toClaudeToolDefs, dispatch } from '../../src/tools/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { initSafety } from '../../src/safety/index.js';
import { getLogger } from '../../src/logger/index.js';
import path from 'path';

function setup() {
  _resetDb();
  const cfg = makeTestConfig();
  cfg.memory.dbPath = path.join(cfg.filesystem.allowedPaths[0]!, 'contract.db');
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
  return { cfg, mem, safety, tools };
}

describe('tools contract — registerTools', () => {
  it('registers exactly the MVP tools when web.enabled=false', () => {
    const { tools } = setup();
    const names = tools.map((t) => t.name).sort();
    // v1.4.1: recall_archive always registered; v1.5.0: send_file always registered
    // v1.8.5: update_memory + forget_memory always registered
    expect(names).toEqual(
      [
        'list_directory',
        'read_file',
        'recall_archive',
        'run_command',
        'search_files',
        'send_file',
        'system_info',
        'write_file',
        'update_memory',
        'forget_memory',
        // v1.8.6: organize tools always registered (DM-only via group-mode filter, not config gate)
        'organize_create',
        'organize_update',
        'organize_complete',
        'organize_list',
        'organize_log_progress',
        'organize_delete',
        // v1.10.0: schedule tool always registered (group-mode filtered via disabledTools config)
        'schedule',
        // v1.18.0: coach tools always registered (DM-only, group-mode filtered via disabledTools)
        'coach_log_nudge',
        'coach_log_research',
        'coach_log_idea',
        'coach_log_plan',
        'coach_read_history',
        // v1.19.0 R3: sole-writer tool for NL user overrides (back_off / push / defer / done_signal)
        'coach_log_user_override',
        // v1.22.14: orchestrator-only delegation primitive
        'delegate_to_specialist',
      ].sort(),
    );
    expect(names).not.toContain('web_fetch');
  });

  it('every tool has a non-empty description', () => {
    const { tools } = setup();
    for (const t of tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('tool names are unique', () => {
    const { tools } = setup();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('tools contract — toClaudeToolDefs', () => {
  it('produces a JSON schema with an object input_schema per tool', () => {
    const { tools } = setup();
    const defs = toClaudeToolDefs(tools);
    expect(defs.length).toBe(tools.length);
    for (const d of defs) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.input_schema).toBeTruthy();
      const schema = d.input_schema as Record<string, unknown>;
      expect(schema['type']).toBe('object');
      expect(schema['$schema']).toBeUndefined();
      expect(schema['properties']).toBeTruthy();
    }
  });

  it('read_file schema has a path property', () => {
    const { tools } = setup();
    const defs = toClaudeToolDefs(tools);
    const readDef = defs.find((d) => d.name === 'read_file');
    expect(readDef).toBeDefined();
    const props = (readDef!.input_schema as Record<string, Record<string, unknown>>)['properties'];
    expect(props?.['path']).toBeDefined();
  });
});

describe('tools contract — ToolResult error shape', () => {
  it('UNKNOWN_TOOL result has { ok:false, error:{code,message} }', async () => {
    const { cfg, mem, safety } = setup();
    const r = await dispatch('nope_xyz', {}, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNKNOWN_TOOL');
    expect(typeof r.error?.message).toBe('string');
    expect(r.error!.message.length).toBeGreaterThan(0);
  });

  it('INVALID_INPUT result has { ok:false, error:{code,message} }', async () => {
    const { cfg, mem, safety } = setup();
    const r = await dispatch('read_file', { wrong: 1 }, {
      sessionId: 1,
      chatId: 12345,
      logger: getLogger(),
      config: cfg,
      memory: mem,
      safety,
      abortSignal: new AbortController().signal,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_INPUT');
    expect(r.error?.message).toBeTruthy();
  });
});
