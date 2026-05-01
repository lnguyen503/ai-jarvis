/** Memory module: opens the SQLite database, runs migrations, and exposes the MemoryApi aggregate. */

import type { AppConfig } from '../config/index.js';
import { openDb, closeDb } from './db.js';
import { SessionsRepo } from './sessions.js';
import { MessagesRepo } from './messages.js';
import { ProjectsRepo } from './projects.js';
import { MemoryRepo } from './memoryStore.js';
import { ScheduledTasksRepo } from './scheduledTasks.js';
import { CommandLogRepo } from './commandLog.js';
import { SessionModelStateRepo } from './sessionModel.js';
import { GroupActivityRepo } from './groupActivity.js';
import { GroupSettingsRepo } from './groupSettings.js';
import { ConversationArchiveRepo } from './conversationArchive.js';
import { FileSendsRepo } from './fileSends.js';
import { AuditLogRepo } from './auditLog.js';
import { EmailSendsRepo } from './emailSends.js';
import { DebateRunsRepo, DebateRoundsRepo } from './debateLog.js';
import { BotSelfMessagesRepo } from './botSelfMessages.js';
import { PlansRepo } from './plans.js';

export type { Session } from './sessions.js';
export type { Message, InsertMessageParams } from './messages.js';
export type { Project } from './projects.js';
export type { MemoryEntry } from './memoryStore.js';
export type { ScheduledTask } from './scheduledTasks.js';
export type { CommandLogEntry, InsertCommandLogParams } from './commandLog.js';
export type { SessionModelState } from './sessionModel.js';
export type { GroupUserActivity } from './groupActivity.js';
export type { GroupSetting } from './groupSettings.js';
export type { ConversationArchiveRow, InsertArchiveParams, SearchHit } from './conversationArchive.js';
export type { FileSendRow, InsertFileSendParams } from './fileSends.js';
export type { AuditLogRow, InsertAuditParams, AuditCategory } from './auditLog.js';
export { KNOWN_AUDIT_CATEGORIES } from './auditLog.js';
export type { EmailSendRow, InsertEmailSendParams, EmailSendStatus } from './emailSends.js';
export type {
  DebateRunRow,
  DebateRoundRow,
  DebateRunStatus,
  CreateDebateRunParams,
  AppendDebateRoundParams,
  FindDebateRunsOptions,
  UpdateDebateRunFields,
} from './debateLog.js';
export { BotSelfMessagesRepo, SELF_MESSAGE_TTL_MS } from './botSelfMessages.js';
export type { BotSelfMessageRow } from './botSelfMessages.js';
export { PlansRepo } from './plans.js';
export type {
  PlanRow,
  PlanStepRow,
  PlanStatus,
  PlanStepStatus,
  CreatePlanParams,
  PlanStepDebateRow,
  DebateSpeaker,
  DebateVerdict,
} from './plans.js';

export interface MemoryApi {
  sessions: SessionsRepo;
  messages: MessagesRepo;
  projects: ProjectsRepo;
  memory: MemoryRepo;
  scheduledTasks: ScheduledTasksRepo;
  commandLog: CommandLogRepo;
  sessionModelState: SessionModelStateRepo;
  groupActivity: GroupActivityRepo;
  groupSettings: GroupSettingsRepo;
  conversationArchive: ConversationArchiveRepo;
  fileSends: FileSendsRepo;
  auditLog: AuditLogRepo;
  emailSends: EmailSendsRepo;
  debateRuns: DebateRunsRepo;
  debateRounds: DebateRoundsRepo;
  /** v1.21.0 R2 — self-message echo tracking (replaces keyed-memory FIFO). */
  botSelfMessages: BotSelfMessagesRepo;
  /** v1.22.19 — Avengers plan tracking (Jarvis-only; specialists never read/write). */
  plans: PlansRepo;
  close(): void;
}

/**
 * Open the database, run migrations, and return the full memory API.
 * Call once at boot in index.ts.
 *
 * v1.16.0 R6: After migrations run, perform zombie cleanup — mark stale
 * 'running' debate_runs rows (updated > 5 minutes ago) as 'aborted' with
 * abort_reason='pm2_restart'. Runs BEFORE the gateway accepts connections.
 */
export function initMemory(cfg: AppConfig): MemoryApi {
  const db = openDb(cfg);

  const sessions = new SessionsRepo(db);
  const messages = new MessagesRepo(db);
  const projects = new ProjectsRepo(cfg);
  const memory = new MemoryRepo(db);
  const scheduledTasks = new ScheduledTasksRepo(db);
  const commandLog = new CommandLogRepo(db);
  const sessionModelState = new SessionModelStateRepo(db);
  const groupActivity = new GroupActivityRepo(db);
  const groupSettings = new GroupSettingsRepo(db);
  const conversationArchive = new ConversationArchiveRepo(db);
  const fileSends = new FileSendsRepo(db);
  const auditLog = new AuditLogRepo(db);
  const emailSends = new EmailSendsRepo(db);
  const debateRuns = new DebateRunsRepo(db);
  const debateRounds = new DebateRoundsRepo(db);
  const botSelfMessages = new BotSelfMessagesRepo(db);
  const plans = new PlansRepo(db);

  // R6 — pm2-restart zombie cleanup (ADR 016 D2.d).
  // Runs after migrations so the debate_runs table is guaranteed to exist.
  // Fires once per process boot, before any connections are accepted.
  debateRuns.cleanupZombies();

  return {
    sessions,
    messages,
    projects,
    memory,
    scheduledTasks,
    commandLog,
    sessionModelState,
    groupActivity,
    groupSettings,
    conversationArchive,
    fileSends,
    auditLog,
    emailSends,
    debateRuns,
    debateRounds,
    botSelfMessages,
    plans,
    close(): void {
      closeDb();
    },
  };
}
