/**
 * BotIdentity — closed-set multi-bot abstraction (v1.21.0 ADR 021 D1 + D2 + D6;
 * v1.21.1 expanded to 4-bot Avengers ensemble + healthPort threading).
 *
 * Pattern mirrors v1.20.0 profileTypes.ts (coach closed set) and v1.18.0
 * intensityTypes.ts. Each bot is a separate pm2 process with its own:
 *   - Telegram token (BOT_TOKEN_<NAME>)
 *   - Persona prompt (config/personas/<name>.md)
 *   - Data directory (data/<name>/)
 *   - Tool allowlist (scope: 'full' | 'specialist')
 *   - Webapp port AND health endpoint port
 *
 * Adding a 5th bot in v1.22.0+ is config-only:
 *   1. Append name to BOT_NAMES.
 *   2. Add entries to BOT_MARKER_BY_NAME, BOT_WEBAPP_PORT, BOT_HEALTH_PORT, BOT_SCOPE.
 *   3. Drop config/personas/<name>.md.
 *   4. Add BOT_TOKEN_<NAME> to .env.example.
 *   5. Add a process block to ecosystem.config.cjs.
 *
 * BINDING (CP1 R6): run_command is NOT in SPECIALIST_TOOL_ALLOWLIST.
 * Shell access for specialist bots is deferred to v1.22.0+ (sandboxed shell).
 * COMMENT MARKER: REMOVED per CP1 R6
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// Closed set — v1.21.1 ships exactly four bots (Avengers ensemble).
// Static test tests/static/bot-name-closed-set.test.ts asserts length === 4.
// ---------------------------------------------------------------------------

export const BOT_NAMES = ['ai-jarvis', 'ai-tony', 'ai-natasha', 'ai-bruce'] as const;
export type BotName = typeof BOT_NAMES[number];

export type BotScope = 'full' | 'specialist';

export function isBotName(v: unknown): v is BotName {
  return BOT_NAMES.includes(v as BotName);
}

// ---------------------------------------------------------------------------
// BotIdentity shape — resolved at boot from env + config.
// ---------------------------------------------------------------------------

export interface BotIdentity {
  /** Human-readable bot name from the closed set. */
  name: BotName;
  /** Scope governs the tool allowlist and activation behavior. */
  scope: BotScope;
  /** Telegram bot token (resolved from BOT_TOKEN_<NAME> env var at boot). */
  telegramToken: string;
  /** Absolute path to the persona system prompt markdown file. */
  personaPath: string;
  /** Absolute path to the per-bot data directory (data/<name>/). */
  dataDir: string;
  /** Webapp port for this bot's tunnel. */
  webappPort: number;
  /** Health endpoint port (loopback-only liveness probe). */
  healthPort: number;
  /** Set of allowed tool names (derived from scope). */
  allowedTools: ReadonlySet<string>;
  /**
   * Natural-language aliases the user can type instead of @<username>.
   * Word-boundary, case-insensitive matching. v1.21.3.
   */
  aliases: readonly string[];
  /**
   * Project-relative paths this bot may READ in addition to its own dataDir
   * (v1.21.13). Specialists get read-only access to src/, config/, docs/
   * etc. so they can do code review / research without being able to touch
   * user data in other bots' data directories. The full-scope ai-jarvis
   * gets [] (already has unconditional access).
   *
   * NOTE: the path-sandbox is allowed/denied; it doesn't enforce read-only
   * at the OS level. The persona instructs specialists not to write to
   * project source, and the safety layer's confirmation flow gates each
   * write_file call separately.
   */
  additionalReadPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// Per-bot configuration maps.
// ---------------------------------------------------------------------------

/** Maps a BotName to the env var that holds its Telegram token. */
export const BOT_MARKER_BY_NAME: Record<BotName, string> = {
  'ai-jarvis':  'BOT_TOKEN_AI_JARVIS',
  'ai-tony':    'BOT_TOKEN_AI_TONY',
  'ai-natasha': 'BOT_TOKEN_AI_NATASHA',
  'ai-bruce':   'BOT_TOKEN_AI_BRUCE',
} as const;

