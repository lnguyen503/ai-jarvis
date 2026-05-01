import { randomBytes } from 'crypto';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import { child } from '../logger/index.js';

const log = child({ component: 'safety.confirmations' });

export interface PendingAction {
  actionId: string;
  sessionId: number;
  description: string;
  command: string;
  shell: 'powershell' | 'cmd' | 'none';
  args?: string[];
  enqueuedAt: number; // Date.now() ms
}

export interface RequireConfirmationResult {
  actionId: string;
}

/**
 * In-process store for pending confirmations.
 * One pending confirmation per session (C6, W5).
 * V-19 fix: capped at MAX_PENDING_ENTRIES to prevent unbounded growth.
 */
const MAX_PENDING_ENTRIES = 100;
const pendingBySession = new Map<number, PendingAction>();

function generateActionId(): string {
  // 4-char hex action-id (matches ARCH §9 example "a7f2").
  // Sourced from crypto.randomBytes for unpredictability — defense in depth
  // against actionId guessing across sessions. The 5-min TTL + per-session
  // singleton already made guessing infeasible, but there's no reason to
  // use a weak RNG when a strong one is free.
  return randomBytes(2).toString('hex');
}

export class ConfirmationManager {
  private readonly confirmationTtlMs: number;
  private readonly memoryApi: MemoryApi;
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(cfg: AppConfig, memory: MemoryApi) {
    this.confirmationTtlMs = cfg.safety.confirmationTtlMs;
    this.memoryApi = memory;

    // V-19 fix: active sweeper removes expired entries every 60s.
    // Unref'd so the interval does not prevent process shutdown.
    this.sweepInterval = setInterval(() => this._sweepExpired(), 60_000);
    if (typeof this.sweepInterval.unref === 'function') {
      this.sweepInterval.unref();
    }
  }

  /**
   * V-19 fix: sweep expired entries from pendingBySession.
   * Called by the 60s interval; also available for tests.
   */
  _sweepExpired(nowMs?: number): number {
    const now = nowMs ?? Date.now();
    let swept = 0;
    for (const [sessionId, pending] of pendingBySession.entries()) {
      if (now - pending.enqueuedAt > this.confirmationTtlMs) {
        pendingBySession.delete(sessionId);
        swept++;
      }
    }
    return swept;
  }

  /** Check if a session has a pending (non-expired) confirmation */
  hasPending(sessionId: number): boolean {
    const pending = pendingBySession.get(sessionId);
    if (!pending) return false;
    if (Date.now() - pending.enqueuedAt > this.confirmationTtlMs) {
      // Expired — clean up
      pendingBySession.delete(sessionId);
      return false;
    }
    return true;
  }

  /**
   * Register a pending destructive action.
   * Returns an actionId the user must echo back with "YES <actionId>".
   * If another action is already pending, throws CONFIRMATION_PENDING.
   */
  requireConfirmation(
    sessionId: number,
    pending: Omit<PendingAction, 'actionId' | 'enqueuedAt'>,
  ): RequireConfirmationResult {
    if (this.hasPending(sessionId)) {
      throw Object.assign(
        new Error(
          'Another confirmation is already pending for this session. ' +
            'Reply YES <actionId> or wait for it to expire.',
        ),
        { code: 'CONFIRMATION_PENDING' },
      );
    }

    const actionId = generateActionId();
    const action: PendingAction = {
      ...pending,
      actionId,
      enqueuedAt: Date.now(),
    };

    // V-19 fix: cap map size at MAX_PENDING_ENTRIES — drop oldest on overflow
    if (pendingBySession.size >= MAX_PENDING_ENTRIES) {
      const oldest = pendingBySession.keys().next().value;
      if (oldest !== undefined) {
        pendingBySession.delete(oldest);
      }
    }

    pendingBySession.set(sessionId, action);

    // Audit log: confirmation_prompted
    this.memoryApi.commandLog.insert({
      session_id: sessionId,
      command: '__confirmation__',
      working_dir: '',
      exit_code: null,
      stdout_preview: `PROMPTED: actionId=${actionId} cmd=${pending.description}`,
      killed: false,
    });

    log.warn({ sessionId, actionId, description: pending.description }, 'Confirmation required');

    return { actionId };
  }

  /**
   * Attempt to consume a pending confirmation.
   * userText must be "YES" or "YES <actionId>" (case-insensitive).
   * Returns the PendingAction if consumed, null if no match / expired.
   */
  consumeConfirmation(sessionId: number, userText: string, nowMs?: number): PendingAction | null {
    const pending = pendingBySession.get(sessionId);
    const now = nowMs ?? Date.now();

    if (!pending) {
      return null;
    }

    // Check TTL
    if (now - pending.enqueuedAt > this.confirmationTtlMs) {
      pendingBySession.delete(sessionId);
      // Audit log: expiry
      this.memoryApi.commandLog.insert({
        session_id: sessionId,
        command: '__confirmation__',
        working_dir: '',
        exit_code: -1,
        stdout_preview: `EXPIRED: actionId=${pending.actionId}`,
        killed: false,
      });
      log.warn({ sessionId, actionId: pending.actionId }, 'Confirmation expired');
      return null;
    }

    const trimmed = userText.trim().toLowerCase();

    // "YES" alone — consume the single pending action
    if (trimmed === 'yes') {
      pendingBySession.delete(sessionId);
      this._auditConsumed(sessionId, pending.actionId);
      return pending;
    }

    // "YES <actionId>" — must match the specific id
    const match = /^yes\s+([0-9a-f]{4})$/i.exec(trimmed);
    if (match) {
      const providedId = match[1]!.toLowerCase();
      if (providedId === pending.actionId) {
        pendingBySession.delete(sessionId);
        this._auditConsumed(sessionId, pending.actionId);
        return pending;
      }
      // Non-matching action-id — do NOT consume
      return null;
    }

    return null;
  }

  private _auditConsumed(sessionId: number, actionId: string): void {
    this.memoryApi.commandLog.insert({
      session_id: sessionId,
      command: '__confirmation__',
      working_dir: '',
      exit_code: 0,
      stdout_preview: `CONSUMED: actionId=${actionId}`,
      killed: false,
    });
    log.info({ sessionId, actionId }, 'Confirmation consumed');
  }

  /** For testing: clear all pending confirmations */
  _clearAll(): void {
    pendingBySession.clear();
  }
}
