/** Telegram gateway: grammY bot setup, allowlist enforcement, per-chat queuing, command routing, and health endpoint. */

import { Bot, type Context } from 'grammy';
import type pino from 'pino';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { SafetyApi, PendingAction } from '../safety/index.js';
import type { AgentApi } from '../agent/index.js';
import type { Transcriber } from '../transcriber/index.js';
import type { SchedulerApi } from '../scheduler/index.js';
import { createAllowlistMiddleware } from './allowlist.js';
import { checkGroupActivation, isGroupChat } from './groupGate.js';
import {
  recordBotSpoke,
  setPending,
  clearPending,
} from './groupState.js';
import type { RecentMessage } from './intent.js';
import { handleJarvisIntent } from '../commands/jarvisIntent.js';
import {
  parseConfirmSend,
  inspectToken,
  hashEmailContent,
} from '../safety/emailConfirmation.js';
import { loadGoogleAuth } from '../google/oauth.js';
import { GmailApi } from '../google/gmail.js';
import { ChatQueueManager } from './chatQueue.js';
import {
  handleStart,
  handleStatus,
  handleStop,
  handleProjects,
  handleHistory,
  handleClear,
  handleHelp,
  type CommandDeps,
} from './commands.js';
import { handleModel, type ModelCommandDeps } from '../commands/model.js';
import { handleCost, type CostCommandDeps } from '../commands/cost.js';
import { handleVoice } from '../commands/voice.js';
import { handleVision } from '../commands/vision.js';
import { handleCalendar } from '../commands/calendar.js';
import { handleMemory, type MemoryCommandDeps } from '../commands/memory.js';
import { handleOrganize, handleReconcileCallback, type OrganizeCommandDeps } from '../commands/organize.js';
import {
  handleCoachOnTopLevel,
  handleCoachOffTopLevel,
  handleCoachStatus,
  handleCoachBackOff,
  handleCoachPush,
  handleCoachDefer,
  handleCoachHelp,
  type CoachSubcommandCtx,
} from '../commands/coachSubcommands.js';
import { handleAvengersCommand } from '../commands/avengers.js';
import { handleScheduled, type ScheduledCommandDeps } from '../commands/scheduled.js';
import type { RemindersApi } from '../organize/reminders.js';
import { handleSkillInvocation, handlePlanButton, type PlanCommandDeps } from '../commands/plan.js';
import { researchSkill } from '../skill/research.js';
import { fixSkill } from '../skill/fix.js';
import { buildSkill } from '../skill/build.js';
import {
  handleJarvisRoles,
  handleJarvisDevAdd,
  handleJarvisDevRemove,
  handleJarvisAdminAdd,
  handleJarvisAdminRemove,
  handleJarvisAlias,
  defaultConfigPath,
  type JarvisRolesDeps,
} from '../commands/jarvisRoles.js';
import { handleDebate } from '../commands/debate.js';
import { handleWebApp } from '../commands/webapp.js';
import { runDebate, isDebateEnabled, getDebateRounds, getDebateExchanges, type DebatePersistenceHook, type DebateRoundHookEvent } from '../debate/index.js';
import { debateEventBus } from '../debate/eventbus.js';
import { randomUUID } from 'node:crypto';
import { scrub } from '../safety/scrubber.js';
import { renderDebateSummary, renderDebateDetail, renderDebateButtons } from '../debate/panelRender.js';
import { createPanelRegistry } from './progressPanel.js';
import type { DebateState } from '../debate/index.js'; // used for initialState + panel type
import { createClaudeClient } from '../providers/claude.js';
import { initTts, isVoiceEnabled, TTS_MAX_CHARS } from '../tts/index.js';
import { createStreamingReply } from './streamingReply.js';
import { initVision, detectMode, isVisionEnabled, type Vision } from '../vision/index.js';
import { buildFrameGridPng, FfmpegMissingError } from '../vision/gridFromVideo.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { handleSearch, type SearchCommandDeps } from '../commands/search.js';
import { handleCompact, type CompactCommandDeps } from '../commands/compact.js';
import { ClaudeProvider } from '../providers/claude.js';
import { OllamaCloudProvider } from '../providers/ollama-cloud.js';
import type { ModelProvider } from '../providers/types.js';
import {
  handleJarvisEnable,
  handleJarvisDisable,
  handleJarvisUsers,
  handleJarvisLimit,
  type GroupAdminDeps,
} from '../commands/groupAdmin.js';
import { handleAudit, type AuditCommandDeps } from '../commands/audit.js';
import { transcribeTelegramVoice } from './voice.js';
import { createHealthServer, type HealthServer } from './health.js';
import { createWebappServer } from '../webapp/server.js';
import { htmlEscape } from './html.js';
import { markdownToTelegramHtml } from '../messaging/markdownToHtml.js';
import { splitForTelegram } from '../messaging/splitForTelegram.js';
import { humanPaceDelayMs, sleepWithTyping } from './humanPace.js';
import { createTelegramAdapter } from './telegramAdapter.js';
import { wrapAdapterWithSelfMessageRecording } from './selfMessageRecorder.js';
import { maybeWrapBotHistoryEntry } from './interBotContext.js';
import {
  checkBotToBotLoop,
  recordBotToBotTurn,
  markThreadStopped,
  markThreadSustained,
  isThreadSustained,
  STOP_KEYWORDS_REGEX,
  SUSTAINED_BANTER_REGEX,
  resetBotToBotCounterOnUserMessage,
  deriveThreadKey,
} from './loopProtection.js';
import { SELF_MESSAGE_TTL_MS } from '../memory/botSelfMessages.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import { child } from '../logger/index.js';
import {
  buildCoachTurnArgs,
  expandCoachPromptToken,
  COACH_PROMPT_PLACEHOLDER,
} from '../coach/index.js';
import type { TriggerRecord } from '../coach/triggerFiring.js';
import { recordCoachDM } from '../coach/rateLimits.js';
import {
  type BotIdentity,
  BOT_NAMES,
  BOT_TELEGRAM_USERNAMES,
} from '../config/botIdentity.js';
import { AvengersPlanLifecycle } from '../avengers/lifecycle.js';
import { writeTranscript, consumeTranscript } from '../avengers/debateTransport.js';
import { detectNamedSpecialists } from '../avengers/detectNamedSpecialists.js';
import { readGroupState, renderGroupStateBlock } from '../avengers/groupStateBridge.js';

const log = child({ component: 'gateway' });

export interface GatewayDeps {
  config: AppConfig;
  logger: pino.Logger;
  memory: MemoryApi;
  safety: SafetyApi;
  agent: AgentApi;
  transcriber: Transcriber;
  scheduler?: SchedulerApi;
  version: string;
  /**
   * v1.21.0 D7 — multi-bot mention routing.
   * When provided, the mention router in groupGate.ts uses this identity
   * to decide if THIS bot is the message's addressee (instead of the
   * legacy "jarvis" keyword check). When absent, legacy path runs unchanged.
   */
  botIdentity?: BotIdentity;
}

export interface GatewayApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Expose the queue manager so the scheduler can enqueue scheduler-originated turns.
   */
  enqueueSchedulerTurn(params: {
    chatId: number;
    taskId: number;
    description: string;
    command: string;
    /**
     * v1.10.0: task owner's userId. Null for legacy (pre-v1.10.0) rows.
     * When non-null, `agent.turn` receives `userId: ownerUserId` so
     * /organize + /memory tools can operate per-user. Null passes through
     * as `userId: undefined` and the tools return NO_USER_ID.
     */
    ownerUserId: number | null;
    /**
     * v1.18.0 ADR 018 D3.a (CRIT fix — convergent: cross-review I1+I2,
     * Anti-Slop F1, Scalability CRITICAL-1.18.0.A): when present, marks
     * this scheduled turn as a coach run. The gateway forwards `isCoachRun:
     * true` to `agent.turn()`, which initializes ToolContext.coachTurnCounters
     * so coach_log_* per-turn caps + the dispatcher's UNAUTHORIZED_IN_CONTEXT
     * gate (R6/F1 disabledTools enforcement) actually fire.
     *
     * Without this plumbing, coach turns in production silently bypass
     * BOTH safeguards even though the scheduler populates the field — the
     * gateway used to drop it before reaching agent.turn(). Field name
     * `writes` (NOT `totalWrites`) matches ToolContext + coachTools.
     */
    coachTurnCounters?: { nudges: number; writes: number };
  }): void;
  /**
   * v1.9.0 — expose the messaging adapter so reminders can deliver nudges.
   * Set once at boot before reminders are initialized.
   */
  readonly adapter: MessagingAdapter;
  /**
   * v1.9.0 — late-bind the reminders API after it is constructed with the
   * adapter. Avoids a circular-init dependency (gateway needs adapter to build
   * reminders; reminders need to be injected back into gateway for the hook).
   */
  setReminders(r: RemindersApi | null): void;
  /**
   * v1.10.0 — late-bind the scheduler API so the /scheduled command can
   * trigger immediate reload after pause/resume/delete. Mirrors setReminders
   * — the scheduler is built AFTER the gateway (so it can enqueue through
   * gateway.enqueueSchedulerTurn), so we inject it back in afterward.
   */
  setScheduler(s: SchedulerApi | null): void;
  /**
   * v1.20.0 ADR 020 D7 — fire a spontaneous coach turn from an event trigger.
   *
   * Called by dispatchTrigger after all rate-limit + quiet-mode checks pass.
   * Loads the coach prompt, expands ${trigger_context} with the trigger metadata,
   * then enqueues a scheduler-priority coach turn via the per-chat queue.
   *
   * Uses buildCoachTurnArgs({ isSpontaneousTrigger: true, triggerContext })
   * as the single source of truth for the three load-bearing flags.
   *
   * FORBIDDEN: must not be called from coach/** or monitor modules.
   * The gateway provides this function; it is injected into TriggerFireDeps at boot.
   */
  fireSpontaneousCoachTurn(trigger: TriggerRecord): Promise<void>;
}

const PROCESS_START = Date.now();

/**
 * Build the gateway: grammY bot with allowlist middleware, command router,
 * per-chat queues, voice handling, and localhost health endpoint.
 */