/**
 * Per-bot webapp port. Offset of +10 between bots; existing ai-jarvis port
 * 7879 is preserved. Health port is webappPort - 1 (also +10 offset).
 */
const BOT_WEBAPP_PORT: Record<BotName, number> = {
  'ai-jarvis':  7879,
  'ai-tony':    7889,
  'ai-natasha': 7899,
  'ai-bruce':   7909,
} as const;

/** Per-bot health endpoint port (loopback-only). Offset matches webapp -1. */
const BOT_HEALTH_PORT: Record<BotName, number> = {
  'ai-jarvis':  7878,
  'ai-tony':    7888,
  'ai-natasha': 7898,
  'ai-bruce':   7908,
} as const;

const BOT_SCOPE: Record<BotName, BotScope> = {
  'ai-jarvis':  'full',
  'ai-tony':    'specialist',
  'ai-natasha': 'specialist',
  'ai-bruce':   'specialist',
} as const;

/**
 * Project-relative READ paths granted to specialist-scope bots in addition
 * to their per-bot data directory (v1.21.13). Closed set — adding a path
 * requires an ADR entry. Used by wrapPathForBotIdentity to expand the
 * allowedPaths list.
 *
 * INCLUDES (project source for code review / research):
 *   - src/, config/, docs/, tests/, qa/, scripts/
 *   - top-level files: package.json, tsconfig.json, README.md, CHANGELOG.md,
 *     PROGRESS.md, LICENSE
 *
 * EXCLUDES:
 *   - data/  (each bot only sees its own data/<name>/ via dataDir)
 *   - .env, .env.* (always blocked by readDenyGlobs)
 *   - node_modules, dist (build artifacts)
 */
export const SPECIALIST_ADDITIONAL_READ_PATHS: readonly string[] = [
  'src',
  'config',
  'docs',
  'tests',
  'qa',
  'scripts',
  'package.json',
  'tsconfig.json',
  'README.md',
  'CHANGELOG.md',
  'PROGRESS.md',
  'LICENSE',
] as const;

/**
 * Per-bot Telegram @-username (v1.21.7). Used by the mention router to
 * detect cross-bot @-mentions in a user's message and decide which bot
 * gets to speak first. Empty string means "not deployed yet" — those bots
 * are skipped during earliest-bot resolution. Operators must update this
 * when a new bot's BotFather username is finalized.
 */
export const BOT_TELEGRAM_USERNAMES: Record<BotName, string> = {
  'ai-jarvis':  'your_jarvis_bot',
  'ai-tony':    'your_tony_bot',
  'ai-natasha': 'your_natasha_bot', // v1.22.15
  'ai-bruce':   'your_bruce_bot',     // v1.22.15
} as const;

/**
 * Per-bot domain description for the orchestrator's roster (v1.22.0).
 * Used to render `{{AVAILABLE_SPECIALISTS}}` in Jarvis's persona prompt
 * so the orchestrator knows which specialist to route each kind of work
 * to. The orchestrator (full scope) has empty domain — it routes, it
 * doesn't have a specialist scope.
 *
 * Adding a new specialist: append to BOT_NAMES + populate this map +
 * provide a Telegram username in BOT_TELEGRAM_USERNAMES. The roster
 * automatically picks up the new bot at next boot.
 */
/**
 * v1.23.2 — per-bot model diversity re-enabled. Each specialist runs on a
 * different model family that fits its domain; the orchestrator stays on
 * minimax-m2.7 because delegation is the load-bearing piece (don't break
 * the lynchpin). Picks chosen after a tool-calling probe of available
 * Ollama Cloud models on 2026-04-29:
 *
 *   Model             Latency  Tool  Notes
 *   ----------------  -------  ----  -----
 *   minimax-m2.7       2.4s     YES   baseline; verified working since v1.22.24
 *   qwen3-coder-next   1.1s     YES   code-focused, fastest of probed
 *   devstral-small-2   0.9s     YES   small fast fallback
 *   deepseek-v4-flash  1.3s     YES   flash variant = speed-tuned
 *   gpt-oss:120b       1.4s     YES   solid mid-tier reasoning
 *   nemotron-3-super   4.0s     YES   too slow for live chat
 *   qwen3-next:80b     1.7s     NO    silently fails tool calls — REJECTED
 *
 * History:
 *   - v1.22.35 went too big (480B+) → timeouts → Claude fallbacks
 *   - v1.22.36 went too small (≤31B) → echoed persona text verbatim
 *   - v1.22.37 reverted to uniform minimax-m2.7 (240B class, works)
 *   - v1.23.2 re-diversifies — all picks 80B-230B class with tool-calls
 *     verified <1.5s. None of the failure-mode classes from v1.22.35/36
 *     reached production this time because the probe gates them out.
 */
