import type { z } from 'zod';
import type pino from 'pino';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { SafetyApi } from '../safety/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { BotIdentity } from '../config/botIdentity.js';

export interface ToolContext {
  /**
   * v1.21.0 ADR 021 D6 + CP1 F1 — bot identity for per-bot allowlist gating.
   * Optional for backward compat in tests that construct minimal contexts.
   * Boot path ALWAYS populates this via buildToolContextWithIdentity.
   */
  botIdentity?: BotIdentity;
  sessionId: number;
  chatId: number;
  /** Telegram user id of the speaker for this turn. Used by tools that
   *  need to scope by user across chats (e.g. update_memory writes to
   *  the per-user memory file regardless of which chat the user is in). */
  userId?: number;
  /** Display name for the speaker — used as the title of the user memory
   *  file on first creation, and to render "Memory for <name>" in /memory. */
  userName?: string;
  logger: pino.Logger;
  config: AppConfig;
  memory: MemoryApi;
  safety: SafetyApi;
  abortSignal: AbortSignal;
  /**
   * Messaging adapter — injected at turn time so tools can send files /
   * messages directly to the current chat. Platform-neutral (Telegram,
   * Slack, WhatsApp). Optional for backward compat in tests that don't
   * need file-send capability; send_file will return ok:false if absent.
   * Field name kept as `telegram` for one release to avoid breaking tool
   * implementations; renames in v1.9.
   */
  telegram?: MessagingAdapter;
  /**
   * V-01 fix: set of tool names that are active for THIS turn.
   * dispatch() rejects any name not in this set.
   * When undefined, dispatch falls back to the full registered set (DM-only path).
   */
  allowedToolNames?: ReadonlySet<string>;
  /**
   * v1.10.0 — scheduler API for tools that mutate the scheduled_tasks table
   * and need the scheduler to pick up changes immediately. Optional —
   * tests and legacy callers don't have to provide it.
   * Typed structurally to avoid a circular dep between tools ↔ scheduler.
   */
  schedulerApi?: { reload(): void };
  /**
   * v1.18.0 ADR 018 D3.a — per-coach-turn write counters.
   * Initialized by the agent at coach-turn entry; undefined on normal DM turns.
   * coach_log_* tools increment + enforce MAX_NUDGES_PER_TURN (5) and
   * MAX_MEMORY_WRITES_PER_TURN (10). coach_read_history is never counted.
   */
  coachTurnCounters?: { nudges: number; writes: number };
  /**
   * v1.22.41 — per-turn web_search call counter. Initialized to { count: 0 }
   * at turn entry (mutable wrapper so increments by the tool persist across
   * the agent loop). web_search.ts increments + enforces MAX_WEB_SEARCHES_PER_TURN
   * (5). Triggered by a real incident: a hard prompt drove 26 Tavily calls
   * from one specialist in two minutes before the LLM produced a draft.
   * Optional for back-compat with tests / non-agent contexts; web_search
   * skips the cap when undefined.
   */
  turnWebSearchCounter?: { count: number };
}

export interface ToolResult {
  ok: boolean;
  output: string; // user/claude-visible text, already truncated
  data?: Record<string, unknown>; // structured data for logs
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Tool interface. We use `z.ZodTypeAny` for parameters so each tool can
 * use a `z.object({...})` with defaults without forcing the caller
 * to pre-declare the inferred type. The `execute` input is typed via
 * `z.infer<typeof schema>` at the implementation site.
 */
export interface Tool<TInput = unknown> {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  destructive?: boolean; // force confirmation flow
  /**
   * v1.7.10 — if true, this tool is only exposed to admin sessions.
   * Developers and members never see it in the tool list, and dispatch()
   * rejects any call to it if the LLM hallucinates the name. Set by the
   * MCP registry when its source server has `adminOnly: true` in config.
   */
  adminOnly?: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolDeps {
  config: AppConfig;
  logger: pino.Logger;
  safety: SafetyApi;
  memory: MemoryApi;
  /**
   * v1.10.0 — scheduler API for tools that mutate the scheduled_tasks table
   * and need the scheduler to pick up changes immediately. Optional —
   * tests and legacy callers don't have to provide it.
   */
  schedulerApi?: { reload(): void };
}
