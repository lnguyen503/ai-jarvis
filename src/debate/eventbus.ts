/**
 * DebateEventBus — in-process pub/sub for debate run events (v1.16.0).
 *
 * ADR 016 D5: Node built-in EventEmitter; zero new deps. Singleton exported
 * as debateEventBus. setMaxListeners(0) — unbounded; rely on R1 quad-binding
 * cleanup discipline to prevent leaks. See D13.a for the SSE close-path contract.
 *
 * Event keys are namespaced by runId (`run:${runId}`) so each subscriber only
 * sees events from its own run.
 *
 * Memory-leak guard: every subscribe() MUST be matched by an unsubscribe() in
 * the SSE close handler. Enforced via integration tests (R1-5).
 */

import { EventEmitter } from 'node:events';
import type { DebateState } from './index.js';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** A verdict payload returned by the judge/arbiter. */
export interface VerdictData {
  kind: 'consensus' | 'final-arbiter';
  summary: string;
  decision?: string;
  rationale?: string;
  dissent?: string;
}

/** A single debater round event, as published to the bus. */
export interface DebateRoundEvent {
  roundNumber: number;
  debaterName: string;
  modelName: string;
  content: string;
  ts: string;
}

export type DebateEvent =
  | { type: 'snapshot'; state: DebateState }
  | { type: 'round'; round: DebateRoundEvent }
  | { type: 'verdict'; verdict: VerdictData }
  | { type: 'complete'; finalState: DebateState }
  | { type: 'error'; reason: string };

// ---------------------------------------------------------------------------
// Bus implementation
// ---------------------------------------------------------------------------

class DebateEventBus extends EventEmitter {
  constructor() {
    super();
    // D5: unbounded listeners — rely on R1 cleanup discipline, not a fixed cap.
    this.setMaxListeners(0);
  }

  /** Publish an event to all subscribers of this run. */
  publish(runId: string, event: DebateEvent): void {
    this.emit(`run:${runId}`, event);
  }

  /**
   * Subscribe to events for a specific run.
   * Returns an unsubscribe function — callers MUST invoke it on connection close.
   */
  subscribe(runId: string, handler: (e: DebateEvent) => void): () => void {
    const listener = (e: DebateEvent): void => handler(e);
    this.on(`run:${runId}`, listener);
    return () => this.off(`run:${runId}`, listener);
  }

  /**
   * Unsubscribe a specific handler from a run's events.
   * Used when the caller holds the original handler reference rather than the
   * unsubscribe closure returned by subscribe().
   */
  unsubscribe(runId: string, handler: (e: DebateEvent) => void): void {
    this.off(`run:${runId}`, handler);
  }

  /** Return the current listener count for a run (used in leak tests). */
  listenerCountFor(runId: string): number {
    return this.listenerCount(`run:${runId}`);
  }
}

/** Module-scoped singleton. One per process (single-instance deployment). */
export const debateEventBus = new DebateEventBus();
