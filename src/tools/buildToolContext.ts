/**
 * buildToolContext — SSOT factory for ToolContext (v1.21.0 ADR 021 F1).
 *
 * Single source of truth for constructing ToolContext objects. Every
 * production code path MUST use this factory so that new required fields
 * (e.g. botIdentity, coachTurnCounters) are automatically populated and
 * never silently undefined when new code forgets to thread them through.
 *
 * F1 trap pre-emption (6th-iter pattern):
 *   In previous iterations, new ToolContext fields were added to the
 *   interface but the construction sites (agent/index.ts line 816 and 1038)
 *   were not updated. The F1 gate (Anti-Slop §F1: no silently-dropped
 *   required context) catches this post-hoc. This factory prevents the
 *   issue from occurring in the first place — construction is centralized,
 *   so a new field only needs to be threaded to ONE place.
 *
 * Static enforcement:
 *   tests/static/tools.buildToolContext.test.ts verifies that no NEW
 *   direct ToolContext object literals appear in src/ outside of this file
 *   and the two pre-existing construction sites in src/agent/index.ts
 *   (which are tracked and will be migrated in v1.22.0).
 *
 * Tests: tests/static/tools.buildToolContext.test.ts
 */

import type pino from 'pino';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { SafetyApi } from '../safety/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { BotIdentity } from '../config/botIdentity.js';
import type { ToolContext } from './types.js';

// ---------------------------------------------------------------------------
// BuildToolContextParams — all fields for a fully-populated ToolContext
// ---------------------------------------------------------------------------

/**
 * Params for building a ToolContext. Required fields must always be supplied.
 * Optional fields have safe defaults (undefined) and are documented inline.
 */
export interface BuildToolContextParams {
  /** v1.21.0 — resolved bot identity; MUST be set on the production boot path. */
  botIdentity?: BotIdentity;
  sessionId: number;
  chatId: number;
  userId?: number;
  userName?: string;
  logger: pino.Logger;
  config: AppConfig;
  memory: MemoryApi;
  safety: SafetyApi;
  abortSignal: AbortSignal;
  /** Messaging adapter — for file/message sends from tools. */
  telegram?: MessagingAdapter;
  /** Per-turn allowed tool names (V-01 gate). When absent, full set applies. */
  allowedToolNames?: ReadonlySet<string>;
  /** v1.10.0 scheduler API for immediate cron reload. */
  schedulerApi?: { reload(): void };
  /**
   * v1.18.0 — per-coach-turn write counters. Caller initializes to
   * { nudges: 0, writes: 0 } on coach turns; leave undefined on normal turns.
   */
  coachTurnCounters?: { nudges: number; writes: number };
  /** v1.22.41 — per-turn web_search call counter. See ToolContext.turnWebSearchCounter. */
  turnWebSearchCounter?: { count: number };
}

// ---------------------------------------------------------------------------
// buildToolContext — factory
// ---------------------------------------------------------------------------

/**
 * Construct a ToolContext from params. All fields are passed through verbatim;
 * the factory adds no defaults or mutations. Its sole purpose is to be the
 * SINGLE construction site for ToolContext objects in production code.
 *
 * @example
 * ```ts
 * const toolCtx = buildToolContext({
 *   botIdentity: identity,
 *   sessionId,
 *   chatId,
 *   logger: turnLog,
 *   config,
 *   memory,
 *   safety: turnSafety,
 *   abortSignal,
 *   telegram,
 *   userId: params.userId,
 *   userName: groupOptions?.senderName,
 *   allowedToolNames,
 *   schedulerApi,
 *   coachTurnCounters,
 * });
 * ```
 */
export function buildToolContext(params: BuildToolContextParams): ToolContext {
  return {
    botIdentity: params.botIdentity,
    sessionId: params.sessionId,
    chatId: params.chatId,
    userId: params.userId,
    userName: params.userName,
    logger: params.logger,
    config: params.config,
    memory: params.memory,
    safety: params.safety,
    abortSignal: params.abortSignal,
    telegram: params.telegram,
    allowedToolNames: params.allowedToolNames,
    schedulerApi: params.schedulerApi,
    coachTurnCounters: params.coachTurnCounters,
    turnWebSearchCounter: params.turnWebSearchCounter,
  };
}
