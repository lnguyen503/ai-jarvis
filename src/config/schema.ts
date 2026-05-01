import { z } from 'zod';
import { coachConfigSchema } from './coachSchema.js';

const BlockedCommandSchema = z.object({
  pattern: z.string().min(1),
  kind: z.enum(['regex', 'literal']),
  action: z.enum(['confirm', 'block']),
});

// ---------------------------------------------------------------------------
// v1.1 AI config — multi-provider, backward-compatible with v1.0 shape
// ---------------------------------------------------------------------------

const ProviderCredentialsSchema = z.object({
  apiKey: z.string().optional(), // ENV: resolved at load time; if absent, read from env var at runtime
  baseUrl: z.string().url().optional(),
  models: z.record(z.string()).optional(), // named model aliases for this provider
});

const RoutingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  fallbackToClaudeOnError: z.boolean().default(true),
  logRoutingDecisions: z.boolean().default(true),
});

/** v1.1 shape. Backward-compat shim for v1.0 (provider+model top-level) applied in loadConfig(). */
const AiConfigSchema = z.object({
  // v1.0 fields — kept optional for backward compat, migrated to defaultProvider/defaultModel at load
  provider: z.string().optional(),
  model: z.string().optional(),

  // v1.1 defaults
  defaultProvider: z.string().default('ollama-cloud'),
  defaultModel: z.string().default('glm-5.1'),
  premiumProvider: z.string().default('claude'),
  premiumModel: z.string().default('claude-sonnet-4-6'),

  // Judge/vision model — used for semantically heavy single-shot calls
  // (debate judge, image describe). Defaults to Opus because accuracy on
  // nuance matters more than speed for these. Separate from premiumModel
  // (which is the fallback/escalation target and can stay on Sonnet).
  judgeModel: z.string().default('claude-opus-4-6'),

  maxTokens: z.number().int().min(256).max(65536).default(4096),
  temperature: z.number().min(0).max(1).default(0.3),
  maxToolIterations: z.number().int().min(1).max(50).default(10),

  // v1.11.x — streaming chat replies (DM only). Plumbing is in place but
  // disabled by default because Telegram's edit rate limit + BPE tokenization
  // produce "chunks of a paragraph" rather than per-character typing feel —
  // which doesn't match the medium (Telegram is a message-based platform,
  // not a typing-based one). Leaving the code in place behind the flag so
  // the capability is available if a future surface (e.g. a Telegram Web App
  // that bypasses editMessageText) benefits. Flip to `true` in config.json
  // to re-enable without code changes.
  streamingEnabled: z.boolean().default(false),
  streamingEditIntervalMs: z.number().int().min(50).max(5000).default(150),
  /** Character appended to the live buffer during streaming; removed at finalize. */
  streamingCursor: z.string().default('▍'),

  providers: z
    .object({
      claude: ProviderCredentialsSchema.default({}),
      'ollama-cloud': ProviderCredentialsSchema.default({}),
    })
    .default({}),

  routing: RoutingConfigSchema.default({}),
});

// ---------------------------------------------------------------------------
// MCP config — context servers (e.g. context7)
// ---------------------------------------------------------------------------

const McpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  enabled: z.boolean().default(true),
  transport: z.enum(['http', 'sse']).default('http'),
  // v1.7.10 — if true, tools from this server are hidden from developers
  // and members; only admins (DMs + groups.adminUserIds) see them. Used for
  // personal accounts (Gmail, Calendar, private APIs) that shouldn't be
  // exposed to teammates in shared group chats.
  adminOnly: z.boolean().default(false),
});

const McpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  servers: z.array(McpServerSchema).default([]),
});

// ---------------------------------------------------------------------------
// Tavily web search config
// ---------------------------------------------------------------------------

const TavilyConfigSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().default(''), // resolved from ENV: refs at load time
  baseUrl: z.string().url().default('https://api.tavily.com'),
});

