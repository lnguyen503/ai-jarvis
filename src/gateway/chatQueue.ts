import type pino from 'pino';
import type { AppConfig } from '../config/index.js';
import { child } from '../logger/index.js';

const defaultLog = child({ component: 'gateway.chatQueue' });

export interface QueuedJob {
  id: string;
  run: (abortSignal: AbortSignal) => Promise<void>;
  enqueuedAt: number;
  origin: 'user' | 'scheduler';
  description?: string;
}

export interface QueueOverflowResult {
  kind: 'enqueued' | 'rejected' | 'dropped-oldest';
  droppedJobId?: string;
  droppedDescription?: string;
}

interface PerChatState {
  userQueue: QueuedJob[];
  schedulerQueue: QueuedJob[];
  running: boolean;
  activeAbort: AbortController | null;
  activeJobId: string | null;
}

/**
 * Per-chat queue system (ARCH §8, C3/C4).
 *
 * - userQueue: FIFO, cap config.chat.userQueueMax, reject-new on overflow with user-visible error
 * - schedulerQueue: cap config.chat.schedulerQueueMax, drop-oldest on overflow
 * - Drain order: userQueue fully drained before schedulerQueue runs
 * - /stop clears only the userQueue; /stop all clears both
 * - AbortController wired to currently-running job
 */
export class ChatQueueManager {
  private readonly chats = new Map<number, PerChatState>();
  private readonly cfg: AppConfig;
  private readonly log: pino.Logger;
  /**
   * Notify callback invoked when a scheduler job is dropped due to overflow.
   * The gateway wires this to a Telegram send so dropped jobs are never silent.
   */
  private onSchedulerDrop?: (chatId: number, description: string) => void;

  constructor(cfg: AppConfig, logger?: pino.Logger) {
    this.cfg = cfg;
    this.log = logger ?? defaultLog;
  }

  /** Wire the scheduler-drop notification callback (called by gateway). */
  setOnSchedulerDrop(fn: (chatId: number, description: string) => void): void {
    this.onSchedulerDrop = fn;
  }

  private getState(chatId: number): PerChatState {
    let s = this.chats.get(chatId);
    if (!s) {
      s = {
        userQueue: [],
        schedulerQueue: [],
        running: false,
        activeAbort: null,
        activeJobId: null,
      };
      this.chats.set(chatId, s);
    }
    return s;
  }

  /**
   * Enqueue a user-initiated turn.
   * Returns 'rejected' if the userQueue is full.
   */
  enqueueUser(
    chatId: number,
    job: Omit<QueuedJob, 'enqueuedAt' | 'origin'>,
  ): QueueOverflowResult {
    const s = this.getState(chatId);

    if (s.userQueue.length >= this.cfg.chat.userQueueMax) {
      this.log.warn(
        { chatId, userQueueLen: s.userQueue.length, cap: this.cfg.chat.userQueueMax },
        'User queue full — rejecting new turn',
      );
      return { kind: 'rejected' };
    }

    const queued: QueuedJob = {
      ...job,
      origin: 'user',
      enqueuedAt: Date.now(),
    };
    s.userQueue.push(queued);
    this._drain(chatId);
    return { kind: 'enqueued' };
  }

  /**
   * Enqueue a scheduler-initiated turn.
   * On overflow, drops the OLDEST scheduler job (not a user job) and notifies.
   */
  enqueueScheduler(
    chatId: number,
    job: Omit<QueuedJob, 'enqueuedAt' | 'origin'>,
  ): QueueOverflowResult {
    const s = this.getState(chatId);

    let result: QueueOverflowResult = { kind: 'enqueued' };

    if (s.schedulerQueue.length >= this.cfg.chat.schedulerQueueMax) {
      const dropped = s.schedulerQueue.shift();
      result = {
        kind: 'dropped-oldest',
        droppedJobId: dropped?.id,
        droppedDescription: dropped?.description ?? '(no description)',
      };
      this.log.warn(
        { chatId, droppedJobId: dropped?.id, droppedDescription: dropped?.description },
        'Scheduler queue full — dropped oldest',
      );
      if (this.onSchedulerDrop && dropped?.description) {
        try {
          this.onSchedulerDrop(chatId, dropped.description);
        } catch (err) {
          this.log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'onSchedulerDrop callback threw',
          );
        }
      }
    }

    const queued: QueuedJob = {
      ...job,
      origin: 'scheduler',
      enqueuedAt: Date.now(),
    };
    s.schedulerQueue.push(queued);
    this._drain(chatId);
    return result;
  }

  private _drain(chatId: number): void {
    const s = this.getState(chatId);
    if (s.running) return;

    // Expire stale jobs first
    const maxAge = this.cfg.chat.maxQueueAgeMs;
    const now = Date.now();
    s.userQueue = s.userQueue.filter((j) => now - j.enqueuedAt <= maxAge);
    s.schedulerQueue = s.schedulerQueue.filter((j) => now - j.enqueuedAt <= maxAge);

    // Drain order: userQueue first, then schedulerQueue
    const next = s.userQueue.shift() ?? s.schedulerQueue.shift();
    if (!next) return;

    s.running = true;
    s.activeAbort = new AbortController();
    s.activeJobId = next.id;

    // Run async — do not block enqueue callers
    void (async () => {
      try {
        await next.run(s.activeAbort!.signal);
      } catch (err) {
        this.log.error(
          {
            chatId,
            jobId: next.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'Queued job threw',
        );
      } finally {
        s.running = false;
        s.activeAbort = null;
        s.activeJobId = null;
        // Drain next
        this._drain(chatId);
      }
    })();
  }

  /**
   * /stop — abort the currently-running job AND clear this chat's userQueue.
   * The schedulerQueue is preserved.
   * Returns the count of cleared user items + 1 if a job was aborted.
   */
  stop(chatId: number): number {
    const s = this.getState(chatId);
    let cleared = 0;

    if (s.activeAbort) {
      s.activeAbort.abort('user_stop');
      cleared++;
    }

    cleared += s.userQueue.length;
    s.userQueue = [];

    return cleared;
  }

  /**
   * /stop all — abort the currently-running job AND clear BOTH queues.
   */
  stopAll(chatId: number): number {
    const s = this.getState(chatId);
    let cleared = 0;

    if (s.activeAbort) {
      s.activeAbort.abort('user_stop_all');
      cleared++;
    }

    cleared += s.userQueue.length + s.schedulerQueue.length;
    s.userQueue = [];
    s.schedulerQueue = [];

    return cleared;
  }

  /** For debugging / tests */
  snapshot(chatId: number): {
    userQueueLen: number;
    schedulerQueueLen: number;
    running: boolean;
    activeJobId: string | null;
  } {
    const s = this.getState(chatId);
    return {
      userQueueLen: s.userQueue.length,
      schedulerQueueLen: s.schedulerQueue.length,
      running: s.running,
      activeJobId: s.activeJobId,
    };
  }

  /** Abort all active jobs across all chats (used by shutdown) */
  abortAll(): void {
    for (const s of this.chats.values()) {
      if (s.activeAbort) {
        s.activeAbort.abort('shutdown');
      }
      s.userQueue = [];
      s.schedulerQueue = [];
    }
  }
}
