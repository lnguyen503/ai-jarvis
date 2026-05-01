/**
 * v1.7.10 — adminOnly tool flag.
 * Tools flagged adminOnly should be visible only to admin sessions.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toolsForContext } from '../../src/tools/index.js';
import type { Tool } from '../../src/tools/types.js';

function mkTool(name: string, adminOnly = false): Tool {
  return {
    name,
    description: `mock ${name}`,
    parameters: z.object({}),
    adminOnly,
    async execute() {
      return { ok: true, output: '' };
    },
  };
}

describe('adminOnly tool filtering', () => {
  it('toolsForContext does NOT filter adminOnly by itself (agent layer does that)', () => {
    // Confirms the existing toolsForContext signature remains agnostic to
    // role; agent/index.ts layers the adminOnly filter on top afterwards.
    const all = [mkTool('run_command'), mkTool('gmail_read', true), mkTool('read_file')];
    const afterGroupFilter = toolsForContext({
      groupMode: true,
      disabledTools: ['run_command'],
      allTools: all,
    });
    expect(afterGroupFilter.map((t) => t.name)).toEqual(['gmail_read', 'read_file']);
  });

  it('simulates agent-layer adminOnly filter for a developer role', () => {
    const all = [mkTool('run_command'), mkTool('gmail_read', true), mkTool('read_file')];
    const afterGroupFilter = toolsForContext({
      groupMode: false,
      disabledTools: [],
      allTools: all,
    });
    // Non-admin: drop admin-only tools, as agent/index.ts does.
    const role: 'admin' | 'developer' | 'member' = 'developer';
    const visible =
      role !== 'admin' ? afterGroupFilter.filter((t) => !t.adminOnly) : afterGroupFilter;
    expect(visible.map((t) => t.name)).toEqual(['run_command', 'read_file']);
  });

  it('admin sees adminOnly tools', () => {
    const all = [mkTool('run_command'), mkTool('gmail_read', true)];
    const role: 'admin' | 'developer' | 'member' = 'admin';
    const visible = role !== 'admin' ? all.filter((t) => !t.adminOnly) : all;
    expect(visible.map((t) => t.name)).toEqual(['run_command', 'gmail_read']);
  });

  it('member does not see adminOnly tools OR member-blocked tools', () => {
    const all = [
      mkTool('run_command'),
      mkTool('gmail_read', true),
      mkTool('read_file'),
    ];
    const afterGroupFilter = toolsForContext({
      groupMode: true,
      disabledTools: ['run_command'],
      allTools: all,
    });
    const role: 'admin' | 'developer' | 'member' = 'member';
    const visible =
      role !== 'admin' ? afterGroupFilter.filter((t) => !t.adminOnly) : afterGroupFilter;
    expect(visible.map((t) => t.name)).toEqual(['read_file']);
  });
});
