/**
 * Claude agent: drives the ReAct tool-use loop, persists turns to SQLite,
 * and surfaces an AgentApi to the gateway.
 *
 * v1.1: Uses provider abstraction + model router. Claude is the silent fallback.
 */

import type pino from 'pino';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { SafetyApi } from '../safety/index.js';
import { sessionSafety } from '../safety/index.js';
import { resolveRole, blockedToolsForRole } from '../safety/roles.js';
import { effectiveAllowedPaths } from '../safety/workspaces.js';
import { isCalendarEnabledForChat } from '../google/calendar.js';
import type { Tool } from '../tools/types.js';
import type { MessagingAdapter } from '../messaging/adapter.js'; // used in TurnParams
import { dispatch, toClaudeToolDefs, toolsForContext } from '../tools/index.js';
import { buildMessages } from './contextBuilder.js';
import { buildSystemPrompt } from './systemPrompt.js';
import {
  buildWorkOverlay,
  buildBanterOverlay,
  type ActivationMode,
} from './modeOverlays.js';
import { wrapBotMessage } from '../gateway/interBotContext.js';
import { buildToolContext } from '../tools/buildToolContext.js';
import {
  type BotIdentity,
  BOT_NAMES,
  BOT_TELEGRAM_USERNAMES,
  BOT_ALIASES_BY_NAME,
  SPECIALIST_TOOL_ALLOWLIST,
} from '../config/botIdentity.js';
import { normalizePeerBotMentions } from './peerMentionNormalizer.js';
import path from 'node:path';
import { readUserMemory } from '../memory/userMemory.js';
import { isMemoryDisabledForUser } from '../commands/memory.js';
import { isOrganizeDisabledForUser } from '../commands/organize.js';
import { buildActiveItemsBlock } from '../organize/injection.js';
import { buildCoachActiveItemsBlock } from '../coach/coachPromptInjection.js';
import { recordUserMessage } from '../coach/rateLimits.js';
import { scrubForGroup } from '../safety/groupScrub.js';
import { routeTask } from '../router/model-router.js';
import { stripThinkTags } from '../providers/adapters.js';
import type { ModelProvider, UnifiedToolCall } from '../providers/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { child } from '../logger/index.js';
import { shouldCompact, compactSession } from './compaction.js';

const log = child({ component: 'agent' });

export interface AgentDeps {
  config: AppConfig;
  logger: pino.Logger;
  memory: MemoryApi;
  tools: Tool[];
  safety: SafetyApi;
  /** v1.9.0 — hoisted from initAgent body; constructed once in main() */
  claudeProvider: ModelProvider;
  /** v1.9.0 — hoisted from initAgent body; constructed once in main() */
  ollamaProvider: ModelProvider;
  /**
   * v1.10.0 — scheduler API (structural type to avoid a circular import on
   * `src/scheduler/index.ts`'s SchedulerApi). Used by the `schedule` tool so
   * creating a new task reloads the cron registry immediately instead of
   * waiting for the next natural reload.
   */
  schedulerApi?: { reload(): void };
  /**
   * v1.21.0 ADR 021 D6 + Scalability CRITICAL-1.21.0.D — bot identity for
   * per-bot tool allowlist gating. Threaded into ToolContext at agent.turn
   * via buildToolContext so `dispatch()` can enforce
   * `ctx.botIdentity?.allowedTools.has(name)` at the dispatcher layer.
   * Optional for backward compat with tests that don't construct a bot.
   */
  botIdentity?: BotIdentity;
}

export interface GroupTurnOptions {
  /** Whether this turn is in a group chat context */
  groupMode: boolean;
  /** The group chat ID (for token accumulation) */
  groupChatId?: number;
  /** Sender's first name for prefixing replies */
  senderName?: string;
}

export interface TurnParams {
  chatId: number;
  sessionId: number;
  userText: string;
  abortSignal: AbortSignal;
  /** Telegram user ID of the sender. Required for v1.7.5 role resolution. */
  userId?: number;
  /** Telegram chat type — 'private' / 'group' / 'supergroup'. v1.7.5. */
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  /** Group chat options — if present, enables group-mode behavior */
  groupOptions?: GroupTurnOptions;
  /**
   * v1.21.0 R3 (Item 3) — peer-bot message metadata.
   * When `senderIsBot` is true, the agent wraps `userText` via `wrapBotMessage`
   * before persisting to history so the LLM sees the `<from-bot>` boundary tag.
   * `senderBotName` is the peer bot's username (sanitized inside the wrap).
   * Self-echo is dropped earlier in the gateway (R2 + Item 2), so any
   * `senderIsBot=true` message that reaches agent.turn is a peer bot.
   */
  senderIsBot?: boolean;
  senderBotName?: string;
  /** Telegram adapter injected by the gateway so tools can send files. */
  telegram?: MessagingAdapter;
  /**
   * Override the per-turn tool-iteration cap (default: config.ai.maxToolIterations).
   * Used by /plan tasks which need a higher ceiling than normal chat turns
   * so the agent can chain search → browse → search-again → write without
   * tripping the cap. Clamped to [1, 30].
   */
  maxIterationsOverride?: number;
  /**
   * If true, the turn starts with an empty history instead of loading prior
   * messages from the session. Writes still happen normally so the audit
   * trail is preserved. Used by /plan to give each task an isolated context
   * — otherwise downstream tasks see task 1's 30+ tool results and decide
   * no further research is needed.
   */
  freshContext?: boolean;
  /**
   * Force a specific provider for this turn, bypassing routeTask().
   * Model resolves to config.ai.premiumModel (Claude) or config.ai.defaultModel
   * (Ollama). Used by /research --claude to run tasks on Claude when the user
   * wants tool-use quality over cost savings. Normal chat leaves this unset.
   */
  forceProvider?: 'claude' | 'ollama-cloud';
  /**
   * Optional model override paired with forceProvider. Used so /research
   * --claude can default to Haiku 4.5 (cheap) while /research --sonnet
   * gets Sonnet 4.6. When unset, falls back to premiumModel/defaultModel.
   */
  forceModel?: string;
  /**
   * v1.12.0 — streaming callbacks. When both are set, the agent routes
   * every provider call through `streamText` (instead of `call`) and fires
   * `onTextDelta` per chunk. `onProviderCallStart` fires right before each
   * provider invocation so the consumer can reset its text buffer between
   * iterations of the ReAct loop (tool-use preambles should not concatenate
   * with the final end_turn text in the rendered message).
   *
   * Wired only by the gateway DM path today. Plan/debate/voice/group paths
   * leave these unset and continue to use the non-streaming call().
   */
  onTextDelta?: (chunk: string) => void;
  onProviderCallStart?: () => void;
  /**
   * v1.18.0 ADR 018 D3.a — marks this turn as a coach run.
   * When true, the agent initializes coachTurnCounters in ToolContext so
   * coach_log_* tools can enforce per-turn nudge + write caps.
   */
  isCoachRun?: boolean;
  /**
   * v1.20.0 ADR 020 D7 — marks this turn as a spontaneous event-trigger fire.
   * When true, the coach prompt Step 0.5 focuses on the single triggered item
   * rather than running the full Step 0 multi-item picker.
   * Set by buildCoachTurnArgs({ isSpontaneousTrigger: true }) in gateway.fireSpontaneousCoachTurn.
   */
  isSpontaneousTrigger?: boolean;
  /**
   * v1.23.0 — gateway-decided activation mode. Determines which system-prompt
   * overlay (if any) is appended after the persona prompt. The overlay is the
   * structural fix for "specialists drift to prior tasks": the gateway
   * computes the bot's role for THIS turn (work / banter) from observable
   * state (directive present? this bot named?) rather than relying on the
   * model to reason about it from chat history.
   *
   *   work         — user named this bot with a directive separator. The
   *                  overlay wraps `directiveTask` in a <your-task> block
   *                  and instructs the model to do exactly that and stop.
   *   banter       — bot was activated without a directive (collective alias,
   *                  incidental @-mention). Overlay says "no active task; one
   *                  short reply or silence."
   *   orchestrator — Jarvis's default. No overlay; persona prompt unchanged.
   *                  Also the default when this field is unset (back-compat
   *                  for DM, /coach, classifier paths).
   */
  mode?: ActivationMode;
  /**
   * v1.23.0 — task text extracted from the user's directive when this bot
   * was named. Required when mode==='work'. Example: for "Tony — write the
   * test", directiveTask is "write the test". Capped at 4000 chars by the
   * overlay builder. Empty string is treated as "no specific task" and
   * the overlay falls back to a generic work prompt.
   */
  directiveTask?: string;
  /**
   * v1.23.4 — sustained-banter flag. Set by the gateway when the current
   * thread has its sustained-banter state armed (user invited a back-and-
   * forth chain via "keep going" / "take turns" / "continue until I say
   * stop"). When true AND mode==='banter', the overlay switches from the
   * default "one short reply or silence" to the "casual chain — keep the
   * round going" variant that explicitly invites pass-the-ball @-mentions.
   */
  sustainedBanter?: boolean;
}

