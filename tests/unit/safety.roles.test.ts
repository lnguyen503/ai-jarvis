/**
 * v1.7.5 role resolution tests.
 */
import { describe, it, expect } from 'vitest';
import { resolveRole, blockedToolsForRole } from '../../src/safety/roles.js';
import { makeTestConfig } from '../fixtures/makeConfig.js';

function withRoleConfig() {
  const cfg = makeTestConfig();
  cfg.groups.adminUserIds = [1001];
  cfg.groups.developerUserIds = [2002];
  return cfg;
}

describe('safety.roles — resolveRole', () => {
  it('DM returns admin regardless of userId', () => {
    const cfg = withRoleConfig();
    expect(resolveRole({ chatId: 5, userId: 999, chatType: 'private' }, cfg)).toBe('admin');
  });

  it('group admin userId returns admin', () => {
    const cfg = withRoleConfig();
    expect(resolveRole({ chatId: -100, userId: 1001, chatType: 'group' }, cfg)).toBe('admin');
  });

  it('group developer userId returns developer', () => {
    const cfg = withRoleConfig();
    expect(resolveRole({ chatId: -100, userId: 2002, chatType: 'group' }, cfg)).toBe('developer');
  });

  it('group non-listed userId returns member', () => {
    const cfg = withRoleConfig();
    expect(resolveRole({ chatId: -100, userId: 9999, chatType: 'group' }, cfg)).toBe('member');
  });

  it('group with undefined userId returns member', () => {
    const cfg = withRoleConfig();
    expect(resolveRole({ chatId: -100, userId: undefined, chatType: 'group' }, cfg)).toBe('member');
  });

  it('admin listed in developers still resolves admin (admin wins)', () => {
    const cfg = withRoleConfig();
    cfg.groups.developerUserIds = [1001, 2002]; // user is in both
    expect(resolveRole({ chatId: -100, userId: 1001, chatType: 'group' }, cfg)).toBe('admin');
  });

  // v1.7.6 — per-group role maps
  it('per-group developer in chat A is not a developer in chat B', () => {
    const cfg = withRoleConfig();
    cfg.groups.developerUserIds = []; // no legacy globals
    cfg.groups.groupRoles = {
      '-100': { developers: [7777] },
    };
    expect(resolveRole({ chatId: -100, userId: 7777, chatType: 'group' }, cfg)).toBe('developer');
    expect(resolveRole({ chatId: -200, userId: 7777, chatType: 'group' }, cfg)).toBe('member');
  });

  it('per-group admin wins over legacy developer list', () => {
    const cfg = withRoleConfig();
    cfg.groups.developerUserIds = [7777]; // legacy says developer everywhere
    cfg.groups.groupRoles = {
      '-100': { admins: [7777] }, // but in chat -100 specifically, admin
    };
    expect(resolveRole({ chatId: -100, userId: 7777, chatType: 'group' }, cfg)).toBe('admin');
    expect(resolveRole({ chatId: -200, userId: 7777, chatType: 'group' }, cfg)).toBe('developer');
  });

  it('global admin wins over per-group role assignment', () => {
    const cfg = withRoleConfig();
    cfg.groups.adminUserIds = [1001];
    cfg.groups.groupRoles = {
      '-100': { developers: [1001] }, // demote attempt: ignored
    };
    expect(resolveRole({ chatId: -100, userId: 1001, chatType: 'group' }, cfg)).toBe('admin');
  });

  it('per-group role map absent for a chat means default resolution', () => {
    const cfg = withRoleConfig();
    cfg.groups.groupRoles = {}; // no entries at all
    expect(resolveRole({ chatId: -100, userId: 9999, chatType: 'group' }, cfg)).toBe('member');
    // Legacy developer list still works
    cfg.groups.developerUserIds = [9999];
    expect(resolveRole({ chatId: -100, userId: 9999, chatType: 'group' }, cfg)).toBe('developer');
  });

  it('per-group resolution uses chat ID as string key', () => {
    const cfg = withRoleConfig();
    cfg.groups.groupRoles = {
      '-1001234567890': { developers: [42] },
    };
    expect(
      resolveRole({ chatId: -1001234567890, userId: 42, chatType: 'group' }, cfg),
    ).toBe('developer');
  });
});

describe('safety.roles — blockedToolsForRole', () => {
  it('admin sees no blocked tools', () => {
    expect(blockedToolsForRole('admin').size).toBe(0);
  });
  it('developer sees no blocked tools', () => {
    expect(blockedToolsForRole('developer').size).toBe(0);
  });
  it('member is blocked from run_command, write_file, system_info', () => {
    const blocked = blockedToolsForRole('member');
    expect(blocked.has('run_command')).toBe(true);
    expect(blocked.has('write_file')).toBe(true);
    expect(blocked.has('system_info')).toBe(true);
  });
  it('member still sees read_file and web_search (not blocked)', () => {
    const blocked = blockedToolsForRole('member');
    expect(blocked.has('read_file')).toBe(false);
    expect(blocked.has('web_search')).toBe(false);
  });
});
