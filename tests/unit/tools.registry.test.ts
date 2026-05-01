/**
 * §15.8 — web_fetch removal test (C8).
 * Asserts registerTools does NOT include web_fetch when web.enabled=false (default).
 */
import { describe, it, expect } from 'vitest';
import { registerTools, toClaudeToolDefs } from '../../src/tools/index.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';
import { initMemory } from '../../src/memory/index.js';
import { initSafety } from '../../src/safety/index.js';
import { _resetDb } from '../../src/memory/db.js';
import { getLogger } from '../../src/logger/index.js';
import path from 'path';
import os from 'os';

function setup() {
  _resetDb();
  const dbPath = path.join(os.tmpdir(), `jarvis-tools-${Date.now()}-${Math.random()}.db`);
  const cfg = makeTestConfig({ memory: { dbPath, maxHistoryMessages: 50 } });
  const mem = initMemory(cfg);
  const safety = initSafety(cfg, mem);
  return { cfg, mem, safety };
}

describe('tools.registry (§15.8 web_fetch removal)', () => {
  it('registerTools() does NOT include web_fetch when config.web.enabled=false', () => {
    const { cfg, safety, mem } = setup();
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('web_fetch');
  });

  it('Claude tool defs array has no entry named web_fetch', () => {
    const { cfg, safety, mem } = setup();
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const defs = toClaudeToolDefs(tools);
    expect(defs.find((d) => d.name === 'web_fetch')).toBeUndefined();
  });

  it('registers the expected MVP tools', () => {
    const { cfg, safety, mem } = setup();
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const names = tools.map((t) => t.name);
    expect(names).toContain('run_command');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('list_directory');
    expect(names).toContain('search_files');
    expect(names).toContain('system_info');
    // v1.4.1: recall_archive is always registered; v1.5.0: send_file always registered
    expect(names).toContain('recall_archive');
    expect(names).toContain('send_file');
    // v1.8.5: persistent user memory tools always registered
    expect(names).toContain('update_memory');
    expect(names).toContain('forget_memory');
    // v1.8.6: organize tools always registered (DM-only via agent group-mode filter, not config gate)
    expect(names).toContain('organize_create');
    expect(names).toContain('organize_update');
    expect(names).toContain('organize_complete');
    expect(names).toContain('organize_list');
    expect(names).toContain('organize_log_progress');
    expect(names).toContain('organize_delete');
    // v1.10.0: schedule tool always registered (group-mode filtered via disabledTools config)
    expect(names).toContain('schedule');
    // v1.18.0: coach tools always registered (DM-only, group-mode filtered via disabledTools)
    expect(names).toContain('coach_log_nudge');
    expect(names).toContain('coach_log_research');
    expect(names).toContain('coach_log_idea');
    expect(names).toContain('coach_log_plan');
    expect(names).toContain('coach_read_history');
    // v1.19.0 R3: sole-writer tool for NL user overrides
    expect(names).toContain('coach_log_user_override');
    // v1.22.14: orchestrator-only delegation primitive (filtered into activeTools
    // by the agent loop only in assemble mode for full-scope bots)
    expect(names).toContain('delegate_to_specialist');
    expect(names.length).toBe(24);
  });

  it('toClaudeToolDefs produces valid input_schema for each tool', () => {
    const { cfg, safety, mem } = setup();
    const tools = registerTools({ config: cfg, logger: getLogger(), safety, memory: mem });
    const defs = toClaudeToolDefs(tools);
    for (const d of defs) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.input_schema).toBeDefined();
      expect(d.input_schema.type).toBe('object');
    }
  });
});