export interface CompactionEvent {
  originalTokens: number;
  compressedTokens: number;
  provider: string;
  model: string;
}

export interface TurnResult {
  replyText: string;
  toolCalls: number;
  /**
   * v1.22.14 — true when the orchestrator called `delegate_to_specialist`
   * during this turn (the @-mention was posted as a separate message via
   * the tool). Gateway uses this to suppress the v1.22.10 orchestrator
   * delivery auto-stop, which would otherwise mis-fire because the
   * orchestrator's natural-language reply text intentionally has no
   * @-mention (the tool posts it separately).
   */
  delegated?: boolean;
  /**
   * v1.22.19 — full record of each `delegate_to_specialist` call this turn.
   * The gateway uses this to auto-create an Avengers plan when ≥2 specialists
   * are delegated in one turn (assemble-mode multi-step coordination).
   */
  delegations?: Array<{
    specialist: string;
    request: string;
    delegateMessageId: number;
  }>;
  /** Set when compaction ran before this turn. */
  compactionEvent?: CompactionEvent;
  /**
   * Token usage accumulated across all provider calls within this turn.
   * Present when at least one provider call reported usage (Claude always
   * does; Ollama Cloud sometimes omits). Absent otherwise so callers can
   * fall back to their own estimation.
   * Cache fields only meaningful for Claude — they reflect prompt-caching
   * hit rate so callers can compute true cost.
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AgentApi {
  turn(params: TurnParams): Promise<TurnResult>;
  /**
   * Execute a pre-confirmed destructive command directly, bypassing
   * re-classification. Called by the gateway after consumeConfirmation()
   * returns a PendingAction.
   */
  runConfirmedCommand(params: {
    chatId: number;
    sessionId: number;
    command: string;
    shell: 'powershell' | 'cmd' | 'none';
    args?: string[];
    abortSignal: AbortSignal;
  }): Promise<TurnResult>;
  /**
   * v1.22.35 — debate-for-accuracy entry point. Called by the gateway
   * after a specialist's draft reply is produced (in active assemble-mode
   * plans), before posting the final answer to chat. Runs up to 3 rounds
   * of critic ↔ specialist iteration on different Ollama models. Resolves
   * with the final text + full transcript + outcome.
   *
   * Cost guard: uses Ollama only — never falls back to Claude.
   */
  runDebateForStep(params: {
    initialDraft: string;
    request: string;
    specialistBotName: string;
    abortSignal: AbortSignal;
    onRoundComplete?: (round: import('../avengers/debate.js').DebateRound) => void | Promise<void>;
  }): Promise<import('../avengers/debate.js').DebateOutcome>;
}