export function initGateway(deps: GatewayDeps): GatewayApi {
  const { config, memory, safety, agent, transcriber, version, botIdentity } = deps;

  // v1.20.0 Scalability CRIT-A producer-side wiring: resolve dataDir for
  // recordCoachDM calls in coach send paths (D10 30-min cooldown ledger).
  const gatewayDataDir = path.resolve(
    config.memory?.dbPath ? path.dirname(config.memory.dbPath) : 'data',
  );

  const bot = new Bot(config.telegram.botToken);
  // v1.21.0 R2 BLOCKING + Cross-review I1: wrap adapter so every outbound send
  // records (chatId, messageId) into bot_self_messages. The incoming-message
  // handler then drops self-echoes via isOurEcho.
  const baseTelegramAdapter = createTelegramAdapter(bot.api);
  const telegramAdapter = wrapAdapterWithSelfMessageRecording({
    base: baseTelegramAdapter,
    repo: memory.botSelfMessages,
    logger: log,
  });
  const tts = initTts();
  const vision: Vision = initVision(config);

  // v1.12.0 — panel registry for debate (and future) progress panels.
  // Pass telegramAdapter so the registry can use the platform-neutral editMessageReplyMarkup (R10).
  const panelRegistry = createPanelRegistry(config, telegramAdapter);

  // v1.22.19 — Avengers plan lifecycle. Only meaningful for the orchestrator
  // (full-scope) bot; specialists never create or update plans. Constructed
  // unconditionally so the gateway code can call it without scope guards;
  // the lifecycle methods themselves no-op when there's no active plan for
  // the chat (specialists hit those no-op paths).
  const avengersPlanLifecycle = botIdentity
    ? new AvengersPlanLifecycle({
        memory,
        botIdentity,
        bot: { api: bot.api },
        logger: log,
        config,
      })
    : null;

  // Claude client for the debate judge. Lazily initialized on first use —
  // a missing ANTHROPIC_API_KEY only matters when /debate is actually run.
  let debateClaude: ReturnType<typeof createClaudeClient> | null = null;

  /**
   * Run a multi-model debate for a user topic and manage it via a ProgressPanel.
   * v1.12.0: replaces the old sendMessage callback with panel state updates.
   */
  async function runDebateTurn(
    chatId: number,
    topic: string,
    ctx: { from?: { id?: number }; chat?: { type?: string; id?: number } },
  ): Promise<void> {
    if (!debateClaude) {
      try {
        debateClaude = createClaudeClient(config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await bot.api
          .sendMessage(chatId, `Debate needs Claude as the judge but: ${msg}`)
          .catch(() => {});
        return;
      }
    }

    const actorUserId = ctx.from?.id ?? 0;
    const rawChatType = ctx.chat?.type ?? 'private';
    const chatType: 'private' | 'group' | 'supergroup' | 'channel' =
      rawChatType === 'group' || rawChatType === 'supergroup' || rawChatType === 'channel'
        ? rawChatType
        : 'private';
    const maxRounds = getDebateRounds(chatId);
    const exchangesPerRound = getDebateExchanges(chatId);

    // R2 (MEDIUM): Concurrency cap — at most MAX_CONCURRENT_DEBATES_PER_USER running debates per user.
    // ADR 016 D2.c binding: v1.16.0 single-user posture; multi-user is v1.18.0+ Avengers concern.
    const MAX_CONCURRENT_DEBATES_PER_USER = 5; // R2 (MEDIUM from CP1 v1.16.0)
    const runningCount = memory.debateRuns.countRunning(actorUserId);
    if (runningCount >= MAX_CONCURRENT_DEBATES_PER_USER) {
      await bot.api
        .sendMessage(
          chatId,
          `You already have ${runningCount} debate${runningCount === 1 ? '' : 's'} running. ` +
            `Wait for one to complete or cancel one with /cancel.`,
        )
        .catch(() => {});
      return;
    }

    // v1.16.0 D6: Generate debate run UUID and build persistence hook.
    const debateRunId = randomUUID();

    const persistenceHook: DebatePersistenceHook = {
      async onStart(state) {
        // Build model lineup from roster (available via state.roster after runDebate sets it)
        const modelLineupJson = JSON.stringify(
          state.roster.map((modelName) => ({ debaterName: modelName, modelName, providerName: 'ollama' })),
        );
        memory.debateRuns.create({
          id: debateRunId,
          userId: actorUserId,
          topic: state.topic,
          modelLineupJson,
          participantCount: state.roster.length,
          roundsTarget: state.totalRounds,
        });
        debateEventBus.publish(debateRunId, { type: 'snapshot', state });
      },
      async onRound(round: DebateRoundHookEvent) {
        memory.debateRounds.append({
          debateRunId,
          roundNumber: round.roundNumber,
          debaterName: round.debaterName,
          modelName: round.modelName,
          content: round.content,
        });
        // Update rounds_completed counter
        memory.debateRuns.update(debateRunId, { roundsCompleted: round.roundNumber });
        debateEventBus.publish(debateRunId, {
          type: 'round',
          round: {
            roundNumber: round.roundNumber,
            debaterName: round.debaterName,
            modelName: round.modelName,
            content: round.content,
            ts: round.ts,
          },
        });
      },
      async onVerdict(verdict, reasoning) {
        memory.debateRuns.update(debateRunId, {
          status: 'complete',
          verdictJson: JSON.stringify(verdict),
          reasoning: reasoning ?? undefined,
        });
        debateEventBus.publish(debateRunId, {
          type: 'verdict',
          verdict: {
            kind: verdict.kind,
            summary: verdict.summary,
            decision: verdict.decision,
            rationale: verdict.rationale,
            dissent: verdict.dissent,
          },
        });
      },
      async onAbort(reason) {
        memory.debateRuns.update(debateRunId, {
          status: 'aborted',
          abortReason: reason,
        });
        debateEventBus.publish(debateRunId, { type: 'error', reason });
      },
    };

    const abortController = new AbortController();

    // Scrub the topic at the entry point so the initial panel frame never exposes
    // credentials to Telegram. runDebate scrubs again at state construction (idempotent).
    const scrubbedTopic = scrub(topic);

    // Build initial state for panel creation
    const initialState: DebateState = {
      status: 'starting',
      topic: scrubbedTopic,
      roster: [],
      currentRound: 0,
      totalRounds: maxRounds,
      currentModel: null,
      transcript: [],
      verdict: null,
      cancelled: false,
      startedAt: Date.now(),
      endedAt: null,
      exchangesPerRound,
    };

    let panel;
    try {
      panel = await panelRegistry.create<DebateState>(
        {
          adapter: telegramAdapter,
          chatId,
          ownerUserId: actorUserId,
          callbackNamespace: 'debate',
          componentTag: 'debate',
          renderSummary: renderDebateSummary,
          renderDetail: renderDebateDetail,
          renderButtons: renderDebateButtons,
          extraActions: {
            cancel: async (_callbackCtx, _state) => {
              abortController.abort('user-cancelled');
            },
          },
        },
        initialState,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ chatId, err: msg }, 'Failed to create debate panel');
      await bot.api.sendMessage(chatId, `Debate error: ${msg}`).catch(() => {});
      return;
    }

    try {
      await runDebate({
        topic: scrubbedTopic,
        maxRounds,
        exchangesPerRound,
        panel,
        ollama: ollamaProvider,
        claudeClient: debateClaude,
        judgeModel: config.ai.judgeModel,
        abortSignal: abortController.signal,
        chatType: chatType as 'private' | 'group' | 'supergroup' | 'channel',
        config,
        adapter: telegramAdapter,
        chatId,
        memory,
        actorUserId,
        persistenceHook,
        debateRunId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ chatId, err: msg }, 'Debate failed');
      await bot.api.sendMessage(chatId, `Debate error: ${msg}`).catch(() => {});
    }
  }

  /**
   * Send a TTS voice note for a reply if voice is enabled for this chat.
   * Strips markdown/HTML before synthesis and swallows all errors — voice
   * is a bonus, it must never break the text reply.
   */
  async function maybeSendVoice(chatId: number, replyText: string): Promise<void> {
    if (!isVoiceEnabled(chatId)) return;
    const stripped = replyText
      .replace(/<[^>]+>/g, '')            // HTML tags
      .replace(/\*\*(.+?)\*\*/g, '$1')    // bold
      .replace(/\*(.+?)\*/g, '$1')        // italic (markdown)
      .replace(/_(.+?)_/g, '$1')          // italic (underscore)
      .replace(/`([^`]+)`/g, '$1')        // inline code
      .replace(/```[\s\S]*?```/g, '')     // code blocks — skip, too long to speak
      .trim();
    if (!stripped) return;
    if (stripped.length > TTS_MAX_CHARS * 2) return; // skip very long replies
    try {
      const { filePath } = await tts.synthesize(stripped);
      try {
        await telegramAdapter.sendVoice(chatId, filePath);
      } finally {
        try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      }
    } catch (err) {
      log.warn(
        { chatId, err: err instanceof Error ? err.message : String(err) },
        'TTS reply failed',
      );
    }
  }
  const queueManager = new ChatQueueManager(config, log);
  const healthServer: HealthServer = createHealthServer(config, version);

  // v1.15.0 D9: botUsername cached at start() via getMe(); exposed to the
  // webapp server so /api/webapp/config can return the dynamic channel name.
  let botUsername = '';

  const webappServer = createWebappServer({
    config,
    version,
    logger: log,
    memory,
    getBotUsername: () => botUsername,
  });

  // v1.9.0 — late-bound reminders API (set after initReminders via gateway.setReminders)
  let remindersApi: RemindersApi | null = null;

  // Providers for /compact command
  const claudeProvider = new ClaudeProvider(config);
  const ollamaProvider = new OllamaCloudProvider();

  function getProviderForGateway(providerName: string): ModelProvider {
    if (providerName === 'claude') return claudeProvider;
    return ollamaProvider;
  }

  /**
   * Classifier context fetcher (v1.7.13). Returns the last N user+assistant
   * messages for the chat's session in chronological order, each truncated
   * to 200 chars to keep the classifier prompt small. Non-agent-activated
   * messages aren't in the session's history, so this reflects the
   * Jarvis-visible conversation — which is the right signal.
   */
  function getRecentForChat(chatId: number, n: number): RecentMessage[] {
    if (n <= 0) return [];
    const session = memory.sessions.getOrCreate(chatId);
    const rows = memory.messages.listRecent(session.id, n);
    return rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({
        from: r.role === 'user' ? 'User' : 'Jarvis',
        text: (r.content ?? '').slice(0, 200),
      }));
  }

  const compactCmdDeps: CompactCommandDeps = {
    config,
    memory,
    claudeProvider,
    getProvider: getProviderForGateway,
  };

  // Bot's own user ID — cached after getMe() at startup
  let botUserId = 0;

  const cmdDeps: CommandDeps = {
    config,
    memory,
    queueManager,
    processStart: PROCESS_START,
    version,
  };

  const modelCmdDeps: ModelCommandDeps = {
    config,
    memory,
    // v1.23.3 — pass botIdentity so /model shows the correct per-bot model
    // (BOT_MODEL_BY_NAME) instead of the global config default.
    ...(botIdentity ? { botIdentity } : {}),
  };
  const costCmdDeps: CostCommandDeps = { config, memory };
  const searchCmdDeps: SearchCommandDeps = { config, memory, safety };
  const groupAdminDeps: GroupAdminDeps = {
    config,
    groupActivity: memory.groupActivity,
    groupSettings: memory.groupSettings,
    auditLog: memory.auditLog,
  };
  const auditCmdDeps: AuditCommandDeps = { config, memory };
  const planCmdDeps: PlanCommandDeps = {
    config,
    memory,
    agent: deps.agent,
    adapter: telegramAdapter,
    ollama: ollamaProvider,
  };

  // Wire scheduler-drop notifications to Telegram
  queueManager.setOnSchedulerDrop((chatId, description) => {
    void bot.api
      .sendMessage(chatId, `⚠️ Dropped scheduled task: ${description} (queue full)`)
      .catch((err: unknown) => {
        log.error(
          { chatId, err: err instanceof Error ? err.message : String(err) },
          'Failed to send scheduler-drop notification',
        );
      });
  });

  // Global error handler: prevent formatting errors (e.g., HTML/Markdown entity
  // parse failures) from crashing the process. Best-effort plain-text fallback.
  bot.catch((err) => {
    const chatId = err.ctx.chat?.id;
    const message = err.error instanceof Error ? err.error.message : String(err.error);
    log.error(
      { chatId, update: err.ctx.update.update_id, err: message },
      'Gateway handler error',
    );
    if (chatId !== undefined) {
      void bot.api
        .sendMessage(chatId, `Error: ${message}`)
        .catch((e: unknown) => {
          log.error(
            { chatId, err: e instanceof Error ? e.message : String(e) },
            'Failed to send fallback error message',
          );
        });
    }
  });

  // Allowlist middleware — applied first, before any handlers
  bot.use(createAllowlistMiddleware(config));

  // Command handlers
  bot.command('start', async (ctx) => handleStart(ctx, cmdDeps));
  bot.command('status', async (ctx) => {
    // V-02: admin-gate /status in group mode (leaks hostname, system info)
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (!config.groups.adminUserIds.includes(userId ?? -1)) {
        await ctx.reply('Admin only.').catch(() => {});
        return;
      }
    }
    return handleStatus(ctx, cmdDeps);
  });
  bot.command('stop', async (ctx) => {
    // V-02: admin-gate /stop in group mode
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (!config.groups.adminUserIds.includes(userId ?? -1)) {
        await ctx.reply('Admin only.').catch(() => {});
        return;
      }
    }
    return handleStop(ctx, cmdDeps);
  });
  bot.command('projects', async (ctx) => {
    // V-04: admin-gate /projects in group mode
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (!config.groups.adminUserIds.includes(userId ?? -1)) {
        await ctx.reply('Admin only.').catch(() => {});
        return;
      }
    }
    return handleProjects(ctx, cmdDeps);
  });
  bot.command('history', async (ctx) => {
    // V-03: admin-gate /history in group mode; also use session-scoped history
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (!config.groups.adminUserIds.includes(userId ?? -1)) {
        await ctx.reply('Admin only.').catch(() => {});
        return;
      }
    }
    return handleHistory(ctx, cmdDeps);
  });
  bot.command('clear', async (ctx) => {
    // V-02: admin-gate /clear in group mode (clears shared session)
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (!config.groups.adminUserIds.includes(userId ?? -1)) {
        await ctx.reply('Admin only.').catch(() => {});
        return;
      }
    }
    return handleClear(ctx, cmdDeps);
  });
  bot.command('help', async (ctx) => handleHelp(ctx, cmdDeps));
  bot.command('model', async (ctx) => {
    // In group mode, /model is admin-only
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (!config.groups.adminUserIds.includes(userId ?? -1)) {
        await ctx.reply('Admin only.').catch(() => {});
        return;
      }
    }
    return handleModel(ctx, modelCmdDeps);
  });
  bot.command('cost', async (ctx) => handleCost(ctx, costCmdDeps));
  bot.command('voice', async (ctx) => handleVoice(ctx));
  bot.command('vision', async (ctx) => handleVision(ctx));
  bot.command('calendar', async (ctx) => handleCalendar(ctx));
  const memoryDeps: MemoryCommandDeps = { config };
  bot.command('memory', async (ctx) => handleMemory(ctx, memoryDeps));
  // v1.11.0: memory added to organizeDeps for /organize reconcile + /organize nag cost.
  // v1.18.0 P2 fix Item 3: scheduler late-bound for /organize coach setup|off so
  // scheduler.reload() picks up the new/deleted coach task without a pm2 restart.
  const organizeDeps: OrganizeCommandDeps = { config, reminders: null, memory, scheduler: deps.scheduler ?? null };
  bot.command('organize', async (ctx) => {
    // Keep organizeDeps.reminders + scheduler in sync with the live values.
    organizeDeps.reminders = remindersApi;
    organizeDeps.scheduler = deps.scheduler ?? null;
    return handleOrganize(ctx, organizeDeps);
  });
  // v1.19.0 D2: /coach — top-level chat commands for coach on/off/status.
  // Aliases for /organize coach setup|off; keeps the UX clean.
  // ADR 019 Decision 2.
  bot.command('coach', async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const chatId = ctx.chat?.id ?? 0;
    const text = ctx.message?.text ?? '';
    const afterCommand = text.replace(/^\/coach\s*/i, '').trim();
    const parts = afterCommand.split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? '';
    const arg = parts[1];

    const coachCtx: CoachSubcommandCtx = {
      ctx,
      userId,
      chatId,
      memory,
      config,
      scheduler: deps.scheduler ?? null,
    };

    if (sub === 'on') {
      return handleCoachOnTopLevel(coachCtx, arg);
    } else if (sub === 'off') {
      return handleCoachOffTopLevel(coachCtx);
    } else if (sub === 'status') {
      return handleCoachStatus(coachCtx);
    } else if (sub === 'back-off' || sub === 'back_off') {
      // /coach back-off <item-or-keyword>
      const itemRef = parts.slice(1).join(' ');
      return handleCoachBackOff(coachCtx, itemRef);
    } else if (sub === 'push') {
      const itemRef = parts.slice(1).join(' ');
      return handleCoachPush(coachCtx, itemRef);
    } else if (sub === 'defer') {
      const itemRef = parts.slice(1).join(' ');
      return handleCoachDefer(coachCtx, itemRef);
    } else if (sub === '' || sub === 'help') {
      return handleCoachHelp(ctx);
    } else {
      await ctx.reply(
        `Unknown /coach subcommand "${sub}". ` +
          `Use /coach on, /coach off, /coach status, /coach back-off <item>, /coach push <item>, /coach defer <item>. ` +
          `For advanced setup: /organize coach setup [HH:MM].`,
      ).catch(() => {});
    }
  });

  // v1.10.0: /scheduled — manage recurring scheduled tasks.
  // schedulerApi is late-bound via setScheduler() after the scheduler is
  // constructed (chicken-and-egg: scheduler needs gateway.enqueueSchedulerTurn,
  // gateway needs scheduler for /scheduled's reload path). Mirrors setReminders.
  const scheduledDeps: ScheduledCommandDeps = {
    config,
    memory,
    schedulerApi: deps.scheduler ?? null,
  };
  bot.command('scheduled', async (ctx) => handleScheduled(ctx, scheduledDeps));

  // v1.22.1 — /avengers chat|assemble|status — toggle multi-bot collaboration
  // modes per chat. Admin-only. See src/commands/avengers.ts.
  bot.command('avengers', async (ctx) => {
    const userId = ctx.from?.id ?? 0;
    const chatId = ctx.chat?.id ?? 0;
    const text = ctx.message?.text ?? '';
    const afterCommand = text.replace(/^\/avengers\s*/i, '').trim();
    const parts = afterCommand.split(/\s+/);
    const sub = (parts[0] ?? '').toLowerCase();
    const arg = parts[1]?.toLowerCase();
    return handleAvengersCommand({ ctx, userId, chatId, memory, config }, sub, arg);
  });
  bot.command('research', async (ctx) => handleSkillInvocation(ctx, planCmdDeps, researchSkill));
  bot.command('plan', async (ctx) => handleSkillInvocation(ctx, planCmdDeps, researchSkill)); // alias for muscle memory
  bot.command('fix', async (ctx) => handleSkillInvocation(ctx, planCmdDeps, fixSkill));
  bot.command('build', async (ctx) => handleSkillInvocation(ctx, planCmdDeps, buildSkill));

  // Inline button handler — routes taps on plan panel buttons to the
  // appropriate action (cancel / resend report / rerun with Sonnet).
  // v1.11.0: also routes rec:* callbacks for /organize reconcile.
  // answerCallbackQuery always fires so the button's spinner stops.
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    try {
      if (data.startsWith('plan.')) {
        const toast = await handlePlanButton(data, ctx, planCmdDeps);
        await ctx.answerCallbackQuery({ text: toast }).catch(() => {});
      } else if (data.startsWith('rec:')) {
        // v1.11.0 — reconcile callback. Passes config + memory directly.
        try {
          const result = await handleReconcileCallback(data, ctx, { config, memory });
          await ctx.answerCallbackQuery({ text: result.toast }).catch(() => {});
        } catch (err) {
          log.error(
            { data, err: err instanceof Error ? err.message : String(err) },
            'reconcile callback handler threw',
          );
          await ctx.answerCallbackQuery({ text: 'Reconcile failed.' }).catch(() => {});
        }
      } else if (data.startsWith('debate.')) {
        // v1.12.0 — debate panel callbacks. Delegates to panel registry.
        try {
          await panelRegistry.handleCallback(data, ctx);
        } catch (err) {
          log.error(
            { data, err: err instanceof Error ? err.message : String(err) },
            'debate callback handler threw',
          );
          await ctx.answerCallbackQuery({ text: 'Callback failed.' }).catch(() => {});
        }
      } else {
        await ctx.answerCallbackQuery({ text: 'Unknown button.' }).catch(() => {});
      }
    } catch (err) {
      log.warn(
        { data, err: err instanceof Error ? err.message : String(err) },
        'callback_query handler threw',
      );
      await ctx.answerCallbackQuery({ text: 'Error.' }).catch(() => {});
    }
  });
  bot.command('debate', async (ctx) => handleDebate(ctx));

  // v1.13.0 — /webapp: send a Telegram Mini App button (DM-only).
  bot.command('webapp', async (ctx) => {
    await handleWebApp(ctx, { config, adapter: telegramAdapter });
  });

  // v1.14.0 — web_app_data handler: intentionally minimal (no-op).
  //
  // v1.13.0 had a ping → pong auto-reply for skeleton round-trip testing.
  // v1.14.0 hub conversion removes the ping flow (ADR 009 R12.3 + R5).
  // The bot.on() registration is PRESERVED so v1.14.1+ can drop in typed
  // sendData routing (e.g. {kind: 'complete-item', id} → organize_complete tool)
  // without needing to add a new bot.on() call.
  //
  // This handler must remain registered — tests/unit/gateway.webAppData.test.ts
  // verifies the registration as a prerequisite for v1.14.1+ work (R5).
  bot.on('message:web_app_data', async (ctx) => {
    const data = ctx.message?.web_app_data?.data ?? '';
    const userId = ctx.from?.id ?? 0;
    log.info({ userId, dataPreview: data.slice(0, 200) }, 'web_app_data received');
    // v1.14.1+ extension point: parse data as JSON, dispatch by
    // {kind: 'complete-item', id} → organize_complete tool, etc.
    void data; // no-op in v1.14.0
    void userId; // no-op in v1.14.0
  });

  bot.command('jarvis_intent', async (ctx) => handleJarvisIntent(ctx));

  // v1.7.5 role management — admin only
  const rolesDeps: JarvisRolesDeps = { config, configPath: defaultConfigPath(), memory };
  bot.command('jarvis_roles', async (ctx) => handleJarvisRoles(ctx, rolesDeps));
  bot.command('jarvis_dev_add', async (ctx) => handleJarvisDevAdd(ctx, rolesDeps));
  bot.command('jarvis_dev_remove', async (ctx) => handleJarvisDevRemove(ctx, rolesDeps));
  bot.command('jarvis_admin_add', async (ctx) => handleJarvisAdminAdd(ctx, rolesDeps));
  bot.command('jarvis_admin_remove', async (ctx) => handleJarvisAdminRemove(ctx, rolesDeps));
  bot.command('jarvis_alias', async (ctx) => handleJarvisAlias(ctx, rolesDeps));
  bot.command('search', async (ctx) => handleSearch(ctx, searchCmdDeps));
  bot.command('compact', async (ctx) => {
    // In group mode, admin-only
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (!config.groups.adminUserIds.includes(userId ?? -1)) {
        await ctx.reply('Admin only.').catch(() => {});
        return;
      }
    }
    return handleCompact(ctx, compactCmdDeps);
  });

  // /audit — admin-only, DM-only audit log viewer
  bot.command('audit', async (ctx) => handleAudit(ctx, auditCmdDeps));

  // Group admin commands — always registered, reject non-admins inside handler
  bot.command('jarvis_enable', async (ctx) => handleJarvisEnable(ctx, groupAdminDeps));
  bot.command('jarvis_disable', async (ctx) => handleJarvisDisable(ctx, groupAdminDeps));
  bot.command('jarvis_users', async (ctx) => handleJarvisUsers(ctx, groupAdminDeps));
  bot.command('jarvis_limit', async (ctx) => handleJarvisLimit(ctx, groupAdminDeps));

  // Image/animation handler — single-shot Claude vision describe (no agent loop).
  // Handles photos (JPEG/PNG), animations (GIF/MP4), and documents with image
  // mime types. The allowlist middleware above has already filtered unauthorized
  // chats. GIFs on Telegram arrive as message:animation — Claude sees the first
  // frame only.
  bot.on(
    ['message:photo', 'message:animation', 'message:document', 'message:sticker'],
    async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!isVisionEnabled(chatId)) return;
      const chatType = ctx.chat?.type;

      // Resolve the file_id + mime_type from whichever field is populated.
      // Document branch filters to image mime types only.
      let fileId: string | undefined;
      let mimeFromTelegram: string | undefined;
      if (ctx.message?.photo && ctx.message.photo.length > 0) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1]?.file_id;
        mimeFromTelegram = 'image/jpeg';
      } else if (ctx.message?.animation) {
        fileId = ctx.message.animation.file_id;
        mimeFromTelegram = ctx.message.animation.mime_type ?? 'image/gif';
      } else if (ctx.message?.document) {
        const doc = ctx.message.document;
        const mt = (doc.mime_type ?? '').toLowerCase();
        if (!mt.startsWith('image/')) return; // ignore non-image documents
        fileId = doc.file_id;
        mimeFromTelegram = mt;
      } else if (ctx.message?.sticker) {
        // Static stickers are WEBP (image); animated/video stickers are .tgs / .webm
        // which Claude can't handle — skip those silently.
        const s = ctx.message.sticker;
        if (s.is_animated || s.is_video) return;
        fileId = s.file_id;
        mimeFromTelegram = 'image/webp';
      }
      if (!fileId) return;

      // Group activation: require caption mention of "jarvis" or reply-to-bot
      if (chatType === 'group' || chatType === 'supergroup') {
        const caption = ctx.message?.caption ?? '';
        const repliedToBot = ctx.message?.reply_to_message?.from?.id === botUserId;
        if (!/\bjarvis\b/i.test(caption) && !repliedToBot) return;
      }

      try {
        await bot.api.sendChatAction(chatId, 'typing');
      } catch {
        // ignore
      }

      let tempInputPath: string | null = null;
      let tempGridPath: string | null = null;
      try {
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) {
          await ctx.reply("Couldn't download the image.");
          return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${bot.api.token}/${file.file_path}`;
        const resp = await fetch(fileUrl);
        if (!resp.ok) throw new Error(`image download HTTP ${resp.status}`);
        const bytes = Buffer.from(await resp.arrayBuffer());

        const pathLower = file.file_path.toLowerCase();
        const isAnimated =
          pathLower.endsWith('.mp4') ||
          pathLower.endsWith('.webm') ||
          pathLower.endsWith('.gif') ||
          (mimeFromTelegram ?? '').startsWith('video/') ||
          mimeFromTelegram === 'image/gif';

        let imageBase64: string;
        let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

        if (isAnimated) {
          // Write the clip to a temp file and build a 2x2 frame grid PNG.
          tempInputPath = path.join(
            os.tmpdir(),
            `jarvis-anim-${Date.now()}-${process.pid}${
              pathLower.endsWith('.webm')
                ? '.webm'
                : pathLower.endsWith('.gif')
                  ? '.gif'
                  : '.mp4'
            }`,
          );
          fs.writeFileSync(tempInputPath, bytes);
          tempGridPath = await buildFrameGridPng(tempInputPath);
          imageBase64 = fs.readFileSync(tempGridPath).toString('base64');
          mediaType = 'image/png';
        } else {
          imageBase64 = bytes.toString('base64');
          if (pathLower.endsWith('.png')) mediaType = 'image/png';
          else if (pathLower.endsWith('.webp')) mediaType = 'image/webp';
          else if (mimeFromTelegram === 'image/png') mediaType = 'image/png';
          else if (mimeFromTelegram === 'image/webp') mediaType = 'image/webp';
          else mediaType = 'image/jpeg';
        }

        const rawCaption = ctx.message?.caption ?? '';
        // Hint Claude that a grid is a time sequence from one animation.
        const caption = isAnimated
          ? `${rawCaption}\n\n(This is a 2x2 grid of 4 frames from an animated clip, in reading order: top-left → top-right → bottom-left → bottom-right. Treat it as motion over time.)`.trim()
          : rawCaption;
        const mode = detectMode(rawCaption);
        const reply = await vision.describe({ imageBase64, mediaType, caption, mode });

        try {
          await bot.api.sendMessage(chatId, htmlEscape(reply), { parse_mode: 'HTML' });
        } catch {
          await bot.api.sendMessage(chatId, reply);
        }
        await maybeSendVoice(chatId, reply);
      } catch (err) {
        if (err instanceof FfmpegMissingError) {
          log.error({ chatId, err: err.message }, 'ffmpeg missing for animation');
          await ctx
            .reply(
              "I can't read animated clips until ffmpeg is installed on the host. " +
                'Run `winget install ffmpeg` and restart me.',
            )
            .catch(() => {});
        } else {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ chatId, err: message }, 'Vision describe failed');
          await ctx.reply(`Vision error: ${message}`).catch(() => {});
        }
      } finally {
        for (const p of [tempInputPath, tempGridPath]) {
          if (p) {
            try {
              fs.unlinkSync(p);
            } catch {
              /* best-effort */
            }
          }
        }
      }
    },
  );

  // Message handler — text or voice
  bot.on(['message:text', 'message:voice', 'message:audio'], async (ctx: Context) => {
    // Skip slash commands (handled above)
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/')) return;

    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // ---- v1.21.0 Avengers (Pillar 2) — bot-message gating ---------------------
    // Order matters:
    //   1. Self-echo drop (Item 2 / R2): is THIS message one we just sent?
    //   2. Loop protection (Item 4 / D10): is this a peer bot pushing the
    //      conversation past the 3-turn cap?
    //   3. User-message reset (Item 4): a real human message clears the counter.
    // All three only run when bot identity is wired (multi-bot mode).
    const messageId = ctx.message?.message_id;
    const senderIsBot = ctx.message?.from?.is_bot === true;
    // v1.22.9 — chat-level loop-protection key. We previously included
    // message_thread_id, but v1.22.6's reply_to_message_id causes Telegram
    // to populate message_thread_id on threaded replies in supergroups,
    // which then bifurcates the key (`<chat>:<msgid>` for replies vs
    // `<chat>` for fresh messages) — defeating both stop-signal AND cap.
    // Topic-scoped counters aren't a feature we use; chat-level is correct.
    const threadKeyForChat = deriveThreadKey(chatId, undefined);

    // v1.21.10 diagnostic: surface every incoming text message at info level
    // so we can see WHY a bot isn't responding (allowlist drop, silent
    // mention-router skip, peer-bot loop cap, etc.). Trim long text + redact
    // nothing — this log is operator-only.
    log.info(
      {
        chatId,
        messageId,
        senderIsBot,
        senderUserId: ctx.message?.from?.id,
        senderUsername: ctx.message?.from?.username,
        chatType: ctx.chat?.type,
        textPreview: (ctx.message?.text ?? ctx.message?.caption ?? '').slice(0, 120),
        botName: botIdentity?.name,
      },
      'gateway: incoming message',
    );

    if (botIdentity && messageId !== undefined) {
      // (1) Self-echo drop — message id we just sent? Drop silently + audit.
      if (memory.botSelfMessages.isOurEcho(chatId, messageId, SELF_MESSAGE_TTL_MS, Date.now())) {
        memory.auditLog.insert({
          category: 'bot.self_message_dropped',
          actor_chat_id: chatId,
          detail: {
            messageId,
            botName: botIdentity.name,
            reason: 'self_echo',
          },
        });
        log.debug({ chatId, messageId, botName: botIdentity.name }, 'self-echo dropped');
        return;
      }

      if (senderIsBot) {
        // v1.22.19 — Avengers plan side-channel observation. If this peer-bot
        // reply lands in a chat with an active plan owned by THIS process
        // (orchestrator only), match it to an open step and mark it done
        // BEFORE loop protection runs. We want plan progress recorded even
        // if the message is later dropped by the loop cap. No-op when
        // there's no active plan or no open step matches the sender bot.
        if (avengersPlanLifecycle && botIdentity?.scope === 'full') {
          const senderUsername = ctx.message?.from?.username ?? '';
          const senderBotName = (Object.entries(BOT_TELEGRAM_USERNAMES).find(
            ([, u]) => u && u.toLowerCase() === senderUsername.toLowerCase(),
          )?.[0]) as string | undefined;
          if (senderBotName) {
            const replyText = ctx.message?.text ?? ctx.message?.caption ?? '';
            // Fire-and-forget; never block the message handler on a plan side-channel.
            void avengersPlanLifecycle
              .markStepDoneFromReply({
                chatId,
                senderBotName,
                replyText,
                replyMessageId: ctx.message?.message_id ?? null,
              })
              .catch((err) => {
                log.warn(
                  { chatId, senderBotName, err: err instanceof Error ? err.message : String(err) },
                  'avengers.plan: markStepDoneFromReply threw',
                );
              });
          }
        }

        // v1.22.45 had a hard "no peer-bot activation outside an active
        // plan" drift guard here; v1.22.47 removed it because it killed
        // legitimate banter in casual chats (specialists couldn't chime
        // in on jokes / chat without a plan in flight). Drift is now
        // handled by (a) the persona-level "no active task by default"
        // rule (config/personas/<bot>.md §7), (b) the tighter no-plan
        // peer-bot turn cap below (2 vs 5), and (c) the freshContext
        // flag in enqueueGroupAgentTurn which hides stale session
        // history when a specialist activates via collective alias.

        // (2) Loop protection — peer bot. v1.22.45 uses dynamic cap:
        // 5 turns when an active plan exists (room for delegation +
        // specialist reply + debate + ack), 2 when no plan (anything
        // beyond is drift).
        const hasActivePlanForCap = memory.plans.findActiveForChat(chatId) != null;
        const loop = checkBotToBotLoop(threadKeyForChat, Date.now(), {
          hasActivePlan: hasActivePlanForCap,
        });
        if (!loop.allowed) {
          memory.auditLog.insert({
            category: 'bot.loop_protection.engaged',
            actor_chat_id: chatId,
            detail: {
              threadKey: threadKeyForChat,
              count: loop.count,
              cap: loop.cap,
              hasActivePlan: hasActivePlanForCap,
              botName: botIdentity.name,
              senderBotUsername: ctx.message?.from?.username ?? null,
            },
          });
          log.info(
            { chatId, threadKey: threadKeyForChat, count: loop.count, cap: loop.cap },
            'bot-to-bot loop cap reached — message dropped',
          );
          return;
        }
        // Increment the counter BEFORE we proceed so back-to-back peer-bot
        // messages within the same tick can still see the prior increment.
        recordBotToBotTurn(threadKeyForChat);
      } else {
        // (3) User message — two paths:
        //   (a) v1.22.8 — message is a SHORT stop-command (≤60 chars and
        //       contains a stop-keyword): mark the thread stopped so
        //       subsequent peer-bot messages drop.
        //   (b) Otherwise: reset the bot-to-bot counter (existing behavior;
        //       any user input restarts the chain budget).
        //
        // The length cap suppresses false positives on long prompts that
        // mention the keyword in passing — e.g., "...I'll say stop." in
        // the test prompt would otherwise immediately stop the thread
        // before any debate happens.
        const userText = ctx.message?.text ?? ctx.message?.caption ?? '';
        const trimmedLen = userText.trim().length;
        const STOP_LEN_THRESHOLD = 60;
        if (trimmedLen > 0 && trimmedLen <= STOP_LEN_THRESHOLD && STOP_KEYWORDS_REGEX.test(userText)) {
          markThreadStopped(threadKeyForChat);
          memory.auditLog.insert({
            category: 'bot.loop_protection.engaged',
            actor_chat_id: chatId,
            actor_user_id: ctx.from?.id ?? null,
            detail: {
              threadKey: threadKeyForChat,
              reason: 'user_stop_signal',
              botName: botIdentity.name,
              userTextPreview: userText.slice(0, 80),
            },
          });
          log.info(
            { chatId, threadKey: threadKeyForChat, userText: userText.slice(0, 80) },
            'user stop-signal detected — peer-bot messages will drop until next non-stop user message',
          );
        } else {
          // v1.23.4 — sustained-banter detection. When the user invites a
          // back-and-forth chain ("keep going", "take turns", "continue
          // until I say stop"), set a flag that raises the no-plan loop
          // cap from 2 to 20. Any non-matching user message clears the
          // counter (and the flag) via resetBotToBotCounterOnUserMessage.
          resetBotToBotCounterOnUserMessage(threadKeyForChat);
          if (SUSTAINED_BANTER_REGEX.test(userText)) {
            markThreadSustained(threadKeyForChat, true);
            log.info(
              { chatId, threadKey: threadKeyForChat, userText: userText.slice(0, 100) },
              'sustained-banter mode armed — peer-bot cap raised to 20 until next user message',
            );
          }
        }
      }
    }
    // ---------------------------------------------------------------------------

    // v1.9.0 — response-tracking hook for reminder nudges. DM-only AND not a
    // slash command (already guarded above). Fire-and-forget; errors are warned
    // but never block the main turn.
    const _msgUserId = ctx.from?.id;
    if (
      _msgUserId !== undefined &&
      chatId === _msgUserId &&
      remindersApi !== null
    ) {
      void remindersApi.markResponsiveIfPending(_msgUserId).catch((err: unknown) => {
        log.warn(
          { userId: _msgUserId, err: err instanceof Error ? err.message : String(err) },
          'markResponsiveIfPending failed',
        );
      });
    }

    // --- Group chat routing (enhanced v1.7.13) ---
    if (isGroupChat(ctx)) {
      const userId = ctx.from?.id;
      if (userId === undefined) return;
      const senderName = ctx.from?.first_name ?? ctx.from?.username ?? 'User';
      const hasVoice = Boolean(ctx.message?.voice || ctx.message?.audio);

      // Transcribe voice up-front so the activation gate (and the classifier
      // inside it) can see real content. Previously transcription happened
      // AFTER activation, which meant voice messages could only activate via
      // caption — no classifier support.
      let groupUserText = ctx.message?.text ?? ctx.message?.caption ?? '';
      let transcript: string | null = null;
      if (hasVoice) {
        transcript = await transcribeTelegramVoice(ctx, transcriber);
        if (!transcript) {
          // No reply in group — don't spam when we can't hear someone.
          return;
        }
        groupUserText = transcript;
      }

      // Patch a gate-visible ctx whose .message.text is the (possibly
      // transcribed) content — the gate's mention/classifier paths all read
      // message.text/caption.
      const gateCtx: Context = hasVoice
        ? ({ ...ctx, message: { ...ctx.message, text: groupUserText } } as Context)
        : ctx;

      const gateAbort = AbortSignal.timeout(15_000);
      const activation = await checkGroupActivation(gateCtx, {
        config,
        botUserId,
        groupSettings: memory.groupSettings,
        getRecentMessages: getRecentForChat,
        classifierProvider: ollamaProvider,
        abortSignal: gateAbort,
        // v1.21.0 D7: when botIdentity is wired (multi-bot mode), the mention
        // router in groupGate decides if THIS bot is the addressee. botUsername
        // comes from getMe() cached at start(); falls back to '' if getMe failed.
        ...(botIdentity ? { botIdentity, botUsername } : {}),
      });

      // Medium-confidence ambiguous: post a confirmation prompt + stash the
      // original text so the user's next "yes" can activate the real turn.
      if (activation.reason === 'confirm-required' && activation.confirmPrompt) {
        setPending(chatId, {
          userId,
          senderName,
          userText: groupUserText,
          wasVoice: hasVoice,
          expiresAt:
            Date.now() + config.groups.intentDetection.confirmationTtlSeconds * 1000,
        });
        await ctx.reply(activation.confirmPrompt).catch(() => {});
        return;
      }

      // v1.23.0 — directive-driven plan auto-trigger. Runs BEFORE the
      // proceed-check because Jarvis (the only bot that can create plans)
      // typically isn't named when the user directs work to specialists
      // ("Tony — X. Bruce — Y."). In that case activation.proceed is false
      // for Jarvis, but we still want to track the multi-step work as a
      // plan so the dashboard + TODO + step matching all flow naturally.
      // Idempotent — lifecycle skips if a plan is already active for chat.
      if (
        avengersPlanLifecycle &&
        botIdentity?.scope === 'full' &&
        activation.directive &&
        activation.directive.allNamedBots.filter((n) => n !== 'ai-jarvis').length >= 2
      ) {
        const specialistDelegations = activation.directive.allNamedBots
          .filter((n) => n !== 'ai-jarvis')
          .map((bot) => ({
            specialist: bot,
            request: activation.directive!.taskByBot[bot] ?? '',
            // No delegate_message_id since the user message itself is the
            // delegation. The lifecycle's step matcher uses bot_name+chat_id
            // for reply matching; message_id is best-effort.
            delegateMessageId: ctx.message?.message_id ?? 0,
          }));
        log.info(
          {
            chatId,
            namedBots: activation.directive.allNamedBots,
            specialistCount: specialistDelegations.length,
          },
          'directive-driven plan auto-trigger: creating plan from user directives',
        );
        void avengersPlanLifecycle
          .createPlanAndPost({
            chatId,
            task: groupUserText,
            delegations: specialistDelegations,
          })
          .catch((err) => {
            log.error(
              { chatId, err: err instanceof Error ? err.message : String(err) },
              'avengers.plan: directive-driven createPlanAndPost threw',
            );
          });
      }

      if (!activation.proceed) {
        // Silent path — no reply, no echo, no log spam (the gate already
        // logged its decision at debug/info).
        return;
      }

      // Determine what to run through the agent:
      //   - 'confirmed' (user said "yes" to our prior confirm prompt)
      //     → run the stashed ORIGINAL text, not the current "yes" reply
      //   - everything else → run the current message
      const textToRun =
        activation.reason === 'confirmed' && activation.dispatchText
          ? activation.dispatchText
          : groupUserText;

      // Echo transcript in italics — but only on gate-proceed, and not on
      // the "confirmed" path (the echo was already shown when the original
      // voice arrived, or would be confusing for a plain "yes").
      if (hasVoice && transcript && activation.reason !== 'confirmed') {
        await ctx
          .reply(`<i>${htmlEscape(transcript)}</i>`, { parse_mode: 'HTML' })
          .catch(() => {});
      }

      // Rate-limit counter (stats only — never blocks).
      const username = ctx.from?.first_name ?? ctx.from?.username ?? null;
      memory.groupActivity.checkAndIncrement(
        chatId,
        userId,
        username,
        Number.MAX_SAFE_INTEGER,
        config.groups.rateLimitWindowMinutes,
      );

      // Debate mode intercepts normal user turns.
      if (isDebateEnabled(chatId)) {
        void runDebateTurn(chatId, textToRun, ctx);
        return;
      }

      const session = memory.sessions.getOrCreate(chatId);
      // v1.21.0 R3 (Item 3) — wrap peer-bot textToRun with <from-bot> tag
      // BEFORE it reaches the agent / message history. maybeWrapBotHistoryEntry
      // is a no-op for human messages.
      let wrappedTextToRun = textToRun;
      if (botIdentity) {
        const wrapped = maybeWrapBotHistoryEntry({
          from: ctx.message?.from ? {
            is_bot: ctx.message.from.is_bot,
            first_name: ctx.message.from.first_name,
            username: ctx.message.from.username,
          } : undefined,
          text: textToRun,
        });
        if (typeof wrapped === 'string') {
          wrappedTextToRun = wrapped;
        }
      }
      // v1.22.45 — fresh-context flag for collective-alias activations.
      // When a USER message activates a specialist via the collective
      // ("Avengers", "team") alias rather than naming the specialist
      // explicitly with a directive separator (e.g. "Tony — do X"), the
      // specialist's session history almost certainly contains a prior
      // task that the model will drift toward (observed: Tony writing
      // a new "team standup digest" sketch in response to "funniest
      // comedian, jokes only"). With freshContext=true the agent loads
      // an empty history, so the model responds to the actual user
      // message without re-anchoring on stale work. Only applies to
      // specialists; the orchestrator (Jarvis) keeps its full history
      // because it owns plan continuity.
      let freshContext = false;
      if (botIdentity?.scope === 'specialist' && !senderIsBot) {
        const named = detectNamedSpecialists(wrappedTextToRun);
        const explicitlyNamed = named.names.some((n) => n === botIdentity.name);
        if (!explicitlyNamed) {
          const activePlan = memory.plans.findActiveForChat(chatId);
          const myOpenStep = activePlan
            ? memory.plans.findOpenStepForBot(activePlan.id, botIdentity.name)
            : null;
          if (!myOpenStep) {
            freshContext = true;
            log.info(
              { chatId, botName: botIdentity.name },
              'specialist drift guard: freshContext=true (collective-alias activation, no open delegation)',
            );
          }
        }
      }

      // v1.23.0 — directive activation forces freshContext=true. The user
      // tasked this bot specifically; prior session history would only
      // contaminate (e.g., "I'm still working on yesterday's review"). Pair
      // with the WORK overlay applied in agent.turn to give the model a
      // clean slate + clear task + voice prompt.
      if (activation.mode === 'work') {
        freshContext = true;
        log.info(
          {
            chatId,
            botName: botIdentity?.name,
            taskLen: activation.directiveTask?.length ?? 0,
          },
          'directive activation: freshContext=true + WORK mode',
        );
      }

      enqueueGroupAgentTurn(
        chatId,
        session.id,
        wrappedTextToRun,
        senderName,
        userId,
        {
          senderIsBot,
          senderBotName: ctx.message?.from?.username ?? undefined,
        },
        ctx.message?.message_id, // v1.22.6 — for reply_to_message_id routing
        freshContext,
        // v1.23.0 — propagate gateway-decided mode + task to agent.turn.
        activation.mode,
        activation.directiveTask,
      );
      return;
    }
    // --- End group chat routing ---

    let userText: string;

    // Voice/audio transcription
    if (ctx.message?.voice || ctx.message?.audio) {
      const transcript = await transcribeTelegramVoice(ctx, transcriber);
      if (!transcript) {
        await ctx.reply("Couldn't transcribe. Please try again or send as text.");
        return;
      }
      userText = transcript;
      // Echo transcript in italics
      await ctx.reply(`<i>${htmlEscape(transcript)}</i>`, { parse_mode: 'HTML' });
    } else {
      userText = text;
    }

    // v1.21.0 R3 (Item 3) — when the speaker is a peer bot, wrap userText with
    // <from-bot> boundary tag BEFORE it reaches the agent / message history.
    // Self-echoes were already dropped at the top of this handler. Loop
    // protection has incremented the counter for this peer-bot turn. The wrap
    // is the LLM-visible boundary signal paired with the persona's inter-bot
    // clause. maybeWrapBotHistoryEntry returns the original text when from.is_bot
    // is false, so this is a no-op for human messages.
    if (botIdentity) {
      const wrapped = maybeWrapBotHistoryEntry({
        from: ctx.message?.from ? {
          is_bot: ctx.message.from.is_bot,
          first_name: ctx.message.from.first_name,
          username: ctx.message.from.username,
        } : undefined,
        text: userText,
      });
      if (typeof wrapped === 'string') {
        userText = wrapped;
      }
    }

    // Get session
    const session = memory.sessions.getOrCreate(chatId);

    // v1.7.15 — CONFIRM SEND interceptor. Runs BEFORE the agent loop so the
    // LLM is NEVER in the path between user approval and Gmail send. The
    // agent can stage drafts (gmail_draft tool) but the actual send only
    // happens here, in the gateway, after strict validation.
    const confirmToken = parseConfirmSend(userText);
    if (confirmToken !== null) {
      const userId = ctx.from?.id ?? 0;
      await handleConfirmSend(chatId, userId, confirmToken, ctx);
      return;
    }

    // Check for pending confirmation consumption
    if (safety.hasPending(session.id)) {
      const consumed = safety.consumeConfirmation(session.id, userText);
      if (consumed) {
        // Dispatch the confirmed command DIRECTLY — do NOT re-enter the agent
        // loop. Re-entry would re-classify the command as destructive and
        // hasPending() is now false, causing an infinite confirmation cycle.
        enqueueConfirmedCommand(chatId, session.id, consumed);
        return;
      }
      // Not a confirmation — fall through to normal processing
    }

    // Debate mode intercepts normal user turns
    if (isDebateEnabled(chatId)) {
      void runDebateTurn(chatId, userText, ctx);
      return;
    }

    // Enqueue normal user turn — pass peer-bot metadata for the from-bot wrap.
    // senderIsBot was computed earlier in this handler; senderBotName is the
    // peer bot's @username (the wrap sanitizes it further).
    enqueueAgentTurn(chatId, session.id, userText, {
      senderIsBot,
      senderBotName: ctx.message?.from?.username ?? undefined,
    });
  });

  /**
   * v1.7.15 — Handle "CONFIRM SEND <token>" in a DM.
   *
   * This function is the ONLY path through which an outbound email leaves
   * the system. Every check here is load-bearing — re-read carefully before
   * changing anything.
   *
   * Defense layers re-verified here:
   *   1. Private-DM-only: reject if this is a group chat.
   *   2. Allowlisted user: reject if the user isn't in telegram.allowedUserIds.
   *   3. Token match + TTL + chat-binding + user-binding: inspectToken()
   *      handles all four. Failure returns a typed rejection reason.
   *   4. Content-hash re-verification: fetch the Gmail draft's raw bytes and
   *      re-hash them against body_hash stored at stage time. If someone
   *      (prompt injection? concurrent Gmail edit?) modified the draft
   *      between preview and confirm, we REFUSE to send.
   *   5. Single-use: markSent's WHERE status='pending' guarantees a concurrent
   *      second CONFIRM lands a zero-row update and the caller sees the
   *      status-changed row on next read.
   *   6. Audit: every path writes an audit_log entry with full context.
   */
  async function handleConfirmSend(
    chatId: number,
    userId: number,
    token: string,
    ctx: Context,
  ): Promise<void> {
    const clog = log.child({ component: 'gateway.confirmSend', token });

    // Layer 1: DM-only
    if (chatId !== userId) {
      // Private chats always have chatId === userId. If they differ, this
      // is not a private DM — refuse silently.
      clog.warn({ chatId, userId }, 'CONFIRM SEND in non-DM rejected');
      memory.auditLog.insert({
        category: 'confirmation',
        actor_user_id: userId,
        actor_chat_id: chatId,
        detail: { event: 'email.confirm.rejected', token, reason: 'not-dm' },
      });
      return; // silent — don't leak that a token was tried
    }

    // Layer 2: owner allowlist
    if (!config.telegram.allowedUserIds.includes(userId)) {
      clog.warn({ userId }, 'CONFIRM SEND from non-allowlisted user');
      memory.auditLog.insert({
        category: 'confirmation',
        actor_user_id: userId,
        actor_chat_id: chatId,
        detail: { event: 'email.confirm.rejected', token, reason: 'not-owner' },
      });
      return;
    }

    // Layer 3: inspect the token (exists + right chat + right user + not expired + still pending)
    const result = inspectToken(memory, token, chatId, userId);
    if (!result.ok) {
      const reason = result.reason;
      clog.warn({ reason }, 'CONFIRM SEND rejected');
      memory.auditLog.insert({
        category: 'confirmation',
        actor_user_id: userId,
        actor_chat_id: chatId,
        session_id: result.row?.session_id ?? null,
        detail: { event: 'email.confirm.rejected', token, reason },
      });
      const msg = {
        'not-found': 'No pending email draft matches that token.',
        'wrong-chat': 'That token was staged in a different chat.',
        'wrong-user': 'That token is not yours to confirm.',
        expired: 'That confirmation has expired. Ask me to draft again.',
        'already-consumed': 'That draft was already acted on.',
      }[reason];
      await ctx.reply(`❌ ${msg}`).catch(() => {});
      return;
    }
    const row = result.row;

    // Layer 4: content-hash re-verification against the live Gmail draft.
    // This catches (a) the Gmail draft being edited in the Gmail UI between
    // stage and confirm, (b) any theoretical prompt-injection path that
    // would have to tamper with the draft on Google's side.
    const auth = await loadGoogleAuth(config, log);
    if (!auth) {
      clog.error({}, 'Gmail auth unavailable at confirm time');
      memory.emailSends.markFailed(row.id, 'auth-unavailable');
      memory.auditLog.insert({
        category: 'confirmation',
        actor_user_id: userId,
        actor_chat_id: chatId,
        session_id: row.session_id,
        detail: { event: 'email.confirm.failed', token, reason: 'auth-unavailable' },
      });
      await ctx
        .reply('❌ Gmail authorisation is not loaded. Re-run `npm run google-auth`.')
        .catch(() => {});
      return;
    }

    const api = new GmailApi(auth);
    let rawBytes: string;
    try {
      rawBytes = await api.getDraftRawBytes(row.draft_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      clog.error({ err: msg, draftId: row.draft_id }, 'Could not fetch draft for verification');
      memory.emailSends.markFailed(row.id, `fetch-draft: ${msg}`);
      memory.auditLog.insert({
        category: 'confirmation',
        actor_user_id: userId,
        actor_chat_id: chatId,
        session_id: row.session_id,
        detail: { event: 'email.confirm.failed', token, reason: 'fetch-draft', error: msg },
      });
      await ctx.reply(`❌ Couldn't verify the draft: ${msg}`).catch(() => {});
      return;
    }

    const expectedHash = row.body_hash;
    const actualHash = hashEmailContent({
      from: row.from_addr,
      to: JSON.parse(row.to_addrs) as string[],
      cc: JSON.parse(row.cc_addrs) as string[],
      bcc: JSON.parse(row.bcc_addrs) as string[],
      subject: row.subject,
      // The stored body is the source of truth; we don't re-parse MIME here.
      // The raw bytes check is a cross-check that the draft *exists* and is
      // fetchable — the hash comparison uses what we staged.
      body: extractStoredBody(rawBytes),
    });
    if (actualHash !== expectedHash) {
      clog.error(
        { expectedHash, actualHash, draftId: row.draft_id },
        'DRAFT CONTENT HASH MISMATCH — refusing send',
      );
      memory.emailSends.markFailed(row.id, 'hash-mismatch');
      memory.auditLog.insert({
        category: 'confirmation',
        actor_user_id: userId,
        actor_chat_id: chatId,
        session_id: row.session_id,
        detail: {
          event: 'email.confirm.hash-mismatch',
          token,
          expectedHash,
          actualHash,
          draftId: row.draft_id,
        },
      });
      // Delete the draft best-effort — we don't trust what's in it anymore.
      try {
        await api.deleteDraft(row.draft_id);
      } catch {
        // best-effort
      }
      await ctx
        .reply(
          '❌ SAFETY STOP — the Gmail draft content differs from what was previewed. ' +
            'The send has been refused and the draft deleted. Ask me to draft again.',
        )
        .catch(() => {});
      return;
    }

    // Layer 5: send. markSent's WHERE status='pending' guarantees single-use.
    let sentMessageId: string;
    try {
      const sent = await api.sendDraft(row.draft_id);
      sentMessageId = sent.messageId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      clog.error({ err: msg, draftId: row.draft_id }, 'Gmail send failed');
      memory.emailSends.markFailed(row.id, msg);
      memory.auditLog.insert({
        category: 'confirmation',
        actor_user_id: userId,
        actor_chat_id: chatId,
        session_id: row.session_id,
        detail: { event: 'email.confirm.failed', token, reason: 'send-failed', error: msg },
      });
      await ctx.reply(`❌ Send failed: ${msg}`).catch(() => {});
      return;
    }

    memory.emailSends.markSent(row.id, sentMessageId);
    memory.auditLog.insert({
      category: 'confirmation',
      actor_user_id: userId,
      actor_chat_id: chatId,
      session_id: row.session_id,
      detail: { event: 'email.sent', token, draftId: row.draft_id, sentMessageId },
    });
    clog.info(
      { rowId: row.id, draftId: row.draft_id, sentMessageId },
      'Email sent after user confirmation',
    );

    const to = (JSON.parse(row.to_addrs) as string[]).join(', ');
    await ctx
      .reply(`✅ Email sent to ${to}. Subject: "${row.subject}".`)
      .catch(() => {});
  }

  /**
   * Extract the plain-text body from the stored raw MIME bytes. Used to
   * re-derive body content for hash verification. Matches the single-part
   * plain-text MIME we generate in buildMimeMessage — not a general parser.
   *
   * Returns empty string on parse failure. That's deliberate: if we can't
   * find the body we return something that WON'T hash to the expected
   * value, which forces the confirmation to reject. Never silently fall
   * back to the truncated body_preview — that would also mismatch, but
   * more importantly we want an ambiguous MIME to be a hard "refuse" signal.
   */
  function extractStoredBody(rawMime: string): string {
    const split = rawMime.search(/\r?\n\r?\n/);
    if (split < 0) return '';
    const body = rawMime.slice(split).replace(/^\r?\n\r?\n/, '').replace(/\r\n/g, '\n');
    return body;
  }

  function enqueueAgentTurn(
    chatId: number,
    sessionId: number,
    userText: string,
    // v1.21.0 R3 (Item 3) — peer-bot metadata; passed to agent.turn so it can
    // wrap userText with the <from-bot> boundary before persisting to history.
    botMeta: { senderIsBot: boolean; senderBotName?: string } = { senderIsBot: false },
  ): void {
    const jobId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = queueManager.enqueueUser(chatId, {
      id: jobId,
      description: userText.slice(0, 80),
      run: async (abortSignal: AbortSignal) => {
        // Typing indicator — pulse every 4s for the duration of the turn.
        // Telegram's native indicator auto-fades after ~5s; a single fire
        // would go silent mid-turn for anything taking >5s (which most
        // tool-using turns do). Matches the v1.8.3 pattern from plan tasks.
        const typingPulse = setInterval(() => {
          void bot.api.sendChatAction(chatId, 'typing').catch(() => {});
        }, 4000);
        try {
          await bot.api.sendChatAction(chatId, 'typing');
        } catch {
          // ignore
        }

        // v1.11.x — streaming is opt-in via config.ai.streamingEnabled.
        // Default false because Telegram's rate-limit-bound edits produce
        // chunky updates that don't feel like typing (see CHANGELOG).
        // Leaving the plumbing in place so a future Web App UI (v1.12.0)
        // can re-use the provider.streamText path without rebuilding.
        const streamingEnabled = config.ai.streamingEnabled;
        const streaming = streamingEnabled
          ? createStreamingReply({
              adapter: telegramAdapter,
              chatId,
              editIntervalMs: config.ai.streamingEditIntervalMs,
              cursor: config.ai.streamingCursor,
            })
          : null;

        try {
          const turnResult = await agent.turn({
            chatId,
            sessionId,
            userText,
            abortSignal,
            userId: chatId, // DM: chatId == userId
            chatType: 'private',
            telegram: telegramAdapter,
            // v1.21.0 R3 (Item 3) — surface peer-bot metadata so agent wraps
            // userText with <from-bot> tag before persisting to history.
            senderIsBot: botMeta.senderIsBot,
            senderBotName: botMeta.senderBotName,
            ...(streaming && {
              onTextDelta: streaming.onTextDelta,
              onProviderCallStart: streaming.onProviderCallStart,
            }),
          });

          // Notify user of compaction before the reply (private chats only)
          if (turnResult.compactionEvent && config.context.notifyUser) {
            const ev = turnResult.compactionEvent;
            const origK = Math.round(ev.originalTokens / 1000);
            const newK = Math.round(ev.compressedTokens / 1000);
            const notice = `ℹ️ Context compacted — ${origK}K → ${newK}K tokens (${htmlEscape(ev.model)})`;
            await bot.api
              .sendMessage(chatId, notice, { parse_mode: 'HTML' })
              .catch(() => {});
          }

          const replyText = turnResult.replyText || '(no response)';
          if (streaming) {
            // Finalize: HTML-convert the authoritative turnResult reply and
            // do one last edit. streamingReply handles plain-text fallback
            // on HTML parse errors.
            await streaming.finalize(markdownToTelegramHtml(replyText));
          } else {
            try {
              await bot.api.sendMessage(chatId, markdownToTelegramHtml(replyText), { parse_mode: 'HTML' });
            } catch {
              await bot.api.sendMessage(chatId, replyText);
            }
          }
          await maybeSendVoice(chatId, replyText);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ chatId, err: message }, 'Agent turn failed');
          if (streaming?.hasStarted()) {
            // A placeholder/partial message is live. Overwrite it with the error.
            const mid = streaming.abandon();
            if (mid !== null) {
              await bot.api.editMessageText(chatId, mid, `Error: ${message}`).catch(() => {});
            }
          } else {
            streaming?.abandon();
            await bot.api
              .sendMessage(chatId, `Error: ${message}`)
              .catch(() => {
                /* ignore double-failure */
              });
          }
        } finally {
          clearInterval(typingPulse);
        }
      },
    });

    if (result.kind === 'rejected') {
      void bot.api
        .sendMessage(
          chatId,
          `⚠️ Queue full (${config.chat.userQueueMax} pending). Please wait for current tasks to finish.`,
        )
        .catch(() => {
          /* ignore */
        });
    }
  }

  function enqueueGroupAgentTurn(
    chatId: number,
    sessionId: number,
    userText: string,
    senderName: string,
    userId: number,
    // v1.21.0 R3 (Item 3) — peer-bot metadata for the from-bot wrap.
    botMeta: { senderIsBot: boolean; senderBotName?: string } = { senderIsBot: false },
    // v1.22.6 — message_id of the message that triggered this turn. When set,
    // the outgoing reply uses Telegram's reply_to_message_id, which routes
    // peer-bot @-mentions more reliably than plain @-mentions alone.
    triggerMessageId?: number,
    // v1.22.45 — when true, agent.turn skips loading session history
    // (drift guard for collective-alias activations on specialists).
    freshContext: boolean = false,
    // v1.23.0 — gateway-decided activation mode. Threads through to agent.turn
    // so the system prompt gets the correct overlay (work / banter) prepended.
    activationMode: 'work' | 'banter' | 'orchestrator' | undefined = undefined,
    // v1.23.0 — directive task text for work mode. Required when activationMode==='work'.
    directiveTask: string | undefined = undefined,
  ): void {
    const jobId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = queueManager.enqueueUser(chatId, {
      id: jobId,
      description: userText.slice(0, 80),
      run: async (abortSignal: AbortSignal) => {
        try {
          await bot.api.sendChatAction(chatId, 'typing');
        } catch {
          // ignore
        }

        // v1.22.42 — orchestrator delegation steering. When the user names
        // 2+ specialists explicitly (e.g. "Tony — X. Natasha — Y. Bruce — Z.")
        // and assemble mode is on, prepend a deterministic instruction to
        // the orchestrator's input listing every named specialist. Without
        // this, smaller open-source models (minimax-m2.7) sometimes drop a
        // delegation entirely — plan #8 fired only 2 of 3 expected
        // delegate_to_specialist calls. The steering note is added ONLY for
        // the orchestrator (full-scope) under assemble mode and only for
        // user (non-bot) messages, so peer-bot replies and DMs are unaffected.
        let userTextForTurn = userText;

        // v1.23.0 — inject shared group-state for specialists in WORK mode.
        // Jarvis writes the snapshot via the lifecycle on every plan change;
        // each specialist reads on its WORK turn so it can see what its peers
        // were tasked with + delivered (closes the "Bruce fabricates Tony's
        // hours" failure mode without relaxing the per-bot data sandbox).
        // Skipped for the orchestrator (Jarvis owns plan state directly via
        // memory.plans) and for non-WORK turns (banter doesn't need it).
        if (
          activationMode === 'work' &&
          botIdentity?.scope === 'specialist'
        ) {
          const snapshot = readGroupState(chatId, log);
          if (snapshot) {
            const block = renderGroupStateBlock(snapshot);
            userTextForTurn = `${block}\n\n${userText}`;
            log.debug(
              { chatId, botName: botIdentity.name, hasActivePlan: snapshot.activePlan !== null },
              'WORK mode: injected group-state block',
            );
          }
        }

        let expectedSpecialists: ReturnType<typeof detectNamedSpecialists> | null = null;
        const isOrchestratorAssemble =
          botIdentity?.scope === 'full' &&
          memory.groupSettings.getAvengersModes(chatId).assemble &&
          botMeta.senderIsBot !== true;
        if (isOrchestratorAssemble) {
          expectedSpecialists = detectNamedSpecialists(userText);
          if (expectedSpecialists.names.length >= 2) {
            const list = expectedSpecialists.displays.join(', ');
            const steering =
              `\n\n[Orchestrator note — derived from this message: the user named these specialists: ${list}. ` +
              `You MUST call delegate_to_specialist exactly ${expectedSpecialists.names.length} times — once for each — before producing any synthesis or final reply. ` +
              `Skipping a named specialist drops their work from the deliverable.]`;
            userTextForTurn = `${userText}${steering}`;
            log.info(
              { chatId, namedSpecialists: expectedSpecialists.names },
              'orchestrator: injected delegation steering note',
            );
          }
        }

        try {
          const turnResult = await agent.turn({
            chatId,
            sessionId,
            userText: userTextForTurn,
            abortSignal,
            userId,
            chatType: 'group',
            groupOptions: {
              groupMode: true,
              groupChatId: chatId,
              senderName,
            },
            telegram: telegramAdapter,
            // v1.21.0 R3 (Item 3) — peer-bot metadata for the from-bot wrap.
            senderIsBot: botMeta.senderIsBot,
            senderBotName: botMeta.senderBotName,
            // v1.22.45 — drift guard: skip session history when activated
            // by collective alias on a specialist with no open delegation.
            freshContext,
            // v1.23.0 — gateway-decided mode + directive task; agent prepends
            // the matching overlay (work / banter) to the system prompt.
            mode: activationMode,
            directiveTask,
            // v1.23.4 — sustained-banter flag: when armed by user intent
            // ("keep going" / "take turns"), the BANTER overlay switches
            // to the "casual chain — keep the round going" variant that
            // invites pass-the-ball @-mentions instead of forcing silence.
            sustainedBanter: isThreadSustained(deriveThreadKey(chatId, undefined)),
          });

          // v1.22.42 + v1.22.43 — post-turn delegation gap fill.
          //
          // v1.22.42 added a steering note + audit. We saw in the kill-the-
          // Avengers run (session 23) that minimax-m2.7 STILL ignored the
          // steering and produced a self-answer with toolCallCount: 0 — i.e.
          // Jarvis answered the prompt himself instead of delegating, despite
          // (a) the steering note saying "you MUST call delegate_to_specialist
          // 3 times" and (b) the assemble-mode tool strip leaving
          // delegate_to_specialist as the only available tool.
          //
          // v1.22.43 closes the loop deterministically: when expected ≥ 2 and
          // any are missing, the gateway posts the @username delegation
          // messages directly. Each message uses the same format
          // (`@<username> — <request>`) as the tool, so each specialist's
          // own gateway picks it up via @-mention activation. We synthesize
          // a delegation entry per fallback post and feed the augmented list
          // to the plan auto-trigger, so the plan TODO + dashboard work
          // end-to-end even when the orchestrator LLM whiffs.
          //
          // We capture into `effectiveDelegations` so subsequent code uses
          // the augmented set without mutating turnResult (defensive).
          let effectiveDelegations = turnResult.delegations
            ? [...turnResult.delegations]
            : [];

          if (
            expectedSpecialists &&
            expectedSpecialists.names.length >= 2 &&
            isOrchestratorAssemble
          ) {
            const delegated = new Set(effectiveDelegations.map((d) => d.specialist));
            const missing = expectedSpecialists.names.filter((n) => !delegated.has(n));
            if (missing.length > 0) {
              log.warn(
                {
                  chatId,
                  expected: expectedSpecialists.names,
                  delegated: [...delegated],
                  missing,
                },
                'orchestrator: dropped one or more named specialists — gateway will fill the gap',
              );
              memory.auditLog.insert({
                category: 'plan.delegation_incomplete',
                actor_chat_id: chatId,
                detail: {
                  expected: expectedSpecialists.names,
                  delegated: [...delegated],
                  missing,
                },
              });

              // Fire fallback delegations one at a time. Sequential keeps the
              // chat-history ordering stable (Tony, Natasha, Bruce) and avoids
              // any race on Telegram's rate limiter. A failure on one doesn't
              // block the others — we collect what works.
              for (const botName of missing) {
                const taskText = expectedSpecialists.tasks[botName];
                if (!taskText || taskText.length < 10) {
                  log.warn(
                    { botName, taskLen: taskText?.length ?? 0 },
                    'fallback delegate skipped — no task text extracted from user prompt',
                  );
                  continue;
                }
                const username = BOT_TELEGRAM_USERNAMES[botName];
                if (!username) {
                  log.warn({ botName }, 'fallback delegate skipped — no Telegram username on file');
                  continue;
                }
                try {
                  const delegateText = `@${username} — ${taskText}`;
                  const sent = await bot.api.sendMessage(chatId, delegateText);
                  effectiveDelegations.push({
                    specialist: botName,
                    request: taskText,
                    delegateMessageId: sent.message_id,
                  });
                  log.info(
                    { botName, username, messageId: sent.message_id },
                    'fallback delegate posted by gateway (orchestrator skipped delegation)',
                  );
                  memory.auditLog.insert({
                    category: 'bot.delegate',
                    actor_chat_id: chatId,
                    detail: {
                      from: 'gateway-fallback',
                      to: botName,
                      username,
                      messageId: sent.message_id,
                      requestPreview: taskText.slice(0, 120),
                    },
                  });
                } catch (err) {
                  log.error(
                    { botName, err: err instanceof Error ? err.message : String(err) },
                    'fallback delegate: telegram send failed',
                  );
                }
              }
            }
          }

          // Accumulate tokens for group user activity
          if (userId !== 0) {
            memory.groupActivity.addTokens(chatId, userId, 0, 0);
          }

          let replyText = turnResult.replyText || '(no response)';

          // v1.22.43 — when Jarvis whiffed entirely (no native delegations,
          // all came from the gateway fallback), replace his self-answer
          // with a clean acknowledgment so Boss doesn't see Jarvis trying to
          // answer the prompt himself in parallel with the specialists doing
          // the actual work. Triggers ONLY when every delegation is a
          // fallback (turnResult.delegations empty/undefined) AND we have
          // ≥ 2 effective ones (i.e., the gateway took over completely).
          const orchestratorWhiffed =
            isOrchestratorAssemble &&
            (!turnResult.delegations || turnResult.delegations.length === 0) &&
            effectiveDelegations.length >= 2;
          if (orchestratorWhiffed) {
            const names = effectiveDelegations
              .map((d) => d.specialist.replace(/^ai-/, ''))
              .map((n) => n.charAt(0).toUpperCase() + n.slice(1))
              .join(', ');
            replyText = `On it. Routing to ${names} now — I'll compile their reports into a deliverable when they're done.`;
            log.info(
              { chatId, count: effectiveDelegations.length },
              'orchestrator whiffed — gateway replaced self-answer with acknowledgment',
            );
          }

          // v1.22.35 — debate-for-accuracy. When a SPECIALIST is replying in
          // an assemble-mode chat to an inbound delegation (peer-bot @-mention
          // from Jarvis), run an up-to-3-round debate against Jarvis-as-critic
          // BEFORE posting the final answer. The specialist's reply text is
          // the initial draft. Critic on a different model challenges it.
          // Outcome (approved | contested) + transcript persist via shared
          // file so Jarvis's gateway picks them up when observing the reply.
          //
          // Skip when:
          //   - Not assemble mode (no plan to debate against)
          //   - This is Jarvis (the orchestrator does not debate itself)
          //   - The trigger wasn't a peer-bot @-mention (i.e., this is a
          //     direct Boss → specialist alias hit, not a delegation)
          //   - Reply is empty / too short to be worth debating (≤ 100 chars)
          const isSpecialist = botIdentity?.scope === 'specialist';
          const avengersModes = isSpecialist
            ? memory.groupSettings.getAvengersModes(chatId)
            : { chat: false, assemble: false, debate: false };
          const isAssemble = isSpecialist && avengersModes.assemble;
          // v1.22.36 — debate is now opt-in per chat (default off). v1.22.35
          // shipped it always-on for assemble mode but the latency + Telegram
          // rate-limit pressure were too aggressive. /avengers debate on flips it.
          const debateEnabled = isSpecialist && avengersModes.debate;
          const triggeredByPeerBot = botMeta.senderIsBot === true;
          const draftLongEnough = replyText.trim().length >= 100;
          const shouldDebate =
            isAssemble && debateEnabled && triggeredByPeerBot && draftLongEnough && botIdentity != null;

          if (shouldDebate && botIdentity) {
            const debateLog = log.child({
              component: 'avengers.debate.specialist',
              chatId,
              bot: botIdentity.name,
            });
            debateLog.info(
              { draftLen: replyText.length },
              'specialist debate: starting (will run up to 3 rounds with Jarvis-critic)',
            );

            // Show typing indicator while debate is running (2-3 minutes).
            // v1.22.36 — slowed from 4s → 8s. With 3 specialists running
            // concurrent debates, 4s pulses tripped Telegram chat-action
            // rate limits ("too many requests"). 8s is well under the
            // typing-indicator's ~10s natural fade.
            const debatePulse = setInterval(() => {
              bot.api.sendChatAction(chatId, 'typing').catch(() => undefined);
            }, 8_000);

            try {
              const outcome = await agent.runDebateForStep({
                initialDraft: replyText,
                request: userText, // the @-mention text from Jarvis is the request
                specialistBotName: botIdentity.name,
                abortSignal,
              });

              clearInterval(debatePulse);
              debateLog.info(
                {
                  outcome: outcome.outcome,
                  totalRoundsRun: outcome.totalRoundsRun,
                  finalLen: outcome.finalText.length,
                  draftLen: replyText.length,
                },
                'specialist debate: complete',
              );

              // Replace replyText with the final (post-debate) version.
              if (outcome.finalText && outcome.finalText.trim().length > 0) {
                replyText = outcome.finalText;
              }

              // v1.22.39 — surface unreconciled critic concerns in chat.
              // Without this, the specialist's draft posts identically whether
              // the critic approved, contested, or aborted. The transcript is
              // only visible in the dashboard. For non-approved outcomes we
              // append a short footer so Boss sees what wasn't resolved.
              //
              // Why pull from the LAST critic round: in `contested` runs the
              // critic spoke up to 3 times; the most recent verdict reflects
              // the still-outstanding concern. In `aborted` runs there's
              // typically one critic round whose feedback was never addressed.
              if (outcome.outcome === 'contested' || outcome.outcome === 'aborted') {
                const lastCritic = [...outcome.rounds]
                  .reverse()
                  .find((r) => r.speaker === 'critic');
                const reason = lastCritic?.verdictReason?.trim();
                if (reason && reason.length > 0) {
                  // Strip markdown-active chars so they don't re-interpret
                  // when the whole reply runs through markdownToTelegramHtml.
                  const safeReason = reason
                    .slice(0, 220)
                    .replace(/[*_`]/g, '');
                  const label = outcome.outcome === 'aborted'
                    ? '_Critic flagged (unaddressed — revision failed):_'
                    : `_Critic flagged after ${outcome.totalRoundsRun} rounds (unresolved):_`;
                  replyText = `${replyText}\n\n🔍 ${label} ${safeReason}`;
                }
              }

              // Persist transcript via shared file → Jarvis picks up.
              writeTranscript(
                {
                  chatId,
                  specialistBotName: botIdentity.name,
                  request: userText,
                  outcome: outcome.outcome,
                  totalRoundsRun: outcome.totalRoundsRun,
                  rounds: outcome.rounds,
                  writtenAt: new Date().toISOString(),
                },
                debateLog,
              );
            } catch (err) {
              clearInterval(debatePulse);
              debateLog.error(
                { err: err instanceof Error ? err.message : String(err) },
                'specialist debate: threw — proceeding with original draft (no debate applied)',
              );
              // Fall through with the original replyText.
            }
          }

          // v1.22.2 — human pace. In group chats, hold the reply for a
          // length-scaled delay (with typing indicator pulses) so multi-bot
          // exchanges feel like real conversation rather than two machines
          // trading 1-second bursts.
          const paceMs = humanPaceDelayMs(replyText.length);
          await sleepWithTyping(paceMs, async () => {
            await bot.api.sendChatAction(chatId, 'typing').catch(() => undefined);
          });

          try {
            // Group replies have a plain "Name: " prefix from agent (v1.21.4
            // dropped the prior <b>...</b> markup which was double-escaped).
            // v1.22.6 — when triggerMessageId is set, use reply_to_message_id
            // so Telegram threads the reply. This is more reliable than plain
            // @-mentions for routing inter-bot messages between admin bots.
            const sendOpts: { parse_mode: 'HTML'; reply_parameters?: { message_id: number; allow_sending_without_reply: true } } = { parse_mode: 'HTML' };
            if (triggerMessageId !== undefined) {
              sendOpts.reply_parameters = {
                message_id: triggerMessageId,
                allow_sending_without_reply: true,
              };
            }
            // v1.22.40 — chunk on Telegram's 4096-char cap. Triggered by
            // post-debate replies: an approved revision can balloon from
            // ~1.7KB to >10KB and used to fail with "message is too long".
            // We split on paragraph boundaries (then sentence-ends, then a
            // hard slice as last resort) so each chunk stays under cap. Only
            // the FIRST chunk uses reply_parameters — the rest are plain
            // continuation messages so Telegram doesn't thread them all to
            // the trigger.
            const chunks = splitForTelegram(replyText);
            for (let i = 0; i < chunks.length; i++) {
              const opts = i === 0 ? sendOpts : { parse_mode: 'HTML' as const };
              await bot.api.sendMessage(chatId, markdownToTelegramHtml(chunks[i]!), opts);
            }
          } catch {
            // Fallback: same chunking, but plain text (no parse_mode) in case
            // HTML rendering itself was the failure.
            const chunks = splitForTelegram(replyText);
            for (const chunk of chunks) {
              await bot.api.sendMessage(chatId, chunk);
            }
          }

          // v1.22.10 — orchestrator delivery detection. When the orchestrator
          // (full-scope bot, i.e. Jarvis) posts a substantive reply that does
          // NOT @-mention a peer bot, treat it as the task deliverable. Mark
          // the thread "stopped" so subsequent peer-bot acknowledgments
          // ("Yep." / "Agreed." / "Likewise.") drop until Boss speaks again.
          // Without this, bots ping-pong polite acknowledgments after every
          // delivered task until the 10-turn cap engages.
          //
          // v1.22.14 — skip the check when this turn called
          // delegate_to_specialist. The tool posts the @-mention in a
          // separate message, so the orchestrator's own reply text
          // intentionally has no @-mention. Without this skip, every
          // delegation immediately marks the thread stopped and the
          // specialist's reply gets dropped on arrival.
          // v1.22.46 — narrow this trigger to TASK-completion replies only.
          // Previously any substantive Jarvis reply without an @-mention
          // marked the thread stopped, which silenced casual banter
          // (observed: "funniest comedian, jokes only" → other bots
          // dropped at the gateway). The stop is essential after a real
          // task delivery (peers stop pinging "Yep"/"Agreed"/"Likewise"),
          // but harmful elsewhere. Heuristic: only apply the stop when
          // this chat has a plan that was delivered in the last 5 minutes
          // — i.e., this Jarvis reply is plausibly a wrap-up of that task.
          // Casual chat with no recent plan completion stays open for
          // peer-bot participation up to the dynamic loop cap.
          const TASK_WRAPUP_WINDOW_MS = 5 * 60 * 1000;
          const recentPlan = memory.plans.findMostRecentForChat(chatId);
          const recentDelivery =
            recentPlan?.status === 'delivered' && recentPlan.closed_at
              ? Date.now() - new Date(recentPlan.closed_at).getTime() < TASK_WRAPUP_WINDOW_MS
              : false;
          if (
            botIdentity?.scope === 'full' &&
            replyText.trim().length >= 30 &&
            !turnResult.delegated &&
            recentDelivery
          ) {
            const peerHandles = BOT_NAMES
              .filter((n) => n !== botIdentity.name && BOT_TELEGRAM_USERNAMES[n])
              .map((n) => `@${BOT_TELEGRAM_USERNAMES[n]}`.toLowerCase());
            const lowerReply = replyText.toLowerCase();
            const containsPeerMention = peerHandles.some((h) => lowerReply.includes(h));
            if (!containsPeerMention) {
              const groupThreadKey = deriveThreadKey(chatId, undefined);
              markThreadStopped(groupThreadKey);
              memory.auditLog.insert({
                category: 'bot.loop_protection.engaged',
                actor_chat_id: chatId,
                detail: {
                  threadKey: groupThreadKey,
                  reason: 'orchestrator_delivered',
                  botName: botIdentity.name,
                  replyLen: replyText.length,
                  planId: recentPlan?.id,
                },
              });
              log.debug(
                { chatId, threadKey: groupThreadKey, replyLen: replyText.length, planId: recentPlan?.id },
                'orchestrator wrap-up after task delivery — peer-bot replies will drop until next user message',
              );
            }
          }

          // v1.22.19 — Avengers plan auto-trigger. When the orchestrator
          // delegated to ≥2 specialists in this turn AND assemble mode is
          // on for the chat, create a plan + post the live TODO message.
          // Single-delegation turns don't get a plan (no progress tracking
          // value for one step). Idempotent: lifecycle skips if a plan is
          // already active for the chat.
          if (
            avengersPlanLifecycle &&
            botIdentity?.scope === 'full' &&
            effectiveDelegations.length >= 2 &&
            memory.groupSettings.getAvengersModes(chatId).assemble
          ) {
            void avengersPlanLifecycle
              .createPlanAndPost({
                chatId,
                task: userText,
                delegations: effectiveDelegations,
              })
              .catch((err) => {
                log.error(
                  { chatId, err: err instanceof Error ? err.message : String(err) },
                  'avengers.plan: createPlanAndPost threw',
                );
              });
          }

          // v1.7.13 — record who Jarvis just addressed so same-user follow-ups
          // within the window activate silently without the "jarvis" keyword.
          // userId is the sender of this turn — since we just addressed them,
          // their next message is the natural follow-up.
          if (userId !== 0) {
            recordBotSpoke(chatId, userId);
          }
          // Clear any stale pending-confirmation for this chat; once we've
          // spoken, the previous "were you asking me?" is no longer relevant.
          clearPending(chatId);
          await maybeSendVoice(chatId, replyText);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ chatId, err: message }, 'Group agent turn failed');
          // In group mode, send terse error reply
          await bot.api
            .sendMessage(chatId, `Error: ${message}`)
            .catch(() => {});
        }
      },
    });

    if (result.kind === 'rejected') {
      void bot.api
        .sendMessage(
          chatId,
          `Queue full. Please wait.`,
        )
        .catch(() => {});
    }
  }

  function enqueueConfirmedCommand(
    chatId: number,
    sessionId: number,
    confirmed: PendingAction,
  ): void {
    const jobId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = queueManager.enqueueUser(chatId, {
      id: jobId,
      description: `confirmed: ${confirmed.command.slice(0, 60)}`,
      run: async (abortSignal: AbortSignal) => {
        try {
          await bot.api.sendChatAction(chatId, 'typing');
        } catch {
          // ignore
        }

        try {
          const turnResult = await agent.runConfirmedCommand({
            chatId,
            sessionId,
            command: confirmed.command,
            shell: confirmed.shell,
            args: confirmed.args,
            abortSignal,
          });

          const replyText = turnResult.replyText || '(no output)';
          try {
            await bot.api.sendMessage(chatId, markdownToTelegramHtml(replyText), { parse_mode: 'HTML' });
          } catch {
            await bot.api.sendMessage(chatId, replyText);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ chatId, err: message }, 'Confirmed command execution failed');
          await bot.api
            .sendMessage(chatId, `Error: ${message}`)
            .catch(() => { /* ignore double-failure */ });
        }
      },
    });

    if (result.kind === 'rejected') {
      void bot.api
        .sendMessage(
          chatId,
          `⚠️ Queue full (${config.chat.userQueueMax} pending). Please wait for current tasks to finish.`,
        )
        .catch(() => { /* ignore */ });
    }
  }

  function enqueueSchedulerTurn(params: {
    chatId: number;
    taskId: number;
    description: string;
    command: string;
    ownerUserId: number | null;
    coachTurnCounters?: { nudges: number; writes: number };
  }): void {
    const { chatId, description, command, ownerUserId, coachTurnCounters } = params;
    const session = memory.sessions.getOrCreate(chatId);
    const jobId = `sched-${params.taskId}-${Date.now()}`;
    // v1.18.0 ADR 018 D3.a (CRIT fix — convergent: cross-review I1+I2,
    // Anti-Slop F1, Scalability CRITICAL-1.18.0.A): when the scheduler
    // marks this fire as a coach run by passing coachTurnCounters, forward
    // `isCoachRun: true` to agent.turn(). Without this, the dispatcher's
    // UNAUTHORIZED_IN_CONTEXT gate + per-turn caps never fire for coach
    // turns. agent.turn() owns the canonical counter init (see agent/index.ts
    // line 576) — we only need to flip the `isCoachRun` flag here.
    const isCoachRun = coachTurnCounters !== undefined;

    queueManager.enqueueScheduler(chatId, {
      id: jobId,
      description,
      run: async (abortSignal: AbortSignal) => {
        try {
          // v1.10.0: pass owner's userId so /organize + /memory tools work
          // for scheduled turns. Legacy tasks (ownerUserId=null) pass
          // userId: undefined and tools return NO_USER_ID.
          const turnResult = await agent.turn({
            chatId,
            sessionId: session.id,
            userText: command,
            userId: ownerUserId ?? undefined,
            abortSignal,
            telegram: telegramAdapter,
            isCoachRun,
          });
          const body = `📅 <b>${htmlEscape(description)}</b>:\n${htmlEscape(turnResult.replyText)}`;
          await bot.api
            .sendMessage(chatId, body, { parse_mode: 'HTML' })
            .catch(async () => {
              await bot.api.sendMessage(chatId, `${description}:\n${turnResult.replyText}`);
            });
          // v1.20.0 Scalability CRIT-A producer-side wiring: record coach DM
          // ONLY for cron-driven coach runs (isCoachRun === true). Plain scheduled
          // tasks ('remind me to ...') do NOT count against the D10 cooldown.
          // ownerUserId is the Telegram user id; chatId == userId for private DMs.
          if (isCoachRun && ownerUserId !== null) {
            void recordCoachDM(ownerUserId, gatewayDataDir).catch((err: unknown) => {
              log.warn(
                {
                  userId: ownerUserId,
                  taskId: params.taskId,
                  err: err instanceof Error ? err.message : String(err),
                },
                'recordCoachDM failed (scheduler coach path) — D10 cooldown may not register this DM',
              );
            });
          }
        } catch (err) {
          log.error(
            {
              taskId: params.taskId,
              err: err instanceof Error ? err.message : String(err),
            },
            'Scheduler turn failed',
          );
        }
      },
    });
  }

  return {
    get adapter(): MessagingAdapter {
      return telegramAdapter;
    },

    setReminders(r: RemindersApi | null): void {
      remindersApi = r;
    },

    setScheduler(s: SchedulerApi | null): void {
      scheduledDeps.schedulerApi = s;
      // v1.17.0 Fix 1: also wire into the webapp server so webapp mutations
      // call scheduler.reload() immediately (ADR 017 §7 Risk #8 binding).
      webappServer.setScheduler(s);

    },

    // v1.20.0 ADR 020 D7: spontaneous event-trigger coach turn path.
    async fireSpontaneousCoachTurn(trigger: TriggerRecord): Promise<void> {
      const { userId, itemId, triggerContext } = trigger;
      // userId IS the chatId for private DMs (Telegram: chatId == userId in private chats)
      const chatId = userId;
      const session = memory.sessions.getOrCreate(chatId);

      // Expand the coach prompt with trigger context (D15)
      let expandedPrompt: string;
      try {
        expandedPrompt = expandCoachPromptToken(
          COACH_PROMPT_PLACEHOLDER,
          triggerContext ?? trigger.triggerContext ?? '',
        );
      } catch (err) {
        log.warn(
          { userId, itemId, err: err instanceof Error ? err.message : String(err) },
          'gateway.fireSpontaneousCoachTurn: coach prompt expansion failed — skipping',
        );
        return;
      }

      const jobId = `spontaneous-${userId}-${itemId}-${Date.now()}`;
      log.info({ userId, itemId, triggerType: trigger.triggerType }, 'gateway: enqueuing spontaneous coach turn');

      // Use buildCoachTurnArgs as the single source of truth for the three load-bearing flags
      // (ADR 020 R1 — forbidden to inline isCoachRun: true + coachTurnCounters + isSpontaneousTrigger).
      const coachArgs = buildCoachTurnArgs({
        isSpontaneousTrigger: true,
        triggerContext: triggerContext ?? trigger.triggerContext ?? '',
      });

      queueManager.enqueueScheduler(chatId, {
        id: jobId,
        description: `coach-event-trigger:${trigger.triggerType}`,
        run: async (abortSignal: AbortSignal) => {
          try {
            const turnResult = await agent.turn({
              chatId,
              sessionId: session.id,
              userText: expandedPrompt,
              userId,
              abortSignal,
              telegram: telegramAdapter,
              ...coachArgs,
            });

            const body = `🔔 ${htmlEscape(turnResult.replyText)}`;
            await bot.api
              .sendMessage(chatId, body, { parse_mode: 'HTML' })
              .catch(async () => {
                await bot.api.sendMessage(chatId, turnResult.replyText);
              });
            // v1.20.0 Scalability CRIT-A producer-side wiring: record coach DM
            // for spontaneous event-trigger fires. Drives the D10 30-min cooldown
            // that prevents coach feedback loops (next checkCoachDMCooldown call
            // sees this fresh timestamp).
            void recordCoachDM(userId, gatewayDataDir).catch((err: unknown) => {
              log.warn(
                {
                  userId,
                  itemId,
                  triggerType: trigger.triggerType,
                  err: err instanceof Error ? err.message : String(err),
                },
                'recordCoachDM failed (spontaneous coach path) — D10 cooldown may not register this DM',
              );
            });
          } catch (err) {
            log.error(
              {
                userId,
                itemId,
                triggerType: trigger.triggerType,
                err: err instanceof Error ? err.message : String(err),
              },
              'gateway.fireSpontaneousCoachTurn: agent turn failed',
            );
            throw err; // re-throw so dispatchTrigger can handle failure
          }
        },
      });
    // end fireSpontaneousCoachTurn
    },

    async start(): Promise<void> {
      // Fetch bot's own user ID + username for group activation and config endpoint.
      try {
        const me = await bot.api.getMe();
        botUserId = me.id;
        botUsername = me.username ?? '';
        log.info({ botUserId, botUsername }, 'Bot user ID and username cached');
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to fetch bot user ID via getMe() — reply-to-bot detection disabled',
        );
      }

      await healthServer.start();
      // v1.13.1: always start the webapp server (loopback-only, harmless when
      // unconfigured). Removes the chicken-and-egg where cloudflared can't
      // tunnel until publicUrl is set, but operators can't get a publicUrl
      // until the tunnel is up. The /webapp slash command still gates on
      // publicUrl before sending a button — that's the right place for it.
      await webappServer.start();
      // grammY bot.start() begins long-polling and resolves on stop
      // We do not await it — it's a long-running task
      void bot.start({
        onStart: (info) => {
          log.info({ botUsername: info.username }, 'Telegram polling started');
        },
      });
    },

    async stop(): Promise<void> {
      try {
        await bot.stop();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'bot.stop() threw',
        );
      }
      queueManager.abortAll();
      await webappServer.stop().catch(() => {});
      await healthServer.stop();
      log.info({}, 'Gateway stopped');
    },

    enqueueSchedulerTurn,
  };
}
