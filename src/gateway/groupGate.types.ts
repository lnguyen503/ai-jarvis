/**
 * Type definitions + helper predicates for group-chat activation routing.
 *
 * Split out of groupGate.ts in v1.23.0 to keep the dispatch function under
 * the 400-LOC file gate. No behavior change — just module-level type +
 * predicate hosting.
 */

import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { BotIdentity } from '../config/botIdentity.js';
import type { ModelProvider } from '../providers/types.js';
import type { GroupSettingsRepo } from '../memory/groupSettings.js';
import type { RecentMessage } from './intent.js';
import type { DirectiveDetectionResult } from '../avengers/detectDirective.js';

// ---------------------------------------------------------------------------
// Helper predicates — used by groupGate.ts and other dispatch sites.
// ---------------------------------------------------------------------------

/** True when the context is a group or supergroup chat. */
export function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === 'group' || type === 'supergroup';
}

/** True when the message text contains "jarvis" (case-insensitive). */
export function isJarvisMentioned(ctx: Context): boolean {
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';
  return /jarvis/i.test(text);
}

/** True when the message is a direct reply to a message sent by the given bot user ID. */
export function isReplyToJarvis(ctx: Context, botUserId: number): boolean {
  return ctx.message?.reply_to_message?.from?.id === botUserId;
}

// ---------------------------------------------------------------------------
// Activation result types.
// ---------------------------------------------------------------------------

export type ActivationReason =
  | 'mention'
  | 'reply'
  | 'follow-up'
  | 'intent-high'
  | 'confirmed'
  | 'confirm-required'
  | 'directive'
  | 'silent';

/**
 * v1.23.0 — execution mode injected into agent.turn.
 *   work         — bot is the named target of a directive ("Tony — do X").
 *                  Loads empty session history; system prompt gets <your-task>
 *                  block + WORK overlay.
 *   banter       — bot was activated without a directive (collective alias,
 *                  casual @-mention). System prompt gets BANTER overlay
 *                  ("no active task; 1-2 lines or silence").
 *   orchestrator — Jarvis's default behavior unchanged (DM, classifier path,
 *                  /coach/etc). Existing prompt; full session history.
 */
export type ActivationMode = 'work' | 'banter' | 'orchestrator';

export interface GroupActivationResult {
  /** Whether Jarvis should handle this update immediately. */
  proceed: boolean;
  reason: ActivationReason;
  /**
   * When reason === 'confirmed', the stashed original text that we should
   * actually run through the agent (NOT the user's yes/no reply).
   */
  dispatchText?: string;
  /**
   * When reason === 'confirm-required', the prompt to post back to the chat.
   * Caller is also responsible for calling groupState.setPending() so the
   * next message from this user can answer it.
   */
  confirmPrompt?: string;
  /** Non-user-facing diagnostic note for logging. */
  note?: string;
  /**
   * v1.23.0 — execution mode for agent.turn. Always set when proceed===true.
   * Defaults to 'orchestrator' for Jarvis, 'banter' for specialists if no
   * directive matched.
   */
  mode?: ActivationMode;
  /**
   * v1.23.0 — task text extracted from the user's directive when this bot
   * was named. Set only when mode==='work'. Empty string when the directive
   * matched but the task slice was empty (defensive default).
   */
  directiveTask?: string;
  /**
   * v1.23.0 — full directive detection result. Set whenever the user wrote
   * any directive in the message, regardless of whether THIS bot was named.
   * Jarvis's gateway uses this to seed the plan auto-trigger when ≥2
   * specialists are directed in one message.
   */
  directive?: DirectiveDetectionResult;
}

export interface GroupGateDeps {
  config: AppConfig;
  botUserId: number;
  groupSettings: GroupSettingsRepo;
  /** Called to retrieve the recent message window for the classifier. */
  getRecentMessages: (chatId: number, n: number) => RecentMessage[];
  /** Provider to use for the classifier. Usually gateway passes OllamaCloud. */
  classifierProvider: ModelProvider;
  abortSignal: AbortSignal;
  /**
   * v1.21.0 D7 — multi-bot mention routing.
   * When provided (commit 12 wires it), the mention router decides whether
   * this bot is the addressed recipient BEFORE the "jarvis" keyword check.
   * When absent (legacy / back-compat path), falls through to the existing
   * keyword + intent classifier.
   */
  botIdentity?: BotIdentity;
  /** Telegram username of this bot WITHOUT '@' (from getMe at boot). Required
   *  when botIdentity is provided. */
  botUsername?: string;
}