export const BOT_MODEL_BY_NAME: Record<BotName, string> = {
  'ai-jarvis':  'minimax-m2.7',     // orchestrator — verified delegation reliability
  'ai-tony':    'qwen3-coder-next', // engineering — code-focused training
  'ai-natasha': 'deepseek-v4-flash', // research — speed-tuned for SERP summarization
  'ai-bruce':   'gpt-oss:120b',     // analysis — solid mid-tier reasoning
} as const;

export const BOT_DOMAINS: Record<BotName, string> = {
  'ai-jarvis':  '',
  'ai-tony':    'engineering — code review, file inspection, build/debug, system info',
  'ai-natasha': 'research — web search, fact-checking, source synthesis, intel gathering',
  'ai-bruce':   'analysis — calculations, structured reasoning, comparisons, plain-English explanations',
} as const;

/**
 * Per-bot natural-language aliases (v1.21.3). When typing a bot's
 * @-username is annoying, users can address the bot by an alias instead.
 * Matched as whole words (\b...\b), case-insensitive, in group chats AFTER
 * the @-mention check fails. DMs always process regardless of alias.
 *
 * v1.22.0: aliases ONLY fire for full-scope bots (orchestrator). Specialists
 * require explicit @-mention. This makes Jarvis the unambiguous human-entry
 * point and eliminates earliest-bot turn-taking edge cases.
 *
 * Order matters for documentation only — the matcher checks all aliases.
 * Aliases must NOT overlap across bots (e.g., 'banner' is unique to bruce).
 *
 * Adding an alias: append here + add a test case in
 * tests/unit/gateway.mentionRouter.alias.test.ts.
 */
export const BOT_ALIASES_BY_NAME: Record<BotName, readonly string[]> = {
  'ai-jarvis':  ['jarvis'],
  'ai-tony':    ['tony', 'stark', 'mr stark', 'mr. stark', 'tony stark'],
  'ai-natasha': ['natasha', 'romanoff', 'widow', 'black widow'],
  'ai-bruce':   ['bruce', 'banner', 'hulk', 'dr banner', 'dr. banner'],
} as const;

/**
 * v1.22.18 — collective aliases that activate EVERY bot in the ensemble
 * regardless of scope. Used when the user addresses the whole team rather
 * than any single bot. The mention router checks these BEFORE per-bot
 * aliases and BEFORE the v1.22.17 orchestrator-priority deferral rule, so
 * a collective alias fires Jarvis AND every specialist. Each bot's persona
 * governs whether to actually chime in (scope-relevance check) or stay
 * silent — better one good answer than four redundant ones.
 *
 * Whole-word match, case-insensitive (same matcher as per-bot aliases).
 * Multi-word entries match flexible whitespace ("all of you", "all  of  you").
 */
export const COLLECTIVE_ALIASES: readonly string[] = [
  'avengers',
  'team',
  'everyone',
  'all of you',
  'you guys',
  'guys',
] as const;

// ---------------------------------------------------------------------------
// Tool allowlists (ADR 021 D6 + CP1 R6 BINDING).
//
// SPECIALIST_TOOL_ALLOWLIST — 9 tools (size 10 → 9 per CP1 R6).
// Static test asserts size === 9 AND 'run_command' is NOT present
// AND the comment marker 'REMOVED per CP1 R6' appears in source.
// ---------------------------------------------------------------------------