// ---------------------------------------------------------------------------
// Headless browser config (v1.7.14) — autonomous web research via Playwright.
// Fresh incognito context per call; no persistent cookies or login state by
// design. SSRF guard blocks private IPs + configured deny-host globs.
// ---------------------------------------------------------------------------

const BrowserConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Run Chromium headless (default). Set false only for local debugging. */
  headless: z.boolean().default(true),
  /** Max ms a single page load can take. Default 15s. */
  pageTimeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  /** Max characters of extracted text returned to the agent. Keeps token costs bounded. */
  maxContentChars: z.number().int().min(1000).max(500_000).default(100_000),
  /** Hostname globs that are always rejected even if the SSRF guard would pass them. */
  denyHosts: z.array(z.string()).default([]),
  /** UA string. Empty = Chromium default (looks like a normal Chrome user). */
  userAgent: z.string().default(''),
});

// ---------------------------------------------------------------------------
// Google APIs config (v1.7.11) — first-party Google integrations via OAuth.
// Replaces the abandoned plan to proxy claude.ai's hosted MCP connectors,
// which are gated by the user's claude.ai session and can't be reached by a
// third-party Node process. Tokens persist on disk; refresh is automatic.
// All Google tools are admin-only by construction (set on the Tool object).
// ---------------------------------------------------------------------------

const GoogleOAuthSchema = z.object({
  clientId: z.string().default(''),     // resolved from ENV: at load time
  clientSecret: z.string().default(''), // resolved from ENV: at load time
  // Where the refresh token lives. Defaults under data/ which is read-deny
  // for all tools (no leak via read_file). The auth CLI writes here.
  tokenPath: z.string().min(1).default('./data/google-tokens.json'),
});

const GoogleCalendarSchema = z.object({
  enabled: z.boolean().default(false),
  // Default calendar ID for list_events / future create_event when unspecified.
  // 'primary' is the user's main calendar.
  defaultCalendarId: z.string().min(1).default('primary'),
});

const GoogleGmailSendSchema = z.object({
  /** Master on/off. Default OFF — explicit opt-in required to enable outbound mail. */
  enabled: z.boolean().default(false),
  /** How long a confirmation token stays valid. Default 5 min. */
  confirmationTtlSeconds: z.number().int().min(30).max(3600).default(300),
  /** Max SENT emails per rolling hour. Hard cap — exceeding it rejects new drafts. */
  rateLimitPerHour: z.number().int().min(1).max(100).default(10),
  /** Max recipients (to+cc+bcc combined) per outgoing email. Defense against bulk-blast. */
  maxRecipientsPerSend: z.number().int().min(1).max(100).default(20),
  /**
   * When true, require reply-to-thread mode — the draft must link to an
   * existing inbox thread. Blocks "send a cold email to a new address"
   * flows entirely. Default false (off).
   */
  requireReplyToThread: z.boolean().default(false),
});

const GoogleGmailSchema = z.object({
  enabled: z.boolean().default(false),
  // Cap on messages returned by gmail_search in a single call. Gmail charges
  // one API call per message metadata fetch, so capping this protects quota.
  maxResults: z.number().int().min(1).max(50).default(10),
  /** Send settings (v1.7.15). See schema above. */
  send: GoogleGmailSendSchema.default({}),
});

const GoogleConfigSchema = z.object({
  enabled: z.boolean().default(false),
  oauth: GoogleOAuthSchema.default({}),
  calendar: GoogleCalendarSchema.default({}),
  gmail: GoogleGmailSchema.default({}),
});

// ---------------------------------------------------------------------------
// Groups config — group chat mode (v1.3)
// ---------------------------------------------------------------------------

