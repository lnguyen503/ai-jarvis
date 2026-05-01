/**
 * Jarvis — Personal AI Agent Gateway
 * Entry point. Boots all modules in order per STRUCTURE.md §Boot sequence.
 */
/* eslint-disable no-console */

import 'dotenv/config';
import path from 'node:path';
import { loadConfig } from './config/index.js';
import { initLogger, child } from './logger/index.js';
import { initMemory } from './memory/index.js';
import { initSafety } from './safety/index.js';
import { initTranscriber } from './transcriber/index.js';
import { registerTools } from './tools/index.js';
import { McpRegistry } from './mcp/registry.js';
import { initAgent } from './agent/index.js';
import { initScheduler } from './scheduler/index.js';
import { initGateway } from './gateway/index.js';
import { initReminders } from './organize/reminders.js';
import { initTrashEvictor } from './organize/trashEvictor.js';
import {
  registerCalendarSyncCallback,
  registerCalendarRemoveCallback,
  registerItemStateMonitorCallback,
  listItems as listOrganizeItems,
  readItem as readOrganizeItem,
  updateItem as updateOrganizeItem,
  createItem as createOrganizeItem,
} from './organize/storage.js';
import { initCalendarPoller } from './calendar/calendarPoller.js';
import { notifyCalendarSync, drainAllQueues, registerCalendarEventMonitorCallback } from './calendar/sync.js';
import type { SyncDeps } from './calendar/sync.js';
import { registerPostTurnChatCallback } from './agent/index.js';
import {
  notifyItemStateChange,
  type ItemStateMonitorDeps,
  type ItemCoachMemory,
} from './coach/itemStateMonitor.js';
import {
  registerChatMessageCallback,
  notifyChatMessage,
  fireChatMessageMonitor,
  type ChatMonitorDeps,
} from './coach/chatMonitor.js';
import {
  registerCalendarEventCallback,
  inspectCalendarEvent,
  fireCalendarEventMonitor,
  type CalendarEventInput,
} from './coach/calendarMonitor.js';
import { readCoachEntries, coachKeyPrefix } from './coach/coachMemory.js';
import type { TriggerRecord } from './coach/triggerFiring.js';
import type { SyncCursorBody } from './calendar/syncTypes.js';
import { loadGoogleAuth } from './google/oauth.js';
import { CalendarApi } from './google/calendar.js';
import { ensureJarvisCalendar as ensureCalendar } from './calendar/ensureCalendar.js';
import { readCursor, writeCursor } from './calendar/syncCursor.js';
import {
  isCircuitBreakerOpen as breakerIsOpen,
  recordFailure as breakerRecordFailure,
  recordSuccess as breakerRecordSuccess,
} from './calendar/breakerState.js';
import { buildSyncAuditShims } from './calendar/syncAuditShims.js';
import { migrateLegacyCoachTasks } from './coach/migration.js';
import { ClaudeProvider } from './providers/claude.js';
import { OllamaCloudProvider } from './providers/ollama-cloud.js';
import { resolveBotIdentity } from './config/botIdentity.js';
import { applyBotIdentityToConfig } from './config/applyBotIdentity.js';
import { runBotDataMigration, flushMigrationAuditBuffer } from './config/botMigration.js';

const VERSION = '1.22.13';