/**
 * Specialist tool allowlist for ai-tony, ai-natasha, ai-bruce (and any
 * future specialist-scope bot).
 *
 * Closed set — size === 9. Adding a tool requires an ADR entry.
 * run_command is intentionally EXCLUDED per CP1 R6:
 *   Shell commands bypass the D4 path-sandbox narrowing (data/<botName>/ only
 *   gates file tools; shell can do arbitrary fs access). Defer to v1.22.0+.
 * // REMOVED per CP1 R6: 'run_command'
 */
export const SPECIALIST_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'list_directory',
  'search_files',
  'system_info',
  // 'run_command', // REMOVED per CP1 R6 — bypasses D4 path-sandbox; defer to v1.22.0+ as a sandboxed feature
  'recall_archive',
  'web_search',
  'browse_url',
  'send_file',
]);

// ---------------------------------------------------------------------------
// Path helpers — SSOT for persona and data directory paths.
// ---------------------------------------------------------------------------

/** Resolve the persona prompt path for a given bot name. */
export function personaPathFor(name: BotName): string {
  return path.resolve(process.cwd(), 'config', 'personas', `${name}.md`);
}

/** Resolve the per-bot data directory. */
export function dataDirFor(name: BotName): string {
  return path.resolve(process.cwd(), 'data', name);
}

/** Resolve the webapp port for a given bot name. */
export function webappPortFor(name: BotName): number {
  return BOT_WEBAPP_PORT[name];
}

/** Resolve the health endpoint port for a given bot name. */
export function healthPortFor(name: BotName): number {
  return BOT_HEALTH_PORT[name];
}

/** Resolve the natural-language aliases for a given bot name (v1.21.3). */
export function aliasesFor(name: BotName): readonly string[] {
  return BOT_ALIASES_BY_NAME[name];
}

// ---------------------------------------------------------------------------
// resolveBotIdentity — reads env, validates closed set, loads token.
// ---------------------------------------------------------------------------

export type ResolveBotIdentityResult =
  | { ok: true; identity: BotIdentity }
  | { ok: false; error: string };

/**
 * Resolve the BotIdentity for this process from environment variables.
 *
 * @param envBotName  Value of process.env['BOT_NAME'] (may be undefined).
 * @param env         Environment object (defaults to process.env at call site;
 *                    injectable for testing).
 *
 * Rules:
 *   - BOT_NAME defaults to 'ai-jarvis' if not set.
 *   - BOT_NAME must be a member of BOT_NAMES (closed set).
 *   - The token env var (BOT_TOKEN_<NAME>) must be non-empty.
 */
export function resolveBotIdentity(
  envBotName: string | undefined,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ResolveBotIdentityResult {
  const rawName = envBotName ?? 'ai-jarvis';

  if (!isBotName(rawName)) {
    return {
      ok: false,
      error: `BOT_NAME="${rawName}" is not in the BOT_NAMES closed set (${BOT_NAMES.join(', ')}). ` +
             `Check your .env or ecosystem.config.cjs.`,
    };
  }

  const name: BotName = rawName;
  const tokenEnvVar = BOT_MARKER_BY_NAME[name];
  const telegramToken = env[tokenEnvVar];

  if (!telegramToken || telegramToken.trim() === '') {
    return {
      ok: false,
      error: `${tokenEnvVar} is not set or empty. Set the Telegram bot token for ${name} in your .env.`,
    };
  }

  const scope = BOT_SCOPE[name];
  const allowedTools: ReadonlySet<string> =
    scope === 'specialist' ? SPECIALIST_TOOL_ALLOWLIST : new Set<string>(); // empty = no filter = full scope

  const additionalReadPaths =
    scope === 'specialist' ? SPECIALIST_ADDITIONAL_READ_PATHS : [];

  const identity: BotIdentity = {
    name,
    scope,
    telegramToken: telegramToken.trim(),
    personaPath: personaPathFor(name),
    dataDir: dataDirFor(name),
    webappPort: webappPortFor(name),
    healthPort: healthPortFor(name),
    allowedTools,
    aliases: aliasesFor(name),
    additionalReadPaths,
  };

  return { ok: true, identity };
}