export const GroupsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Numbers are specific Telegram chat IDs. The literal "*" is a wildcard
  // meaning "allow any group" — convenient but only use it if you fully trust
  // who can invite the bot.
  // Quoted numeric strings (e.g. "-1001234567890") are auto-coerced — Telegram IDs
  // are often pasted as strings from editors; we accept either form.
  allowedGroupIds: z
    .array(
      z.union([
        z.number().int(),
        z.literal('*'),
        z.string().regex(/^-?\d+$/).transform((s) => Number(s)),
      ]),
    )
    .default([]),
  adminUserIds: z
    .array(
      z.union([
        z.number().int().positive(),
        z.string().regex(/^\d+$/).transform((s) => Number(s)),
      ]),
    )
    .default([]),
  // DEPRECATED as of v1.7.6 — legacy global developer list. Kept for backward
  // compatibility: users here are developers in EVERY allowed group. Prefer
  // per-group roles via `groupRoles` below, which are customizable per chat.
  developerUserIds: z
    .array(
      z.union([
        z.number().int().positive(),
        z.string().regex(/^\d+$/).transform((s) => Number(s)),
      ]),
    )
    .default([]),
  // Per-group role maps (v1.7.6). Key is the Telegram chat ID (as string for
  // JSON compatibility — negative numbers like "-1001234567890"). Value has
  // optional `admins` and `developers` arrays.
  //
  // Resolution order (first match wins):
  //   1. User in `groups.adminUserIds` (global) -> admin everywhere.
  //   2. User in `groupRoles[chatId].admins` -> admin in THIS group only.
  //   3. User in `groupRoles[chatId].developers` -> developer in THIS group.
  //   4. User in `groups.developerUserIds` (legacy global) -> developer
  //      everywhere.
  //   5. Otherwise -> member.
  //
  // Example:
  //   "groupRoles": {
  //     "-1001234567890": { "admins": [111], "developers": [222, 333] },
  //     "-1002234567890": { "developers": [222] }
  //   }
  // — user 222 is a developer in both groups; user 111 is admin in the
  // first only.
  groupRoles: z
    .record(
      z.string(),
      z.object({
        admins: z
          .array(
            z.union([
              z.number().int().positive(),
              z.string().regex(/^\d+$/).transform((s) => Number(s)),
            ]),
          )
          .default([])
          .optional(),
        developers: z
          .array(
            z.union([
              z.number().int().positive(),
              z.string().regex(/^\d+$/).transform((s) => Number(s)),
            ]),
          )
          .default([])
          .optional(),
      }),
    )
    .default({}),
  rateLimitPerUser: z.number().int().min(1).max(1000).default(10),
  rateLimitWindowMinutes: z.number().int().min(1).max(10080).default(60),
  maxResponseLength: z.number().int().min(100).max(10000).default(2000),
  /**
   * v1.23.1 — additional names the LLM might use as a leading addressing
   * prefix (`Boss:`, `Boss:`, etc.) that should be stripped from group
   * replies. These are ON TOP OF the Telegram first_name + bot identifiers
   * already in the strip allowSet. Without this, the strip pass can't
   * recognize "Boss:" because the user's Telegram first_name might be
   * "YourFirstName" but the persona refers to him as "Boss". Closed set; case-
   * insensitive match against the captured prefix token.
   */
  userAddresseeAliases: z.array(z.string()).default(['Boss']),
  // v1.10.0: `schedule` added so group chats can't create DM-scope scheduled
  // tasks that would fire under a specific user's owner_user_id — group users
  // should use /schedule from their own DM to avoid cross-user task creation.
  disabledTools: z.array(z.string()).default(['run_command', 'write_file', 'system_info', 'schedule']),
  // v1.7.13 — intent detection for non-keyword group messages.
  //
  // Default behavior: if a group message doesn't contain "jarvis" and isn't a
  // reply to the bot, the follow-up heuristic and (if still not activated)
  // the LLM classifier decide whether Jarvis should respond. Medium-confidence
  // classifier results trigger a "were you asking me?" prompt in chat.
  //
  // Admins can disable per-chat via /jarvis_intent off. Disable globally by
  // setting enabled:false here.
  intentDetection: z
    .object({
      enabled: z.boolean().default(true),
      /** Provider to use for classification (defaults to ollama-cloud — cheap). */
      provider: z.string().default('ollama-cloud'),
      /** Model used for classification. Pick a cheap + fast one. */
      model: z.string().default('gemma4:31b'),
      /** Seconds after Jarvis last spoke during which a same-user message is a silent follow-up. */
      followUpWindowSeconds: z.number().int().min(0).max(3600).default(120),
      /** TTL on a "were you asking me?" pending confirmation. Short — intent decays fast. */
      confirmationTtlSeconds: z.number().int().min(10).max(600).default(120),
      /** Cap on classifier calls per chat per minute — prevents busy groups from burning quota. */
      rateLimitPerMinute: z.number().int().min(1).max(500).default(30),
      /** How many recent messages to include as context in the classifier prompt. */
      recentMessageContext: z.number().int().min(0).max(20).default(4),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// Context / auto-compaction config (v1.4)
// ---------------------------------------------------------------------------

const ContextConfigSchema = z.object({
  autoCompact: z.boolean().default(true),
  compactThreshold: z.number().min(0).max(1).default(0.75),
  summarizePrompt: z
    .string()
    .default(
      'Summarize this entire conversation into a concise context summary. ' +
        'Preserve all key decisions, code snippets, file paths, file names, tool outputs, ' +
        'action items, and unresolved tasks. Keep code blocks verbatim. ' +
        'This summary will replace the full history — do not omit anything load-bearing. ' +
        'Respond with ONLY the summary, no preamble.',
    ),
  notifyUser: z.boolean().default(true),
});

export type ContextConfig = z.infer<typeof ContextConfigSchema>;

export const ConfigSchema = z.object({
  telegram: z.object({
    allowedUserIds: z.array(z.number().int().positive()).min(1),
    botToken: z.string().min(10),
  }),
  ai: AiConfigSchema,
  whisper: z.object({
    model: z.string().default('whisper-1'),
    apiBaseUrl: z.string().url().default('https://api.openai.com/v1'),
  }),
  health: z.object({
    port: z.number().int().min(1024).max(65535).default(7878),
  }),
  chat: z.object({
    userQueueMax: z.number().int().min(1).max(100).default(5),
    schedulerQueueMax: z.number().int().min(1).max(200).default(20),
    maxQueueAgeMs: z.number().int().min(0).default(600000),
  }),
  safety: z.object({
    confirmationTtlMs: z.number().int().min(10000).default(300000),
    commandTimeoutMs: z.number().int().min(1000).max(3600000).default(120000),
    maxOutputLength: z.number().int().min(100).max(100000).default(4000),
    allowEncodedCommands: z.boolean().default(false),
    blockedCommands: z.array(BlockedCommandSchema).default([]),
  }),
  filesystem: z.object({
    allowedPaths: z.array(z.string().min(1)).min(1),
    readDenyGlobs: z.array(z.string()).default([]),
  }),
  // Per-chat isolated workspaces (v1.7.5). Each group or DM gets its own
  // subfolder under `root`; only sessions from that chat can read/write
  // inside it. Other chats' workspaces are invisible. Auto-created on
  // first use.
  workspaces: z
    .object({
      enabled: z.boolean().default(true),
      root: z.string().min(1).default('D:\\ai-jarvis\\workspaces'),
    })
    .default({}),
  web: z.object({
    enabled: z.boolean().default(false),
    allowedHosts: z.array(z.string()).default([]),
  }),
  memory: z.object({
    dbPath: z.string().min(1).default('./data/jarvis.db'),
    maxHistoryMessages: z.number().int().min(1).max(500).default(50),
  }),
  mcp: McpConfigSchema.default({}),
  tavily: TavilyConfigSchema.default({}),
  browser: BrowserConfigSchema.default({}),
  google: GoogleConfigSchema.default({}),
  groups: GroupsConfigSchema.default({}),
  context: ContextConfigSchema.default({}),
  // v1.7.7 — named aliases for Telegram user IDs. Lets admins reference
  // users by a human-friendly name in role commands:
  //   /jarvis_dev_add kim          -> resolves "kim" -> userId from aliases
  // Names are case-insensitive, unique. Set via /jarvis_alias <name> <userId>.
  aliases: z.record(z.string().min(1), z.number().int().positive()).default({}),
  organize: z
    .object({
      reminders: z
        .object({
          enabled: z.boolean().default(true),
          cronExpression: z.string().default('0 8-20/2 * * *'),
          minActiveItemsForOptIn: z.number().int().min(1).max(100).default(3),
          dailyCap: z.number().int().min(1).max(20).default(3),
          itemCooldownMinutes: z.number().int().min(60).max(43_200).default(4320),
          muteAfterConsecutiveIgnores: z.number().int().min(1).max(20).default(3),
          quietHoursLocal: z.array(z.number().int().min(0).max(23)).default([22, 23, 0, 1, 2, 3, 4, 5, 6, 7]),
          maxItemsPerTriage: z.number().int().min(1).max(200).default(50),
          triageProvider: z.string().default('ollama-cloud'),
          triageModel: z.string().default('deepseek-v4-flash'),
          fallbackProvider: z.string().default('claude'),
          fallbackModel: z.string().default('claude-haiku-4-5'),
          // 120s matches OllamaCloudProvider's own DEFAULT_TIMEOUT_MS so cold-starts
          // (routinely 60s+) don't abort before the provider's retry budget can run.
          triageTimeoutMs: z.number().int().min(5_000).max(120_000).default(120_000),
          haikuFallbackMaxPerDay: z.number().int().min(1).max(1000).default(20),
          // v1.10.0: global outer-cap for Haiku fallbacks across all users per day.
          // Sized at 500 (25× the default per-user cap of 20) to absorb a noisy
          // day across the expected user population without being an independent
          // per-user scaling bottleneck.
          globalHaikuFallbackMaxPerDay: z.number().int().min(1).max(10_000).default(500),
          // v1.10.0: bounded concurrency for tickAllUsers sliding-window pool.
          // Default 5; clamp [1, 20]. See ADR 005 decision 4.
          tickConcurrency: z.number().int().min(1).max(20).default(5),
          // v1.9.1: fraction of the cron interval at which we emit a warn log.
          // 0.75 = warn when a full tick pass uses more than 75% of the cadence
          // window (defaulting to 90 min of a 2h window). Non-standard cron
          // expressions that `inferCronIntervalMs` cannot parse disable the warn.
          wallTimeWarnRatio: z.number().min(0.1).max(1).default(0.75),
        })
        .default({}),
      // v1.11.0 — .trash/ TTL eviction. The sibling trashEvictor module runs a
      // 4am cron that hard-deletes items older than trashTtlDays. Default 4am
      // avoids the reminder-tick hours (8–22) per the reminder cron window.
      trashTtlDays: z.number().int().min(1).max(365).default(30),
      // v1.11.0 — cron expression for the trash evictor. Server-local time.
      // Override only if you need a different quiet window.
      trashEvictCron: z.string().default('0 4 * * *'),
      // v1.11.0 R7 — emit a log.warn when one evictor tick exceeds this duration.
      // Default 10 minutes (600000ms). Range [60000, 3600000].
      trashEvictWallTimeWarnMs: z.number().int().min(60_000).max(3_600_000).default(600_000),
      // v1.11.0 R13 — when true, emit an audit row per user even when evicted=0 and errors=0.
      // Default false (single-deployment default); flip to true for compliance-forward deployments.
      trashEvictAuditZeroBatches: z.boolean().default(false),
      // v1.11.0 R8 — /organize reconcile hot-emitter warn threshold.
      // If 30-day inconsistency count >= this value, warn in the reconcile output.
      reconcileHotEmitterThreshold: z.number().int().min(10).max(10_000).default(100),
    })
    .default({}),
  projects: z
    .array(
      z.object({
        name: z.string().min(1),
        path: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * v1.18.0 ADR 018 D11 + revisions D11.a — Coach Jarvis configuration.
   * See src/config/coachSchema.ts for the full schema.
   *
   * KNOWN_ISSUES.md v1.18.0 invariant 2 cross-reference:
   *   "Coach allowlist enforced by code, not prompt." The disabledTools default
   *   contains 8 irreversible-mutation tool names. The dispatcher rejects any
   *   call to these tools with UNAUTHORIZED_IN_CONTEXT when ctx.coachTurnCounters
   *   is defined (i.e., inside a coach scheduled fire).
   */
  coach: coachConfigSchema,
  // v1.12.0 — panel registry sizing for the ProgressPanel primitive.
  // panelStateCacheMax: maximum concurrent panels in the in-memory LRU map.
  // panelStateTtlHours: how long a panel entry lives before TTL eviction.
  // For multi-user deployments: raise cacheMax to max(100, 5 × expectedActiveUsers).
  debate: z
    .object({
      panelStateCacheMax: z.number().int().min(10).max(10000).default(50),
      panelStateTtlHours: z.number().int().min(1).max(168).default(24),
    })
    .default({}),
  // v1.13.0 — Telegram Web App hosting (ADR 008 + R7)
  webapp: z
    .object({
      /** Public HTTPS URL that cloudflared (or other tunnel) exposes. Empty = webapp disabled. */
      publicUrl: z.string().default(''),
      /**
       * Relative path resolved from project root (R10), or absolute path.
       * Contains the built static assets served at /webapp/*.
       */
      staticDir: z.string().default('public/webapp'),
      /** Port for the loopback Express server. cloudflared proxies to this. */
      port: z.number().int().min(1024).max(65535).default(7879),
      /** Max age of Telegram initData before it is considered stale. */
      initDataMaxAgeSeconds: z.number().int().min(60).max(86400 * 7).default(86400),
      /**
       * Reject initData when its auth_date is more than this far in the future,
       * defending against forged-timestamp replay. Default 300s matches OAuth/JWT;
       * tighten only on hosts with reliable NTP. Wider tolerates clock skew.
       * Set to 0 to disable the check entirely.
       */
      initDataMaxFutureSkewSeconds: z.number().int().min(0).max(3600).default(300),
      /** Replay window for /api/webapp/items* routes. Tighter than the global
       *  initDataMaxAgeSeconds (default 24h) because items endpoints expose
       *  user-authored task titles — more sensitive than echo's userId-only
       *  response. Default 3600s (1h). */
      itemsInitDataMaxAgeSeconds: z.number().int().min(60).max(86400).default(3600),
    })
    .default({}),
});

export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type TavilyConfig = z.infer<typeof TavilyConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type GoogleConfig = z.infer<typeof GoogleConfigSchema>;
export type GoogleOAuthConfig = z.infer<typeof GoogleOAuthSchema>;
export type GoogleCalendarConfig = z.infer<typeof GoogleCalendarSchema>;
export type GoogleGmailConfig = z.infer<typeof GoogleGmailSchema>;
export type GoogleGmailSendConfig = z.infer<typeof GoogleGmailSendSchema>;
export type GroupsConfig = z.infer<typeof GroupsConfigSchema>;

export type AppConfig = z.infer<typeof ConfigSchema>;
export type BlockedCommand = z.infer<typeof BlockedCommandSchema>;
export type { CoachConfig } from './coachSchema.js';

/**
 * The built-in readDenyGlobs that can NEVER be removed by user config.
 * V-06 fix: extended to cover .env variants like *.env, .env-backup, .env.*.local, env.local.
 */
export const BUILT_IN_READ_DENY_GLOBS = [
  '.env',
  '.env.*',
  '*.env',           // V-06: config.env, production.env
  '**/.env*',        // V-06: any .env* under any subdir
  '**/*.env',        // V-06: any *.env file anywhere
  '.env-backup',     // V-06: no dot after env
  '*.env-backup',
  '.env.*.local',
  'env.local',
  '**/id_rsa',
  '**/id_rsa.pub',
  '**/*.pem',
  '**/*.key',
  '**/credentials*.json',
  '**/service-account*.json',
  '**/.aws/**',
  '**/.ssh/**',
  'logs/**',
  'data/**',
];