/** Build OpenAI-format tool definitions from Tool[] */
function toUnifiedToolDefs(tools: Tool[]) {
  return tools.map((tool) => {
    const jsonSchema = zodToJsonSchema(tool.parameters, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    delete jsonSchema['$schema'];
    return {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchema,
    };
  });
}

// ---------------------------------------------------------------------------
// Post-turn chat message callback registry (v1.20.0 ADR 020 D6.b)
// Same fire-and-forget registry pattern as storage.ts calendar sync callbacks.
// FORBIDDEN: agent/index.ts MUST NOT import from coach/**. The coach module
// registers its callback at boot via registerChatMessageCallback() exported here.
// ---------------------------------------------------------------------------

/** Type for the post-turn chat message monitor callback. */
export type PostTurnChatCallback = (userId: number, message: string) => void;

let _postTurnChatCallback: PostTurnChatCallback | null = null;

/**
 * Register a post-turn chat callback (called at boot from src/index.ts).
 * Fires fire-and-forget after every successful private DM agent.turn().
 * ADR 020 D17: must NOT be registered with an identity stub.
 */
export function registerPostTurnChatCallback(cb: PostTurnChatCallback): void {
  _postTurnChatCallback = cb;
}

function _firePostTurnChat(userId: number, message: string): void {
  if (_postTurnChatCallback) {
    Promise.resolve()
      .then(() => _postTurnChatCallback!(userId, message))
      .catch(() => {
        // swallow — must not affect turn result
      });
  }
}

/**
 * Initialize the agent with its ReAct loop.
 * The agent orchestrates tool dispatch, history, provider routing, and Claude fallback.
 */
export function initAgent(deps: AgentDeps): AgentApi {
  const { config, memory, tools, safety, claudeProvider, ollamaProvider, schedulerApi, botIdentity } = deps;

  // Keep Anthropic tool defs for contextBuilder (still Anthropic format internally)
  toClaudeToolDefs(tools); // registers tools side-effect (no-op if already registered)

  function getProvider(providerName: string): ModelProvider {
    if (providerName === 'claude') return claudeProvider;
    return ollamaProvider;
  }

  /**
   * v1.22.21 — throttle map for the Claude-fallback chat warning.
   * Keyed by chatId; value is the last-notice ms timestamp. We send at most
   * one in-chat warning per chat per 5-minute window so the chat doesn't get
   * spammed when Ollama is having a bad minute. Process-local; resets on
   * pm2 restart, which is fine — a restart is itself a moment to re-warn.
   */
  const CLAUDE_FALLBACK_NOTICE_THROTTLE_MS = 5 * 60 * 1000;
  const claudeFallbackLastNotice = new Map<number, number>();

  /**
   * Call a provider with fallback to Claude on error.
   * v1.12.0 — when `onTextDelta` is provided, routes through `streamText`
   * so text chunks flow to the caller as they arrive. `onProviderCallStart`
   * (if provided) fires just before each provider invocation, including
   * fallback — consumers use it to reset per-iteration rendering buffers.
   */
  async function callWithFallback(
    providerName: string,
    model: string,
    params: Parameters<ModelProvider['call']>[0],
    chatId: number,
    sessionId: number,
    streaming?: {
      onTextDelta: (chunk: string) => void;
      onProviderCallStart?: () => void;
    },
    telegram?: MessagingAdapter,
  ) {
    const provider = getProvider(providerName);
    streaming?.onProviderCallStart?.();
    try {
      // Stream when requested AND the provider supports it. Test mocks and
      // minimal providers can omit streamText; they transparently fall
      // back to call() here (the deltas simply never fire, and the gateway's
      // final edit path shows the whole reply at once).
      if (streaming && provider.streamText) {
        return await provider.streamText({
          ...params,
          model,
          onTextDelta: streaming.onTextDelta,
        });
      }
      return await provider.call({ ...params, model });
    } catch (err) {
      const isOllama = providerName !== 'claude';
      if (isOllama && config.ai.routing.fallbackToClaudeOnError) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // v1.22.21 — make the silent Claude fallback LOUD. The prior behavior
        // logged a single warn line and quietly switched to Claude, which is
        // how the v1.22.20 gemma4:cloud bug billed Boss for ~$10 of Claude
        // calls without anyone noticing. Now we:
        //   1. Log error (not warn) so it stands out at INFO+.
        //   2. Audit every fallback (cost.claude_fallback) for offline analysis.
        //   3. Send a throttled (5-min/chat) chat warning so Boss SEES the spend.
        log.error(
          {
            chatId,
            sessionId,
            provider: providerName,
            model,
            err: errMsg,
          },
          'PROVIDER FALLBACK — Ollama failed, using Claude (premium tokens)',
        );

        const errSnippet = errMsg.length > 240 ? errMsg.slice(0, 239) + '…' : errMsg;
        const now = Date.now();
        const lastNoticeMs = claudeFallbackLastNotice.get(chatId) ?? 0;
        const throttled = now - lastNoticeMs < CLAUDE_FALLBACK_NOTICE_THROTTLE_MS;

        try {
          memory.auditLog.insert({
            category: 'cost.claude_fallback',
            actor_chat_id: chatId,
            session_id: sessionId,
            detail: {
              ollamaProvider: providerName,
              ollamaModel: model,
              errSnippet,
              throttledNotice: throttled,
              fallbackModel: config.ai.premiumModel,
            },
          });
        } catch {
          // Best-effort audit; never block the actual Claude call on it.
        }

        if (!throttled && telegram) {
          claudeFallbackLastNotice.set(chatId, now);
          // Fire-and-forget chat warning. Do NOT await — a slow Telegram send
          // must not delay the actual Claude call that's being requested.
          void telegram
            .sendMessage(
              chatId,
              `⚠️ <b>Premium tokens in use.</b> Ollama (<code>${model}</code>) returned an error; falling back to Claude (<code>${config.ai.premiumModel}</code>). Reason: <code>${errSnippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>\n\n<i>Throttled to one notice per 5 min per chat. Audit category: cost.claude_fallback.</i>`,
              { parseMode: 'HTML' },
            )
            .catch(() => undefined);
        }

        streaming?.onProviderCallStart?.();
        if (streaming && claudeProvider.streamText) {
          return claudeProvider.streamText({
            ...params,
            model: config.ai.premiumModel,
            onTextDelta: streaming.onTextDelta,
          });
        }
        return claudeProvider.call({ ...params, model: config.ai.premiumModel });
      }
      throw err;
    }
  }

  return {
    async turn(params: TurnParams): Promise<TurnResult> {
      const { chatId, sessionId, abortSignal, groupOptions, telegram } = params;
      const isGroupMode = groupOptions?.groupMode === true;
      const turnLog = log.child({ chatId, sessionId, groupMode: isGroupMode });

      // v1.21.0 R3 (Item 3) — defense-in-depth wrap. The gateway pre-wraps
      // peer-bot text via maybeWrapBotHistoryEntry. If a non-gateway caller
      // sets params.senderIsBot=true and the text is NOT already wrapped,
      // wrap it here so the LLM never sees raw peer-bot content.
      let userText = params.userText;
      if (params.senderIsBot === true && !/^<from-bot\b/i.test(userText)) {
        try {
          userText = wrapBotMessage({
            fromBotName: params.senderBotName ?? 'peer-bot',
            rawText: userText,
          });
        } catch (err) {
          turnLog.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'wrapBotMessage rejected — peer-bot text contained NUL bytes',
          );
          userText = `<from-bot name="${(params.senderBotName ?? 'peer-bot').replace(/[^a-zA-Z0-9_-]/g, '')}">[content rejected]</from-bot>`;
        }
      }

      // v1.7.5 — resolve role (admin / developer / member) and compute the
      // effective allowedPaths for this turn. Developers and members in a
      // group see ONLY that group's workspace; admins keep the full config
      // allowlist plus their workspace. ToolContext below uses a session-
      // scoped safety shim backed by these roots.
      const role = resolveRole(
        {
          chatId,
          userId: params.userId,
          chatType: params.chatType ?? (isGroupMode ? 'group' : 'private'),
        },
        config,
      );
      // v1.21.13 — when the sender is a peer bot (Jarvis relaying Boss's
      // request to Tony, etc.), bypass the role-based group-workspace
      // narrowing. The role mechanism was designed to scope HUMAN
      // developers in shared groups to just their group's workspace; it
      // doesn't apply to peer-bot relays where the receiving bot is
      // operating on its own per-bot allowedPaths sandbox (already
      // narrowed via wrapPathForBotIdentity at boot).
      const turnAllowedPaths = params.senderIsBot === true
        ? [...config.filesystem.allowedPaths]
        : effectiveAllowedPaths(
            config.filesystem.allowedPaths,
            chatId,
            role,
            config,
          );
      const turnSafety = sessionSafety(safety, turnAllowedPaths);
      const roleBlockedTools = blockedToolsForRole(role);
      turnLog.info(
        { role, allowedPathsCount: turnAllowedPaths.length, blockedToolsCount: roleBlockedTools.size },
        'Role + session-scoped safety resolved',
      );

      // Persist user message
      memory.messages.insert({
        session_id: sessionId,
        role: 'user',
        content: userText,
      });

      // Route to provider/model. /research --claude pins the provider for
      // each task, so honor that first; otherwise use the normal router.
      // forceModel (if set) overrides the default-for-provider model — used
      // so --claude defaults to Haiku 4.5 (cheap) and --sonnet escalates.
      let routing = params.forceProvider
        ? {
            provider: params.forceProvider,
            model: params.forceModel
              ?? (params.forceProvider === 'claude'
                ? config.ai.premiumModel
                : config.ai.defaultModel),
            reason: 'forced-by-caller',
          }
        : routeTask(userText, sessionId, config, memory, botIdentity);
      turnLog.info(
        { provider: routing.provider, model: routing.model, reason: routing.reason },
        'Agent turn start',
      );

      // Audit log: model routing / provider selection
      memory.auditLog.insert({
        category: 'model_switch',
        actor_chat_id: chatId,
        session_id: sessionId,
        detail: { provider: routing.provider, model: routing.model, reason: routing.reason },
      });

      // Load history (or skip when the caller requested a clean context,
      // e.g. /plan tasks that must search independently instead of riffing
      // on prior tasks' tool-call results).
      let history = params.freshContext
        ? []
        : memory.messages.listRecent(sessionId, config.memory.maxHistoryMessages);

      // --- Auto-compaction check (v1.4) ---
      let compactionEvent: CompactionEvent | undefined;
      let compactionsThisTurn = 0;
      if (config.context.autoCompact && compactionsThisTurn < 1) {
        const decision = shouldCompact(history, config, routing.provider, routing.model);
        if (decision.compact) {
          compactionsThisTurn++;
          turnLog.info(
            { estimated: decision.estimated, limit: decision.limit },
            'Auto-compaction triggered',
          );
          try {
            const result = await compactSession({
              sessionId,
              trigger: 'auto',
              provider: routing.provider,
              model: routing.model,
              history,
              cfg: config,
              claudeProvider,
              primaryProvider: getProvider(routing.provider),
              memory,
              abortSignal,
            });
            compactionEvent = {
              originalTokens: result.originalTokens,
              compressedTokens: result.compressedTokens,
              provider: routing.provider,
              model: routing.model,
            };
            // Audit log: compaction event
            memory.auditLog.insert({
              category: 'compaction',
              actor_chat_id: chatId,
              session_id: sessionId,
              detail: {
                originalTokens: result.originalTokens,
                compressedTokens: result.compressedTokens,
                provider: routing.provider,
                model: routing.model,
              },
            });
            // Reload history after compaction (now just the summary message + user turn)
            history = memory.messages.listRecent(sessionId, config.memory.maxHistoryMessages);
          } catch (err) {
            turnLog.error(
              { err: err instanceof Error ? err.message : String(err) },
              'Compaction failed — aborting turn',
            );
            const errMsg =
              'Context compaction failed. Please try /compact to retry manually, or /clear to reset.';
            memory.messages.insert({
              session_id: sessionId,
              role: 'assistant',
              content: errMsg,
            });
            return { replyText: errMsg, toolCalls: 0 };
          }
        }
      }
      // -------------------------------------

      // Build Anthropic-format messages (contextBuilder stays Anthropic-internal)
      const anthropicMessages = buildMessages(history.slice(0, -1), userText, config);

      // Convert Anthropic messages to UnifiedMessages for the provider layer
      const unifiedMessages = anthropicMessages.map((m) => {
        if (m.role === 'user') {
          if (Array.isArray(m.content)) {
            // Tool result blocks
            return {
              role: 'user' as const,
              blocks: (m.content as Array<{ type: string; tool_use_id: string; content: string }>)
                .filter((b) => b.type === 'tool_result')
                .map((b) => ({
                  type: 'tool_result' as const,
                  tool_call_id: b.tool_use_id,
                  content: b.content,
                })),
            };
          }
          return { role: 'user' as const, content: m.content as string };
        }
        if (m.role === 'assistant') {
          if (Array.isArray(m.content)) {
            const blocks = m.content as Array<{
              type: string;
              text?: string;
              id?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
            const textBlock = blocks.find((b) => b.type === 'text');
            const toolBlocks = blocks.filter((b) => b.type === 'tool_use');
            return {
              role: 'assistant' as const,
              content: textBlock?.text,
              tool_calls: toolBlocks.map((b) => ({
                id: b.id ?? '',
                name: b.name ?? '',
                input: b.input ?? {},
              })),
            };
          }
          return { role: 'assistant' as const, content: m.content as string };
        }
        return { role: 'user' as const, content: '' };
      });

      // Build system prompt — append group-mode instruction if applicable.
      // v1.21.0 Item 7 (QA M3): pass botIdentity + tools so {{TOOL_LIST}}
      // substitutes to the rendered allowlist (not the placeholder fallback).
      let systemPrompt = buildSystemPrompt(config, botIdentity, tools);

      // v1.23.0 — gateway-decided activation mode overlay. Prepended (not
      // appended) so the model sees the work/banter definition BEFORE any
      // persona voice text. The overlay is the structural replacement for
      // the v1.22.46 persona §6/§7 rules ("no active task by default") —
      // instead of trusting the model to reason about its role from chat
      // history, the gateway computes it deterministically and tells the
      // model directly. work mode also pairs with freshContext=true (set
      // separately by the gateway) so the model literally cannot drift
      // into resuming a prior task.
      if (params.mode === 'work') {
        const overlay = buildWorkOverlay(params.directiveTask ?? '');
        systemPrompt = `${overlay}\n\n---\n\n${systemPrompt}`;
      } else if (params.mode === 'banter') {
        const overlay = buildBanterOverlay(params.sustainedBanter === true);
        systemPrompt = `${overlay}\n\n---\n\n${systemPrompt}`;
      }
      // mode === 'orchestrator' or undefined → no overlay (back-compat).

      if (isGroupMode) {
        const askerName = groupOptions?.senderName ?? 'the user';
        systemPrompt +=
          `\n\n## Group-chat addressing rule\n` +
          `This message came from **${askerName}** in a group chat with other ` +
          `participants. Your reply is being posted to everyone, but it is ` +
          `answering **${askerName}** specifically.\n\n` +
          `Hard rules:\n` +
          `1. Address ${askerName} directly using "you". Do NOT begin your ` +
          `reply with "Hi ${askerName}," or "Hey ${askerName}," — Telegram ` +
          `already shows your bot name above each message, so name-greetings ` +
          `are noise.\n` +
          `2. NEVER include a leading addressing prefix yourself. Do NOT start ` +
          `your reply with any of these patterns: "<b>@${askerName}</b>:", ` +
          `"@${askerName}:", "${askerName}:", "<b>${askerName}</b>:", ` +
          `"**${askerName}**:", "Boss:", "Boss,", or any other name-then-colon / ` +
          `name-then-comma construction (including the user's nickname or ` +
          `any peer bot's name as a leading prefix). Telegram's UI shows the ` +
          `sender of each message; a leading "Name:" reads as if YOU are ` +
          `that named person, which is wrong. Start your reply with the actual content.\n` +
          `3. NEVER use HTML tags like <b>, <i>, <u> in your reply text. ` +
          `Use plain text or Telegram-flavored Markdown (**bold**, _italic_, ` +
          `\`code\`). The send path converts Markdown → HTML; literal HTML you ` +
          `emit will be double-escaped and shown as raw "<b>...</b>" text.\n` +
          `4. Do NOT greet, name-check, or address any OTHER participant in ` +
          `the group. If ${askerName} did not mention a third party by name in ` +
          `their message, you do not know who else is in the chat, so never ` +
          `guess or invent names.\n` +
          `5. Keep answers concise and conversational — this is group chat, not a doc.\n` +
          `6. If the message is ambiguous about who it's for, answer as if ` +
          `${askerName} is the sole addressee.`;

        // v1.22.14 — Avengers ASSEMBLE mode addendum. When the user has
        // toggled `/avengers assemble on` in this chat, the orchestrator
        // (full-scope bot) gets ONE specialist primitive: the
        // `delegate_to_specialist` tool. Every other specialist tool
        // (read_file, write_file, system_info, run_command, etc.) is
        // stripped. Pure prompt pressure (v1.22.0–v1.22.13) failed because
        // the model treated "@-mention" as a missing tool and apologized
        // ("the inter-bot communication tools appear to be unavailable").
        // Giving the model an actual tool to call resolves the false
        // mental model — calling a tool is an action it knows how to take.
        const avengersModes = memory.groupSettings.getAvengersModes(chatId);
        if (avengersModes.assemble && botIdentity?.scope === 'full') {
          systemPrompt +=
            `\n\n## AVENGERS, ASSEMBLE — your action, RIGHT NOW\n\n` +
            `For ANY specialist-domain ask in this turn (engineering, research, ` +
            `analysis, code, files, system info, web), your FIRST and ONLY action ` +
            `is to call the \`delegate_to_specialist\` tool. Do NOT type a text reply ` +
            `instead. Do NOT acknowledge first. Call the tool. Multiple calls in ` +
            `one turn are encouraged when the request spans multiple domains.\n\n` +
            `Tool args:\n` +
            `- \`specialist\`: one of \`"ai-tony"\` (engineering/code/files/web), ` +
            `\`"ai-natasha"\` (research/intel/fact-check), or \`"ai-bruce"\` ` +
            `(analysis/calculations/reasoning).\n` +
            `- \`request\`: one or two sentences of plain English describing what you ` +
            `need from that specialist.\n\n` +
            `After calling the tool(s), write a brief acknowledgement to ${askerName} ` +
            `(e.g. "On it — Tony, Natasha, and Bruce are on it."). The specialists ` +
            `will deliver their work in the chat directly.\n\n` +
            `**You DO own** (use directly, no delegation): calendar_*, gmail_*, ` +
            `coach_*, schedule, update_memory, forget_memory.`;
        }
        if (avengersModes.chat) {
          systemPrompt +=
            `\n\n## AVENGERS chat mode — relaxed posture\n` +
            `Specialists may chime in on conversation relevant to their scope ` +
            `even without an explicit @-mention. Keep replies short and don't ` +
            `pile on — a single specialist's input per topic is enough.`;
        }

        // v1.22.25 — Avengers plan context for the orchestrator. Two cases:
        //   (a) ACTIVE/SYNTHESIZING — plan is in flight; tell Jarvis what
        //       each step is doing so he can give status updates without
        //       delegating again.
        //   (b) DELIVERED within the last 30 minutes — tell Jarvis the
        //       deliverable already shipped + filename, so he can answer
        //       follow-ups ("send me the output", "are you still compiling")
        //       by pointing at the existing upload instead of manually
        //       re-synthesizing in text. After 30 min the context drops
        //       (assume the conversation has moved on).
        if (botIdentity?.scope === 'full') {
          try {
            const recentPlan = memory.plans.findMostRecentForChat(chatId);
            if (recentPlan) {
              const ageMin = (Date.now() - new Date(recentPlan.updated_at).getTime()) / 60_000;
              const isActive = recentPlan.status === 'active' || recentPlan.status === 'synthesizing';
              const isFreshlyDelivered =
                recentPlan.status === 'delivered' && ageMin < 30;

              if (isActive || isFreshlyDelivered) {
                const planSteps = memory.plans.stepsFor(recentPlan.id);
                const stepLines = planSteps
                  .map((s) => {
                    const statusMark =
                      s.status === 'done' ? '✅' :
                      s.status === 'in_progress' ? '🔄' :
                      s.status === 'failed' ? '❌' : '⬜';
                    const summary = s.summary ? ` — ${s.summary.slice(0, 80)}` : '';
                    return `  ${statusMark} ${s.bot_name} (step ${s.step_order})${summary}`;
                  })
                  .join('\n');

                if (isActive) {
                  systemPrompt +=
                    `\n\n## Active Avengers Operation #${recentPlan.id} — status: ${recentPlan.status}\n` +
                    `Task: ${recentPlan.task.slice(0, 200)}\n` +
                    `Steps:\n${stepLines}\n\n` +
                    `This plan is in flight. If ${askerName} asks for a status update, summarize ` +
                    `where each step is. Do NOT delegate again for this plan — the specialists ` +
                    `are already working. If ${askerName} sends a NEW unrelated request, treat ` +
                    `it normally (the active plan is just background context).`;
                } else {
                  // Freshly delivered (≤30 min old).
                  const filename = recentPlan.deliverable_path
                    ? recentPlan.deliverable_path.split(/[\\/]/).pop()
                    : 'the deliverable file';
                  const ageDesc = ageMin < 1
                    ? 'just now'
                    : `${Math.round(ageMin)} minute${Math.round(ageMin) === 1 ? '' : 's'} ago`;
                  systemPrompt +=
                    `\n\n## Recent Avengers Operation #${recentPlan.id} — DELIVERED ${ageDesc}\n` +
                    `Task: ${recentPlan.task.slice(0, 200)}\n` +
                    `Specialists' contributions:\n${stepLines}\n\n` +
                    `**The full deliverable was already uploaded to this chat as ` +
                    `\`${filename}\`.** If ${askerName} asks "where's the output", ` +
                    `"send me the deliverable", "are you still compiling", or anything else ` +
                    `referring to this work — point at the file you uploaded above. Do NOT ` +
                    `re-synthesize the content in text; it's already a complete styled HTML ` +
                    `document. A short reply like "It's the file above — \`${filename}\`. ` +
                    `Tap to open." is enough.\n\n` +
                    `If ${askerName} sends a NEW unrelated request, treat it normally — the ` +
                    `prior delivery is just context.`;
                }
              }
            }
          } catch (err) {
            turnLog.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to inject plan context (proceeding without)',
            );
          }
        }
      }

      // v1.7.8 — inject workspace awareness. The turn's effectiveAllowedPaths
      // was computed from role + workspace (admin keeps full allowlist;
      // developer/member sees ONLY their group's workspace). Tell the model
      // those paths explicitly so it stops guessing locations it doesn't
      // have access to. Without this, non-admin users see a cascade of
      // "Access denied" errors because the LLM tries common paths blindly.
      if (turnAllowedPaths.length > 0) {
        const pathList = turnAllowedPaths.map((p) => `  - ${p}`).join('\n');
        systemPrompt +=
          `\n\n## Writable paths for this session (${role})\n` +
          `All file operations (write_file, list_directory, search_files, read_file) ` +
          `MUST use these paths or subdirectories within them. Any other path on the ` +
          `host will be rejected with "Access denied".\n\n${pathList}\n\n` +
          (role !== 'admin'
            ? `You are a ${role} in this chat. This chat's workspace is your ONLY ` +
              `accessible location. Other groups' workspaces and the Jarvis install ` +
              `itself are invisible to you. Prefer writing to the workspace root on ` +
              `the first try instead of guessing.\n`
            : '');
      }

      // v1.8.5 — inject the speaker's persistent memory if any. Per-USER
      // (not per-chat): the same Boss in DM, group A, and group B sees one
      // consistent memory. In groups, only THIS turn's speaker memory is
      // loaded — different users get personalized context in the same room.
      // The memory file is human-editable markdown at data/memories/<userId>.md.
      // Cached by Anthropic prompt caching (carries the system prompt) so
      // it costs ~0 to inject every turn after the first.
      if (params.userId && Number.isFinite(params.userId) && !isMemoryDisabledForUser(params.userId)) {
        const dataDir = path.resolve(
          config.memory?.dbPath ? path.dirname(config.memory.dbPath) : 'data',
        );
        try {
          const userMemoryBody = await readUserMemory(params.userId, dataDir);
          if (userMemoryBody.trim().length > 0) {
            systemPrompt +=
              `\n\n## Long-term memory about this user\n` +
              `The following is what the user has explicitly asked you to remember about them. ` +
              `Treat this as authoritative profile context — they wrote it (or asked you to). ` +
              `Honor preferences (reply length, model, tone) and reference projects/people as relevant. ` +
              `Do NOT mention this section verbatim or read it back unprompted; it is context, not a script. ` +
              `If the user wants to update or remove an entry, call \`update_memory\` or \`forget_memory\`.\n\n` +
              userMemoryBody;
          }
        } catch (err) {
          turnLog.warn(
            { userId: params.userId, err: err instanceof Error ? err.message : String(err) },
            'Failed to load user memory; proceeding without',
          );
        }
      }

      // v1.8.6 — active /organize items for this user (DM-only; scheduler turns skipped;
      // /organize off skipped). Injected AFTER memory so items appear below the profile
      // context block. On any error, proceeds without the block (same posture as memory).
      //
      // v1.19.0 ADR 019 R1 Layer (b) wiring: for COACH turns (isCoachRun=true), use
      // buildCoachPromptWithItems from coachPromptBuilder.ts so each item's
      // title/notes/progress are wrapped in <untrusted source="organize.item" ...>.
      // Layer (a) sanitizer in src/calendar/sync.ts already neutralizes the actual
      // injection threat at sync time; Layer (b) is defense-in-depth at the LLM boundary.
      if (
        params.userId &&
        Number.isFinite(params.userId) &&
        !isGroupMode &&
        !isOrganizeDisabledForUser(params.userId)
      ) {
        const dataDir = path.resolve(
          config.memory?.dbPath ? path.dirname(config.memory.dbPath) : 'data',
        );
        try {
          if (params.isCoachRun) {
            // Coach turn — wrap user-text fields in <untrusted> per ADR 019 R1 Layer (b).
            // See src/coach/coachPromptInjection.ts for the seam + tests.
            const block = await buildCoachActiveItemsBlock(params.userId, dataDir);
            if (block.length > 0) systemPrompt += '\n\n' + block;
          } else {
            // Non-coach DM turn — legacy injection.ts (already wraps titles in <untrusted>).
            const block = await buildActiveItemsBlock(params.userId, dataDir);
            if (block.length > 0) systemPrompt += block;
          }
        } catch (err) {
          turnLog.warn(
            { userId: params.userId, err: err instanceof Error ? err.message : String(err) },
            'Failed to load organize items; proceeding without',
          );
        }
      }

      // v1.7.5 — filter tools by role. Admins and developers see every
      // non-admin-only tool; members see only the read-only subset.
      // v1.7.10 — also drop admin-only tools (e.g. Gmail MCP) from
      // anything that isn't an admin session.
      const effectiveDisabledTools = [...roleBlockedTools];
      let activeTools =
        roleBlockedTools.size > 0
          ? toolsForContext({
              groupMode: true,
              disabledTools: effectiveDisabledTools,
              allTools: tools,
            })
          : tools;
      if (role !== 'admin') {
        activeTools = activeTools.filter((t) => !t.adminOnly);
      }
      // v1.7.11.2 — per-chat /calendar off toggle. Drops calendar_* from the
      // model's tool list for this chat without affecting other chats or the
      // tool registration. Default state is ON.
      if (!isCalendarEnabledForChat(chatId)) {
        activeTools = activeTools.filter((t) => !t.name.startsWith('calendar_'));
      }
      // v1.8.6 — /organize is DM-only. Strip organize_* from group turns.
      // Defense-in-depth: the dispatcher's allowedToolNames set also rejects them.
      if (isGroupMode) {
        activeTools = activeTools.filter((t) => !t.name.startsWith('organize_'));
      }

      // v1.22.14 — Avengers ASSEMBLE mode. When the orchestrator (full-scope)
      // is processing in a chat with assemble_mode=true, strip every
      // specialist tool AND add `delegate_to_specialist` as the sole
      // engineering-side primitive. The strip + add together force the
      // model to call delegate_to_specialist instead of either self-serving
      // (v1.22.10 and earlier) or apologizing about missing tools
      // (v1.22.11–v1.22.13 with strip but no replacement primitive).
      //
      // Strip set: SPECIALIST_TOOL_ALLOWLIST (read_file, write_file,
      // list_directory, search_files, system_info, recall_archive,
      // web_search, browse_url, send_file) PLUS run_command — observed in
      // v1.22.11 that leaving run_command as an escape hatch made Jarvis
      // shift from system_info to wmic-via-shell instead of delegating.
      //
      // Add: delegate_to_specialist — the orchestrator's one tool for
      // specialist work. Filtered out of every other context by NOT being
      // in the registered tool list's natural activeTools selection here.
      //
      // Jarvis keeps: calendar_*, organize_* (DM-only — already filtered
      // in groups), coach_*, gmail_*, schedule, update_memory,
      // forget_memory, MCP tools, plus delegate_to_specialist.
      const isAssembleMode =
        isGroupMode &&
        botIdentity?.scope === 'full' &&
        memory.groupSettings.getAvengersModes(chatId).assemble;
      if (isAssembleMode) {
        const ASSEMBLE_STRIP = new Set<string>([
          ...SPECIALIST_TOOL_ALLOWLIST,
          'run_command',
        ]);
        const beforeCount = activeTools.length;
        activeTools = activeTools.filter((t) => !ASSEMBLE_STRIP.has(t.name));
        const stripped = beforeCount - activeTools.length;

        // Add delegate_to_specialist (must be in the registered tool list).
        const delegateTool = tools.find((t) => t.name === 'delegate_to_specialist');
        if (delegateTool && !activeTools.some((t) => t.name === 'delegate_to_specialist')) {
          activeTools.push(delegateTool);
        }

        turnLog.info(
          { chatId, stripped, hasDelegate: !!delegateTool, remaining: activeTools.length },
          'avengers assemble: stripped specialist tools, added delegate_to_specialist',
        );
      } else {
        // Outside assemble mode, never expose delegate_to_specialist.
        // Specialists are also blocked by GATE 1 (not in their allowlist),
        // but DM and chat-mode group turns get the explicit filter for
        // defense-in-depth — keeps the tool from accidentally becoming
        // visible if some future code path relaxes the gating.
        activeTools = activeTools.filter((t) => t.name !== 'delegate_to_specialist');
      }

      const activeUnifiedToolDefs = toUnifiedToolDefs(activeTools);
      // V-01: build an allowedToolNames set from the active tool list for this turn.
      // dispatch() rejects any tool name not in this set, even if the model hallucinates it.
      const allowedToolNames = new Set(activeTools.map((t) => t.name));

      // v1.18.0 ADR 018 D3.a — per-coach-turn write counters.
      // Initialized once per turn; shared across all tool-call iterations.
      // Passed through ToolContext so coach_log_* tools can enforce per-turn caps.
      const coachTurnCounters: { nudges: number; writes: number } | undefined =
        params.isCoachRun ? { nudges: 0, writes: 0 } : undefined;

      // v1.22.41 — per-turn web_search counter. Initialized to 0 here and
      // shared across every tool-call iteration in this turn (mutable wrapper
      // so increments by web_search.ts persist in this scope). web_search
      // enforces MAX_WEB_SEARCHES_PER_TURN against this counter.
      const turnWebSearchCounter: { count: number } = { count: 0 };

      let toolCallCount = 0;
      // v1.22.14 — tracks whether the orchestrator successfully invoked
      // `delegate_to_specialist` this turn. Surfaces in TurnResult so the
      // gateway can skip the v1.22.10 orchestrator-delivery auto-stop check.
      let delegatedThisTurn = false;
      // v1.22.19 — collect each successful delegation for the gateway's
      // Avengers plan auto-trigger (≥2 delegations in one turn → plan).
      const delegationsThisTurn: Array<{ specialist: string; request: string; delegateMessageId: number }> = [];
      const maxIterations = params.maxIterationsOverride !== undefined
        ? Math.max(1, Math.min(40, params.maxIterationsOverride))
        : config.ai.maxToolIterations;
      // Turn-local usage accumulator. Summed across every provider call
      // made in this turn so TurnResult can surface it to /research cost
      // tracking. Stays undefined if no call reported usage.
      let turnUsage:
        | {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens: number;
            cache_read_input_tokens: number;
          }
        | undefined;

      // Working message buffer (unified format)
      let workingMessages = [...unifiedMessages];

      // Escalation: if the default provider exhausts maxIterations without
      // finishing, we retry the turn once on the premium provider (Claude).
      // Ollama-cloud models sometimes get stuck in tool-call loops; Claude
      // is usually better at terminating. Only escalates if we aren't
      // already on the premium provider.
      let escalated = false;

      escalation_loop: for (let attempt = 0; attempt < 2; attempt++) {
       for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (abortSignal.aborted) {
          return { replyText: 'Stopped.', toolCalls: toolCallCount };
        }

        const response = await callWithFallback(
          routing.provider,
          routing.model,
          {
            model: routing.model,
            system: systemPrompt,
            messages: workingMessages,
            tools: activeUnifiedToolDefs,
            maxTokens: config.ai.maxTokens,
            abortSignal,
          },
          chatId,
          sessionId,
          params.onTextDelta
            ? {
                onTextDelta: params.onTextDelta,
                ...(params.onProviderCallStart && {
                  onProviderCallStart: params.onProviderCallStart,
                }),
              }
            : undefined,
          telegram,
        );

        // Accumulate token usage
        if (response.usage) {
          memory.sessionModelState.accumulateTokens(
            sessionId,
            response.usage.input_tokens,
            response.usage.output_tokens,
          );
          // Also track usage at the turn level so TurnResult can expose it.
          turnUsage = {
            input_tokens: (turnUsage?.input_tokens ?? 0) + response.usage.input_tokens,
            output_tokens: (turnUsage?.output_tokens ?? 0) + response.usage.output_tokens,
            cache_creation_input_tokens:
              (turnUsage?.cache_creation_input_tokens ?? 0) +
              (response.usage.cache_creation_input_tokens ?? 0),
            cache_read_input_tokens:
              (turnUsage?.cache_read_input_tokens ?? 0) +
              (response.usage.cache_read_input_tokens ?? 0),
          };
        } else {
          // Estimate: charLength / 4
          const inputEst = Math.ceil(
            workingMessages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4,
          );
          const outputEst = Math.ceil(response.content.length / 4);
          memory.sessionModelState.accumulateTokens(sessionId, inputEst, outputEst);
        }

        turnLog.debug(
          { stopReason: response.stop_reason, iteration, provider: response.provider },
          'Provider response received',
        );

        if (response.stop_reason === 'end_turn') {
          // Strip think tags from final reply
          let replyText = stripThinkTags(response.content);

          // If this turn was escalated (default provider exhausted iterations),
          // prepend a one-line notice so the user knows a handoff happened.
          if (escalated) {
            replyText = `⚡ _Escalated to ${routing.model} after the default model got stuck._\n\n${replyText}`;
          }

          if (isGroupMode) {
            // v1.21.9: normalize peer-bot @-mentions to their canonical
            // Telegram username BEFORE the scrub. LLMs frequently drop
            // underscores when emitting usernames — Jarvis writing
            // "@aiTonyStark_bot" instead of "@your_tony_bot" causes
            // Telegram to render the @ as plain text (no mention entity),
            // so Tony's process never sees a mention. We fuzzy-match
            // every @\w+ in the reply against known bot identifiers
            // (canonical username, BotName, aliases) by stripping
            // separators and lowercasing both sides; on match, rewrite
            // to @<canonical_username>.
            replyText = normalizePeerBotMentions(replyText);

            // Group-scoped scrub: redact paths, hostname, username (in addition to secrets)
            replyText = scrubForGroup(replyText, config);

            // Truncate to maxResponseLength (after scrubbing, before HTML escape and send)
            const maxLen = config.groups.maxResponseLength;
            if (replyText.length > maxLen) {
              replyText = replyText.slice(0, maxLen) + '…';
            }

            // v1.22.48 — Strip LLM-emitted self-identifying prefixes (e.g.
            // "Tony: ..." or "@LeesJarvisBot: ...") so they don't render in
            // chat. Previously this block ALSO re-prepended the sender's
            // first name ("Boss: <reply>"), which read like Boss was the
            // speaker — confusing UX, since Telegram already shows the
            // sender via the from-username header on every message. The
            // re-prepend is gone; only the strip remains.
            //
            // History (kept for context):
            //   v1.21.4 — added the sender-name prepend
            //   v1.21.6 → v1.21.11 — fuzzy-matched the strip set
            //   v1.21.12 — skipped the prepend when sender was a peer bot
            //   v1.22.48 — dropped the prepend entirely
            // v1.23.4 — dropped the `&& params.senderIsBot !== true` guard.
            // That guard was a leftover from the v1.21.12 prepend logic:
            // when the trigger was a peer bot, the prepend was skipped to
            // avoid double-name-stacking. v1.22.48 removed the prepend
            // entirely but the guard stayed, which meant the strip pass
            // never ran on replies-to-peer-bots — so "Boss:" prefixes
            // from Jarvis leaked through whenever Bruce/Tony triggered
            // his turn. Always run the strip when senderName is set.
            if (groupOptions?.senderName) {
              const name = groupOptions.senderName;
              // v1.21.6 → v1.21.11: strip any recognizable addressing prefix
              // the LLM emitted, not just the receiver's name. The model
              // sometimes emits OTHER bot identifiers in the prefix slot
              // ("LeesJarvisBot: Jarvis: hello" — peer-bot username,
              // possibly with separators dropped, followed by sender
              // display name).
              //
              // v1.21.11: switch from literal-regex match to FUZZY match,
              // so that prefix candidates with stripped underscores/hyphens
              // ("LeesJarvisBot" matching canonical "your_jarvis_bot") are
              // still recognized.
              //
              // Algorithm: build a normalized lookup set (lowercase + no
              // separators) of every recognizable identifier — sender
              // name + every BotName + every Telegram username + every
              // alias. For each leading prefix attempt, extract the
              // candidate token, normalize it, and check membership in
              // the set. Iterate up to 3 times to peel stacked prefixes.
              const normalize = (s: string): string =>
                s.toLowerCase().replace(/[^a-z0-9]/g, '');
              const allowSet = new Set<string>();
              const addCandidate = (c: string): void => {
                const n = normalize(c);
                if (n.length > 0) allowSet.add(n);
              };
              addCandidate(name);
              for (const bn of BOT_NAMES) {
                addCandidate(bn);
                const u = BOT_TELEGRAM_USERNAMES[bn];
                if (u) addCandidate(u);
                for (const a of BOT_ALIASES_BY_NAME[bn]) addCandidate(a);
              }
              // v1.23.1 — addressee aliases the persona uses (e.g. "Boss")
              // that may not match the user's Telegram first_name. Without
              // these, the strip pass leaves "Boss: ..." prefixes intact
              // when first_name is something else (observed: Jarvis emitted
              // "Boss: @your_bruce_bot — your turn." in 4 of 5 last
              // group replies).
              for (const a of config.groups.userAddresseeAliases) addCandidate(a);
              // Each iteration tries to match one of:
              //   <b>@?TOKEN</b>:
              //   **TOKEN**:
              //   @?TOKEN:
              // where TOKEN = [\w\s.-]+ (letters/digits/underscores/spaces/
              //   hyphens/dots). We capture TOKEN and verify via normalize().
              const prefixCandidatePattern = new RegExp(
                `^\\s*(?:<b>\\s*@?([\\w\\s.-]+?)\\s*<\\/b>|\\*\\*\\s*([\\w\\s.-]+?)\\s*\\*\\*|@?([\\w.-]+))\\s*:\\s*`,
                'i',
              );
              for (let i = 0; i < 3; i++) {
                const m = prefixCandidatePattern.exec(replyText);
                if (!m) break;
                const token = m[1] ?? m[2] ?? m[3] ?? '';
                if (!allowSet.has(normalize(token))) break;
                replyText = replyText.slice(m[0].length);
              }
              // v1.22.48: no longer re-prepends `${name}: `. Strip-only.
            }
          }

          // Persist assistant message (store untruncated text for history continuity,
          // but we persist what was actually said — the scrubbed/truncated version)
          memory.messages.insert({
            session_id: sessionId,
            role: 'assistant',
            content: replyText,
          });

          memory.sessions.touchLastActive(sessionId, chatId);
          turnLog.info({ replyLen: replyText.length, toolCallCount, groupMode: isGroupMode }, 'Agent turn complete');

          // v1.20.0 ADR 020 D6.b: fire post-turn chat callback for private DMs
          // (not group mode, not coach/spontaneous turns — those are not user messages).
          // userId == chatId for private DMs; params.userId carries the Telegram user id.
          // v1.21.0 Item 5 (Anti-Slop F-A3): skip the chat-monitor fire when the
          // sender is a peer bot. Coach triggers must run on REAL user messages
          // only; peer-bot messages are loop-protected + wrapped (R3) and must
          // not perturb the user-engagement detector.
          if (
            !isGroupMode &&
            !params.isCoachRun &&
            params.userId !== undefined &&
            params.senderIsBot !== true
          ) {
            // v1.20.0 Scalability CRIT-A producer-side wiring: record this user message
            // BEFORE firing the chat trigger so the D12 60s debounce check (which reads
            // coach.global.lastUserMessageAt) sees the fresh timestamp on the next fire.
            // Fire-and-forget — must not block the agent return path.
            const dataDir = path.resolve(
              config.memory?.dbPath ? path.dirname(config.memory.dbPath) : 'data',
            );
            const userIdForRecord = params.userId;
            void recordUserMessage(userIdForRecord, dataDir).catch((err: unknown) => {
              turnLog.warn(
                { userId: userIdForRecord, err: err instanceof Error ? err.message : String(err) },
                'recordUserMessage failed — D12 debounce may not register this DM',
              );
            });
            _firePostTurnChat(params.userId, userText);
          }

          return {
            replyText,
            toolCalls: toolCallCount,
            delegated: delegatedThisTurn,
            delegations: delegationsThisTurn.length > 0 ? delegationsThisTurn : undefined,
            compactionEvent,
            usage: turnUsage,
          };
        }

        if (response.stop_reason === 'tool_use') {
          const toolCalls = response.tool_calls;

          if (toolCalls.length === 0) {
            turnLog.warn({ iteration }, 'stop_reason=tool_use but no tool_calls');
            break;
          }

          // Add assistant message with tool_calls to working buffer
          workingMessages.push({
            role: 'assistant',
            content: response.content || undefined,
            tool_calls: toolCalls,
          });

          // Dispatch each tool sequentially
          const toolResultBlocks: Array<{
            type: 'tool_result';
            tool_call_id: string;
            content: string;
          }> = [];

          for (const toolCall of toolCalls) {
            toolCallCount++;

            // Persist assistant tool_use message
            memory.messages.insert({
              session_id: sessionId,
              role: 'assistant',
              content: response.content || null,
              tool_name: toolCall.name,
              tool_input: JSON.stringify(toolCall.input),
              tool_use_id: toolCall.id,
            });

            // v1.21.0 Item 6 — use SSOT buildToolContext factory so botIdentity
            // is always populated. Direct literal would silently leave
            // ToolContext.botIdentity = undefined → specialist allowlist gate
            // structurally bypassed (CRITICAL-1.21.0.D).
            const toolCtx = buildToolContext({
              botIdentity,
              sessionId,
              chatId,
              logger: turnLog,
              config,
              memory,
              // v1.7.5: session-scoped safety shim enforces per-chat workspace
              // isolation. Developers/members in a group can only reach that
              // group's workspace; admin DMs keep the full config allowlist.
              safety: turnSafety,
              abortSignal,
              telegram,
              userId: params.userId,
              userName: groupOptions?.senderName ?? undefined,
              // V-01: pass the per-turn allowed tool set so dispatch() can enforce it
              allowedToolNames,
              // v1.10.0: expose scheduler API so the `schedule` tool can reload
              // the cron registry immediately after inserting a new task.
              schedulerApi,
              // v1.18.0 ADR 018 D3.a: per-turn coach caps (undefined on normal turns)
              coachTurnCounters,
              // v1.22.41 — per-turn web_search cap (incident: 26 Tavily calls in 2 minutes)
              turnWebSearchCounter,
            });

            // Check for destructive tool commands that need confirmation
            if (toolCall.name === 'run_command') {
              const cmdInput = toolCall.input as { command?: string; shell?: 'powershell' | 'cmd' | 'none' };
              const cmd = cmdInput.command ?? '';
              const shell = cmdInput.shell ?? 'powershell';
              const classification = safety.classifyCommand(cmd, shell);

              if (classification.hardReject) {
                const output = `Hard-rejected: ${classification.matchedRule}. This command uses obfuscation or indirection and cannot be executed.`;
                toolResultBlocks.push({
                  type: 'tool_result',
                  tool_call_id: toolCall.id,
                  content: output,
                });
                memory.messages.insert({
                  session_id: sessionId,
                  role: 'tool',
                  tool_name: toolCall.name,
                  tool_output: output,
                  tool_use_id: toolCall.id,
                });
                continue;
              }

              if (classification.destructive && !safety.hasPending(sessionId)) {
                const { actionId } = safety.requireConfirmation(sessionId, {
                  sessionId,
                  description: cmd,
                  command: cmd,
                  shell,
                });

                const confirmMsg =
                  `⚠️ Destructive command detected (${classification.matchedRule ?? 'destructive pattern'}):\n` +
                  `\`${cmd}\`\n\n` +
                  `Reply \`YES ${actionId}\` to confirm, or ignore to cancel.`;

                memory.messages.insert({
                  session_id: sessionId,
                  role: 'tool',
                  tool_name: toolCall.name,
                  tool_output: confirmMsg,
                  tool_use_id: toolCall.id,
                });

                memory.sessions.touchLastActive(sessionId, chatId);
                return { replyText: confirmMsg, toolCalls: toolCallCount };
              }
            }

            // Execute the tool
            // v1.11.0 Fix W1: audit row emitted AFTER dispatch so result.data.outcome
            // (e.g. 'deleted' / '404-already-gone' from calendar_delete_event) is captured.
            // ADR 006 R1 bullet 3.
            let result: Awaited<ReturnType<typeof dispatch>>;
            try {
              result = await dispatch(toolCall.name, toolCall.input, toolCtx);
              if (toolCall.name === 'delegate_to_specialist' && result.ok) {
                delegatedThisTurn = true;
                const data = result.data as { specialist?: string; messageId?: number } | undefined;
                const reqInput = toolCall.input as { request?: string } | undefined;
                if (data?.specialist && typeof data.messageId === 'number' && reqInput?.request) {
                  delegationsThisTurn.push({
                    specialist: data.specialist,
                    request: reqInput.request,
                    delegateMessageId: data.messageId,
                  });
                }
              }
            } catch (dispatchErr) {
              // Emit audit row even on throw so the trail is complete.
              memory.auditLog.insert({
                category: 'tool_call',
                actor_chat_id: chatId,
                session_id: sessionId,
                detail: {
                  tool: toolCall.name,
                  input_keys: Object.keys(
                    typeof toolCall.input === 'object' && toolCall.input !== null
                      ? (toolCall.input as Record<string, unknown>)
                      : {},
                  ).join(','),
                  ok: false,
                  outcome: null,
                  error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
                },
              });
              throw dispatchErr;
            }

            // Audit log: tool_call entry — emitted after dispatch so outcome is available.
            memory.auditLog.insert({
              category: 'tool_call',
              actor_chat_id: chatId,
              session_id: sessionId,
              detail: {
                tool: toolCall.name,
                input_keys: Object.keys(
                  typeof toolCall.input === 'object' && toolCall.input !== null
                    ? (toolCall.input as Record<string, unknown>)
                    : {},
                ).join(','),
                ok: result.ok,
                outcome: result.data && typeof result.data === 'object' && 'outcome' in result.data
                  ? (result.data as Record<string, unknown>)['outcome'] ?? null
                  : null,
              },
            });

            // Persist tool result
            memory.messages.insert({
              session_id: sessionId,
              role: 'tool',
              tool_name: toolCall.name,
              tool_output: result.output,
              tool_use_id: toolCall.id,
            });

            toolResultBlocks.push({
              type: 'tool_result',
              tool_call_id: toolCall.id,
              content: result.output,
            });
          }

          // Append tool results as a user message with blocks
          workingMessages.push({
            role: 'user',
            blocks: toolResultBlocks,
          });

          continue;
        }

        turnLog.warn(
          { stopReason: response.stop_reason, iteration },
          'Unexpected stop_reason',
        );
        break;
      }
      // (inner iteration for-loop closes above)

       // v1.22.43 — Assemble-mode cost guard. When a specialist exhausts the
       // tool loop while running in /avengers assemble, do NOT escalate to
       // Claude. The whole reason specialists run on Ollama Cloud is to keep
       // costs predictable (~$300/yr ceiling); a Sonnet escalation per
       // specialist per hard prompt blows that budget for one task. Instead
       // we let the turn end with the partial reply the specialist already
       // produced. The orchestrator can still see whatever they posted; the
       // debate footer (if enabled) will surface incompleteness.
       const isAssembleSpecialist =
         botIdentity?.scope === 'specialist' &&
         isGroupMode &&
         memory.groupSettings.getAvengersModes(chatId).assemble;

       // Log + audit the cost-guard skip so we can see how often it triggers.
       if (isAssembleSpecialist && !escalated && routing.provider !== config.ai.premiumProvider) {
         turnLog.warn(
           {
             botName: botIdentity?.name,
             toolCallCount,
             maxIterations,
             model: routing.model,
           },
           'assemble-mode cost guard: skipping Claude escalation, returning partial result',
         );
         memory.auditLog.insert({
           category: 'agent.escalation',
           actor_chat_id: chatId,
           session_id: sessionId,
           detail: {
             fromProvider: routing.provider,
             fromModel: routing.model,
             toProvider: 'none-skipped',
             toModel: 'none-skipped',
             toolCallCount,
             maxIterations,
             reason: 'assemble-cost-guard',
           },
         });
       }

       // Inner loop exhausted without end_turn. Escalate to premium once —
       // unless we're an assemble-mode specialist (cost guard above).
       if (!escalated && routing.provider !== config.ai.premiumProvider && !isAssembleSpecialist) {
         escalated = true;
         turnLog.error(
           {
             fromProvider: routing.provider,
             fromModel: routing.model,
             toProvider: config.ai.premiumProvider,
             toModel: config.ai.premiumModel,
             toolCallCount,
             maxIterations,
           },
           'PREMIUM TOKENS — loop exhausted, escalating turn to Claude (premium)',
         );
         // Fix for MEDIUM (Scalability, 2026-04-23): record escalation as
         // a distinct audit event. /research --claude (Haiku) users need
         // visibility into how often their "cheap" runs are silently
         // finishing on Sonnet — cost attribution and rate monitoring
         // both depend on this signal being counted.
         memory.auditLog.insert({
           category: 'agent.escalation',
           actor_chat_id: chatId,
           session_id: sessionId,
           detail: {
             fromProvider: routing.provider,
             fromModel: routing.model,
             toProvider: config.ai.premiumProvider,
             toModel: config.ai.premiumModel,
             toolCallCount,
             maxIterations,
             reason: 'loop-exhaustion',
           },
         });

         // v1.22.31 — surface loop-exhaustion escalation in chat (throttled).
         // Prior behavior was silent: only an audit row + warn log. The
         // user paid for Claude tokens with no visibility. Now we send the
         // same throttled "Premium tokens in use" notice that callWithFallback
         // sends on provider errors, so all Claude-burning paths are loud.
         const now = Date.now();
         const lastNoticeMs = claudeFallbackLastNotice.get(chatId) ?? 0;
         const throttled = now - lastNoticeMs < CLAUDE_FALLBACK_NOTICE_THROTTLE_MS;
         if (!throttled && telegram) {
           claudeFallbackLastNotice.set(chatId, now);
           void telegram
             .sendMessage(
               chatId,
               `⚠️ <b>Premium tokens in use.</b> ${botIdentity?.name ?? 'agent'} got stuck in a tool loop on <code>${routing.model}</code> (${toolCallCount} iterations); restarting on Claude (<code>${config.ai.premiumModel}</code>) to finish the turn.\n\n<i>Throttled to one notice per 5 min per chat. Audit category: agent.escalation.</i>`,
               { parseMode: 'HTML' },
             )
             .catch(() => undefined);
         }
         routing = {
           provider: config.ai.premiumProvider,
           model: config.ai.premiumModel,
           reason: 'escalated-from-loop-exhaustion',
         };
         // Reset working buffer to the original turn state so the premium
         // model gets a clean attempt, not the tool-call-spam history.
         workingMessages = [...unifiedMessages];
         toolCallCount = 0;
         continue escalation_loop;
       }

       break escalation_loop;
      } // end escalation_loop

      // Loop exhausted (already escalated or started on premium)
      const errorMsg =
        `I reached the maximum number of tool calls (${maxIterations}) for this request` +
        (escalated ? ' even after escalating to the premium model' : '') +
        `. The task may be too complex or is caught in a loop. Please try breaking it into smaller steps.`;

      memory.messages.insert({
        session_id: sessionId,
        role: 'assistant',
        content: errorMsg,
      });

      turnLog.warn({ maxIterations, toolCallCount, escalated }, 'Agent loop exhausted');
      return { replyText: errorMsg, toolCalls: toolCallCount };
    },

    async runConfirmedCommand(params): Promise<TurnResult> {
      const { chatId, sessionId, command, shell, args, abortSignal } = params;
      const cmdLog = log.child({ chatId, sessionId, component: 'agent.confirmed' });
      cmdLog.info({ command, shell }, 'Executing pre-confirmed command');

      // v1.21.0 Item 6 — SSOT factory ensures botIdentity is populated for the
      // dispatcher's per-bot allowlist gate (run_command is NOT in specialist
      // allowlist; ai-tony hitting this path is rejected at the gate).
      const toolCtx = buildToolContext({
        botIdentity,
        sessionId,
        chatId,
        logger: cmdLog,
        config,
        memory,
        safety,
        abortSignal,
        // telegram not needed for run_command (confirmed command path)
      });

      const result = await dispatch('run_command', { command, shell, args }, toolCtx);

      memory.messages.insert({
        session_id: sessionId,
        role: 'assistant',
        content: result.output,
      });
      memory.sessions.touchLastActive(sessionId, chatId);

      return { replyText: result.output, toolCalls: 1 };
    },

    async runDebateForStep(params) {
      // v1.22.35 — debate-for-accuracy. Imported lazily so test mocks that
      // construct a minimal agent without a full file-system don't break.
      const { runSpecialistDebate } = await import('../avengers/debate.js');
      const { BOT_MODEL_BY_NAME } = await import('../config/botIdentity.js');

      const specialistBotName = params.specialistBotName as keyof typeof BOT_MODEL_BY_NAME;
      const specialistModel = BOT_MODEL_BY_NAME[specialistBotName];
      const criticModel = BOT_MODEL_BY_NAME['ai-jarvis'];
      if (!specialistModel) {
        throw new Error(`runDebateForStep: unknown bot name "${params.specialistBotName}"`);
      }

      const specialistPersonaPath = path.resolve(
        process.cwd(),
        'config',
        'personas',
        `${params.specialistBotName}.md`,
      );
      const criticPersonaPath = path.resolve(
        process.cwd(),
        'config',
        'personas',
        'ai-jarvis-critic.md',
      );

      const displayMap: Record<string, string> = {
        'ai-tony': 'Tony',
        'ai-natasha': 'Natasha',
        'ai-bruce': 'Bruce',
        'ai-jarvis': 'Jarvis',
      };

      return await runSpecialistDebate({
        initialDraft: params.initialDraft,
        request: params.request,
        specialistDisplayName: displayMap[params.specialistBotName] ?? params.specialistBotName,
        specialistPersonaPath,
        specialistModel,
        criticPersonaPath,
        criticModel,
        ollamaProvider,
        abortSignal: params.abortSignal,
        logger: log,
        onRoundComplete: params.onRoundComplete,
      });
    },
  };
}

// Re-export UnifiedToolCall for any downstream consumers
export type { UnifiedToolCall };