async function main(): Promise<void> {
  // Banner — the only console.log allowed (entrypoint, per CLAUDE.md global rules)
  console.log(`\n=== Jarvis v${VERSION} booting ===\n`);

  // 1. Config (fail fast on any invalid value)
  const cfgRaw = loadConfig();

  // 1.5. Bot identity — resolve early so logger can bind botName (CP1 W3).
  const identityResult = resolveBotIdentity(process.env['BOT_NAME']);
  if (!identityResult.ok) {
    console.error(`Boot failure: ${identityResult.error}`);
    process.exit(1);
  }
  const identity = identityResult.identity;

  // 1.6. v1.21.1 — rewrite per-bot fields in cfg from the resolved identity.
  // Sets memory.dbPath, health.port, webapp.port to the per-bot values so
  // that initMemory + health server + webapp don't collide across bots.
  // BINDING: applyBotIdentityToConfig(cfg, identity) MUST run before initMemory.
  const cfg = applyBotIdentityToConfig(cfgRaw, identity);

  // 2. Logger
  initLogger();
  const log = child({ component: 'index', botName: identity.name });
  log.info({ version: VERSION, botName: identity.name, scope: identity.scope }, 'Jarvis starting');

  // 2.5. Bot data migration — MUST run BEFORE initMemory (ADR 021 D3 BINDING).
  // Static test tests/static/bot-migration-ordering.test.ts enforces this order.
  // Phase A: symlink check + WAL checkpoint + rename (before DB is open).
  const migrationResult = await runBotDataMigration(identity);
  if (migrationResult.status === 'failed') {
    process.stderr.write(
      `[boot] Bot data migration failed (${migrationResult.reason ?? 'unknown'}). ` +
        `Check the output above. Partial state: ${migrationResult.renamedSubjects.join(', ') || 'none'}.\n`,
    );
    process.exit(1);
  }

  // 3. Memory (open DB, run migrations)
  const memory = initMemory(cfg);
  log.info({}, 'Memory initialized');

  // 3.5. Phase B: flush migration audit buffer into the now-open DB.
  if (migrationResult.auditBuffer.length > 0) {
    flushMigrationAuditBuffer(migrationResult.auditBuffer, memory.auditLog);
    log.info(
      { status: migrationResult.status, renamedSubjects: migrationResult.renamedSubjects },
      'Bot data migration complete',
    );
  }

  // 3.6. v1.21.0 D7 — emit bot.identity_resolved audit event now that the DB is open.
  memory.auditLog.insert({
    category: 'bot.identity_resolved',
    detail: {
      botName: identity.name,
      scope: identity.scope,
      webappPort: identity.webappPort,
    },
  });
  log.info({ botName: identity.name, scope: identity.scope }, 'Bot identity resolved and audited');

  // 4. Safety — v1.21.0 D4: pass identity so file-tool path checks are
  // narrowed to data/<botName>/ at the safety layer (CRITICAL-1.21.0.A fix).
  const safety = initSafety(cfg, memory, identity);
  log.info(
    { botName: identity.name, narrowedToDataDir: identity.dataDir },
    'Safety initialized (per-bot path-sandbox narrowing applied)',
  );

  // 5. Transcriber
  const transcriber = initTranscriber(cfg);

  // 5b. v1.9.0 — Provider hoist (ADR 004 Decision 2). Constructed once here
  //     so agent, gateway /compact, and reminders all share the same instances.
  const claudeProvider = new ClaudeProvider(cfg);
  const ollamaProvider = new OllamaCloudProvider();

  // 6. MCP discovery (lazy, non-fatal — runs before tools so MCP tools can be merged in)
  const mcpRegistry = new McpRegistry({ config: cfg, logger: log });
  let mcpTools: import('./tools/types.js').Tool[] = [];
  if (cfg.mcp?.enabled) {
    try {
      mcpTools = await mcpRegistry.discover();
      log.info({ mcpToolCount: mcpTools.length }, 'MCP tools loaded');
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'MCP discovery failed at boot — continuing without MCP tools',
      );
    }
  }

  // 7. Tools (register built-ins + Tavily + MCP tools; web_fetch NOT registered per CP1/C8)
  // schedulerApi is threaded in after scheduler is constructed (step 10).
  // We use a late-binding wrapper so the schedule tool always calls the live
  // scheduler instance even though tools are registered before the scheduler.
  // The wrapper is a plain { reload() } object — matching the structural type on ToolDeps.
  const schedulerApiRef: { reload(): void } = {
    reload(): void {
      // Populated at step 10 once the real scheduler is constructed.
      // Until then (during the brief boot window), reload is a no-op.
    },
  };
  const tools = registerTools({
    config: cfg,
    logger: log,
    safety,
    memory,
    schedulerApi: schedulerApiRef,
  }, mcpTools);

  // 8. Agent (receives hoisted providers + v1.10.0 schedulerApi late-binder)
  const agent = initAgent({
    config: cfg,
    logger: log,
    memory,
    tools,
    safety,
    claudeProvider,
    ollamaProvider,
    // v1.10.0: the agent's toolCtx exposes schedulerApi to the `schedule` tool.
    // The same late-binding ref populated at step 10 is shared with the tools
    // registry AND the agent — both see the reload fn once the real scheduler
    // is constructed.
    schedulerApi: schedulerApiRef,
    // v1.21.0 D6 (Item 6) — thread bot identity so buildToolContext can populate
    // ToolContext.botIdentity, which the dispatcher uses for the per-bot tool
    // allowlist gate at GATE 1 of dispatch().
    botIdentity: identity,
  });

  // 9. Gateway (must be built before scheduler so scheduler can enqueue via gateway)
  const gateway = initGateway({
    config: cfg,
    logger: log,
    memory,
    safety,
    agent,
    transcriber,
    version: VERSION,
    // v1.21.0 D7: thread resolved identity into the gateway so the mention
    // router in groupGate can decide if this bot is the addressee in groups.
    botIdentity: identity,
  });

  // 10. Scheduler — wires back to gateway.enqueueSchedulerTurn
  // v1.10.0: pass messagingAdapter so scheduler can DM owners when their
  // task is dropped due to allowlist revocation (R2). Null-safe at the
  // scheduler side — null means "audit-only, no DM".
  const scheduler = initScheduler({
    config: cfg,
    logger: log,
    memory,
    enqueueSchedulerTurn: gateway.enqueueSchedulerTurn,
    messagingAdapter: gateway.adapter,
  });
  // v1.10.0: late-bind the real scheduler.reload into the wrapper so the
  // schedule tool (registered in step 7) can trigger an immediate reload
  // after inserting a new task.
  schedulerApiRef.reload = () => scheduler.reload();
  // v1.10.0: also inject into gateway so /scheduled pause/resume/delete/claim
  // can reload immediately. Mirrors reminders late-binding.
  gateway.setScheduler(scheduler);

  // 10b. v1.9.0 — Reminders (§17.2). Gateway must be constructed first so we
  //      can pass its adapter. Reminders are then injected back into the gateway
  //      via setReminders() to enable the response-tracking hook.
  const dataDir = path.resolve(path.dirname(cfg.memory.dbPath));
  const reminders = initReminders({
    config: cfg,
    logger: log,
    memory,
    adapter: gateway.adapter,
    claudeProvider,
    ollamaProvider,
    dataDir,
  });
  gateway.setReminders(reminders);

  // 10c. v1.11.0 — Trash evictor sibling to reminders. Daily cron at 4am default.
  const trashEvictor = initTrashEvictor({
    config: cfg,
    memory,
    dataDir,
  });

  // 10d. v1.19.0 ADR 019 D4 + D6 — Calendar post-write hooks + 5-min reverse-sync poller.
  //
  // Google OAuth is loaded once (single-user app). If the token file is absent or
  // OAuth is not configured, calApi is null and all calendar operations are no-ops.
  const googleAuth = await loadGoogleAuth(cfg, log);
  const calApi = googleAuth ? new CalendarApi(googleAuth) : null;
  if (!calApi) {
    log.info({}, 'v1.19.0: Google OAuth not configured — calendar sync is no-op');
  }

  // v1.19.0 fix-loop: audit shims extracted to src/calendar/syncAuditShims.ts so
  // shape + closed-set categories are testable independent of boot.
  const calendarAuditShims = buildSyncAuditShims(log, memory.auditLog);

  function buildCalendarSyncDeps(_userId: number): SyncDeps {
    return {
      createCalendarEvent: calApi
        ? (opts) => calApi.createEvent(opts)
        : async () => ({ id: '', updated: undefined }),
      updateCalendarEvent: calApi
        ? (opts) => calApi.updateEvent(opts)
        : async () => ({ id: '', updated: undefined }),
      deleteCalendarEvent: calApi
        ? (calendarId, eventId) => calApi.deleteEvent({ calendarId, eventId })
        : async () => undefined,
      listCalendarEvents: calApi
        ? async (_uid, calendarId, updatedMin) =>
            calApi.listEvents({ calendarId, startTime: updatedMin })
        : async () => [],
      ensureJarvisCalendar: async (uid) =>
        calApi ? ensureCalendar(uid, dataDir, calApi) : null,
      readItem: (uid, itemId) => readOrganizeItem(uid, dataDir, itemId),
      updateItemCalendarId: async (uid, itemId, calendarEventId) => {
        await updateOrganizeItem(uid, dataDir, itemId, { calendarEventId });
      },
      updateItemFromEvent: async (uid, itemId, patch) => {
        await updateOrganizeItem(uid, dataDir, itemId, {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.due !== undefined ? { due: patch.due ?? null } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        });
      },
      createItemFromEvent: async (uid, opts) => {
        await createOrganizeItem(uid, dataDir, {
          type: 'task',
          title: opts.title,
          due: opts.due,
          calendarEventId: opts.calendarEventId,
          notes: opts.notes,
        });
      },
      updateLastSyncedAt: async () => undefined,
      readSyncCursor: (uid) => readCursor(uid, dataDir),
      writeSyncCursor: (uid, cursor: SyncCursorBody) => writeCursor(uid, dataDir, cursor),
      // v1.19.0 fix-loop: real breaker wired (was stubbed identity returns).
      // Per ADR 019 R2 Part 3 — counter in keyed memory, DM owner at threshold,
      // 24h DM-dedup, audit calendar.fail_token_expired on trip,
      // calendar.circuit_breaker_reset on auto-recovery.
      isCircuitBreakerOpen: (uid) => breakerIsOpen(uid, dataDir),
      recordFailure: (uid, errorCode) =>
        breakerRecordFailure(uid, dataDir, errorCode, gateway.adapter, memory.auditLog),
      recordSuccess: (uid) => breakerRecordSuccess(uid, dataDir, memory.auditLog),
      // v1.19.0 fix-loop: audit shims now insert into memory.auditLog (was log-only).
      // Privacy posture: STRUCTURAL metadata only — no content fields per F3 + v1.17.0 H gate.
      // See src/calendar/syncAuditShims.ts for the shape definitions and tests.
      auditSuccess: calendarAuditShims.auditSuccess,
      auditFailure: calendarAuditShims.auditFailure,
      auditSkip: calendarAuditShims.auditSkip,
      auditRejectedInjection: calendarAuditShims.auditRejectedInjection,
      auditTruncated: calendarAuditShims.auditTruncated,
    };
  }

  registerCalendarSyncCallback((uid, item) => {
    notifyCalendarSync(uid, item, buildCalendarSyncDeps(uid));
  });
  registerCalendarRemoveCallback((uid, itemId) => {
    log.debug({ userId: uid, itemId }, 'calendar: soft-delete hook (delete-from-calendar deferred)');
  });

  const calendarPoller = initCalendarPoller({
    dataDir,
    buildSyncDeps: buildCalendarSyncDeps,
  });

  // 10.5e v1.20.0 ADR 020 D6.a/b/c — Event-driven coach monitor wiring.
  //
  // Three monitor modules sit downstream of their respective signal sources
  // (organize/storage, agent, calendar/sync). Each signal source holds ONLY
  // a generic function pointer — NEVER imports coach/**. Boot wiring here is
  // the single place where the pointer is populated with the real callback.
  //
  // All three monitors share the same TriggerFireDeps core:
  //   { dataDir, auditLog, fireSpontaneousCoachTurn }
  //
  // ADR 020 D17: callbacks MUST NOT be registered with identity stubs.

  // Helper: read ItemCoachMemory (lastEngagedAt) for a given item.
  // Scans lastNudge coach entries; returns the most recent 'engaged' reply timestamp.
  async function readItemCoachMemory(userId: number, itemId: string): Promise<ItemCoachMemory | null> {
    const prefix = coachKeyPrefix(itemId, 'lastNudge');
    const entries = await readCoachEntries(userId, dataDir, prefix, 10);
    for (const entry of entries) {
      const payload = entry.payload as Record<string, unknown>;
      if (payload['userReply'] === 'engaged') {
        return { lastEngagedAt: entry.at };
      }
    }
    return null;
  }

  // D6.a — Item-state monitor: fires after every createItem / updateItem write.
  const itemStateDeps: ItemStateMonitorDeps = {
    dataDir,
    auditLog: memory.auditLog,
    fireSpontaneousCoachTurn: (trigger: TriggerRecord) => gateway.fireSpontaneousCoachTurn(trigger),
    readItemCoachMemory,
  };
  registerItemStateMonitorCallback((userId, item) => {
    void notifyItemStateChange(itemStateDeps, userId, item);
  });

  // D6.b — Chat monitor: fires after every non-coach agent.turn() user message.
  // Chain: agent._firePostTurnChat → fireChatMessageMonitor → notifyChatMessage
  const chatDeps: ChatMonitorDeps = {
    dataDir,
    auditLog: memory.auditLog,
    fireSpontaneousCoachTurn: (trigger: TriggerRecord) => gateway.fireSpontaneousCoachTurn(trigger),
    listActiveItems: (userId) => listOrganizeItems(userId, dataDir, { status: 'active' }),
  };
  registerChatMessageCallback((userId, message) => {
    void notifyChatMessage(chatDeps, userId, message);
  });
  // Wire agent post-turn hook → chatMonitor fire function (one-way: agent never imports coach).
  registerPostTurnChatCallback((userId, message) => {
    fireChatMessageMonitor(userId, message);
  });

  // D6.c — Calendar monitor: fires after every reverse-sync event in pollCalendarChanges.
  // Chain: calendar/sync._fireCalendarEventMonitor → fireCalendarEventMonitor → inspectCalendarEvent
  const calendarMonitorDeps = {
    dataDir,
    auditLog: memory.auditLog,
    fireSpontaneousCoachTurn: (trigger: TriggerRecord) => gateway.fireSpontaneousCoachTurn(trigger),
  };
  registerCalendarEventCallback((userId, event) => {
    void inspectCalendarEvent(calendarMonitorDeps, userId, event);
  });
  // Wire calendar/sync post-process hook → calendarMonitor fire function.
  // CalendarMonitorEvent (sync.ts) and CalendarEventInput (calendarMonitor.ts) share the
  // same structural shape — pass through directly (one-way: sync never imports coach).
  registerCalendarEventMonitorCallback((userId, event) => {
    fireCalendarEventMonitor(userId, event as CalendarEventInput);
  });

  // 10.5 v1.20.0 ADR 020 D2 + R3.a (CP1 revisions BINDING) — migrate __coach__ → __coach_morning__
  // MUST run BEFORE scheduler.start() to avoid a race where the scheduler registers
  // the legacy row and then migration rewrites it mid-flight (R3.a boot ordering invariant).
  // Static test tests/static/coach-migration-ordering.test.ts asserts this ordering.
  migrateLegacyCoachTasks(memory);

  // 11. Start scheduler + gateway + reminders + trash evictor
  scheduler.start();
  await gateway.start();
  reminders.start();
  trashEvictor.start();  // v1.11.0
  calendarPoller.start();  // v1.19.0 ADR 019 D6
  log.info({ version: VERSION }, 'Jarvis online');

  // Shutdown handlers
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Shutdown initiated');
    try {
      calendarPoller.stop();  // v1.19.0
      await drainAllQueues(buildCalendarSyncDeps(0), 3000).catch((e: unknown) => {
        log.warn({ err: e instanceof Error ? e.message : String(e) }, "calendar drain on shutdown threw");
      });
      trashEvictor.stop();  // v1.11.0 — reverse order (evictor starts after reminders)
      reminders.stop();
      await gateway.stop();
      scheduler.stop();
      await mcpRegistry.close();
      // v1.7.14 — close the headless browser if one was ever launched.
      // Import lazily so test paths that never touch the browser don't
      // pull in Playwright at module-load time.
      try {
        const { shutdownBrowser } = await import('./browser/launcher.js');
        await shutdownBrowser(log);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Browser shutdown threw',
        );
      }
      memory.close();
      log.info({}, 'Shutdown complete');
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Error during shutdown',
      );
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (err: Error) => {
    log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    log.fatal(
      { reason: reason instanceof Error ? reason.message : String(reason) },
      'Unhandled rejection',
    );
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  console.error('Fatal boot error:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
