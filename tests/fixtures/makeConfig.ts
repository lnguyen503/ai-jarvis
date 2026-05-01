import type { AppConfig } from '../../src/config/schema.js';
import { BUILT_IN_READ_DENY_GLOBS } from '../../src/config/schema.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Build an AppConfig object for tests.
 * Uses a fresh tmp dir as the allowed root so tests can create real files there.
 */
export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
  const realTmp = fs.realpathSync.native(tmpRoot);

  const base: AppConfig = {
    telegram: {
      allowedUserIds: [12345],
      botToken: 'test-bot-token',
    },
    ai: {
      // v1.0 compat fields (optional in schema)
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      // v1.1 fields
      defaultProvider: 'claude',
      defaultModel: 'claude-sonnet-4-6',
      premiumProvider: 'claude',
      premiumModel: 'claude-sonnet-4-6',
      maxTokens: 4096,
      temperature: 0.3,
      maxToolIterations: 10,
      providers: {
        claude: {},
        'ollama-cloud': {},
      },
      routing: {
        enabled: false, // disabled in tests — use defaultProvider directly
        fallbackToClaudeOnError: false, // no fallback in tests — keeps mock clean
        logRoutingDecisions: false,
      },
    },
    whisper: {
      model: 'whisper-1',
      apiBaseUrl: 'https://api.openai.com/v1',
    },
    health: { port: 7878 },
    chat: {
      userQueueMax: 5,
      schedulerQueueMax: 20,
      maxQueueAgeMs: 600000,
    },
    safety: {
      confirmationTtlMs: 300000,
      commandTimeoutMs: 120000,
      maxOutputLength: 4000,
      allowEncodedCommands: false,
      blockedCommands: [
        { pattern: 'Remove-Item\\s+.*-Recurse', kind: 'regex', action: 'confirm' },
        { pattern: 'format\\s+[A-Za-z]:', kind: 'regex', action: 'block' },
      ],
    },
    filesystem: {
      allowedPaths: [realTmp],
      readDenyGlobs: [...BUILT_IN_READ_DENY_GLOBS],
    },
    web: {
      enabled: false,
      allowedHosts: [],
    },
    memory: {
      dbPath: path.join(realTmp, 'test.db'),
      maxHistoryMessages: 50,
    },
    groups: {
      enabled: false,
      allowedGroupIds: [],
      adminUserIds: [],
      developerUserIds: [],
      groupRoles: {},
      rateLimitPerUser: 10,
      rateLimitWindowMinutes: 60,
      maxResponseLength: 2000,
      disabledTools: ['run_command', 'write_file', 'system_info'],
      intentDetection: {
        enabled: false, // disabled in tests by default — tests that need it set explicitly
        provider: 'ollama-cloud',
        model: 'gemma4:cloud',
        followUpWindowSeconds: 120,
        confirmationTtlSeconds: 120,
        rateLimitPerMinute: 30,
        recentMessageContext: 4,
      },
    },
    workspaces: {
      enabled: false, // disabled in tests by default — tests that need it set explicitly
      root: path.join(realTmp, 'workspaces'),
    },
    context: {
      autoCompact: false, // disabled in tests to avoid unintended compaction calls
      compactThreshold: 0.75,
      summarizePrompt:
        'Summarize this entire conversation into a concise context summary. ' +
        'Preserve all key decisions, code snippets, file paths, file names, tool outputs, ' +
        'action items, and unresolved tasks. Keep code blocks verbatim. ' +
        'This summary will replace the full history — do not omit anything load-bearing. ' +
        'Respond with ONLY the summary, no preamble.',
      notifyUser: true,
    },
    aliases: {},
    google: {
      enabled: false,
      oauth: { clientId: '', clientSecret: '', tokenPath: path.join(realTmp, 'google-tokens.json') },
      calendar: { enabled: false, defaultCalendarId: 'primary' },
      gmail: {
        enabled: false,
        maxResults: 10,
        send: {
          enabled: false,
          confirmationTtlSeconds: 300,
          rateLimitPerHour: 10,
          maxRecipientsPerSend: 20,
          requireReplyToThread: false,
        },
      },
    },
    browser: {
      enabled: false,
      headless: true,
      pageTimeoutMs: 15000,
      maxContentChars: 100000,
      denyHosts: [],
      userAgent: '',
    },
    projects: [],
    debate: {
      panelStateCacheMax: 50,
      panelStateTtlHours: 24,
    },
    webapp: {
      publicUrl: '',
      staticDir: 'public/webapp',
      port: 7879,
      initDataMaxAgeSeconds: 86400,
      initDataMaxFutureSkewSeconds: 300,
      itemsInitDataMaxAgeSeconds: 3600,
    },
  };

  return { ...base, ...overrides } as AppConfig;
}

/** Clean up a tmp allowed-root directory */
export function cleanupTmpRoot(cfg: AppConfig): void {
  for (const p of cfg.filesystem.allowedPaths) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
