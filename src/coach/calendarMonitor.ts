/**
 * Calendar event trigger monitor (v1.20.0 ADR 020 D6.c).
 *
 * Hooked into src/calendar/sync.ts reverse-sync entry path via callback
 * registry pattern (same as v1.19.0 calendar-sync pattern). Registered at
 * boot from src/index.ts via registerCalendarEventCallback().
 *
 * Fires AFTER syncCalendarEventToItem processes an event from pollCalendarChanges.
 *
 * Exports:
 *   detectCalendarTrigger(event, now)   — pure detect; returns TriggerRecord | null
 *   inspectCalendarEvent(deps, userId, event) — callback body; calls detect → dispatch
 *   registerCalendarEventCallback(cb)   — boot-time registration
 *   fireCalendarEventMonitor(userId, event) — called from calendar/sync.ts post-process
 *
 * Trigger conditions (mutually exclusive — first match wins):
 *   recurring-meeting-detected    — recurringEventId is set on the event
 *   standalone-meaningful-event   — no recurringEventId, title ≥ 12 tokens OR
 *                                   description present, start - now > 1h
 *
 * Dispatch delay: CALENDAR_TRIGGER_DELAY_MS = 5 min (ADR 020 CP1 R5).
 * Post-delay rate-limit re-check handles quiet mode set during wait window.
 *
 * Dependency edges (binding per ADR 020 D16):
 *   calendarMonitor.ts → coach/triggerFiring (TriggerRecord, dispatchTrigger)
 *   calendarMonitor.ts → coach/textPatternMatcher (tokenize — for title token count)
 *   calendarMonitor.ts → organize/types (import type OrganizeItem — NOT used at runtime)
 *   calendarMonitor.ts → logger
 *   FORBIDDEN: NO import from gateway/**, agent/**, organize/storage, memory/scheduledTasks.
 *
 * ADR 020 Decision 6.c + CP1 R5 + boot-wiring per D17.
 */

import { child } from '../logger/index.js';
import { tokenize } from './textPatternMatcher.js';
import {
  buildTriggerReason,
  dispatchTrigger,
  type TriggerRecord,
  type TriggerFireDeps,
} from './triggerFiring.js';

const log = child({ component: 'coach.calendarMonitor' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Delay before firing calendar triggers (ADR 020 CP1 R5 — 5 min) */
export const CALENDAR_TRIGGER_DELAY_MS = 5 * 60 * 1000;

/** Minimum token count for a "meaningful" standalone event title */
const MEANINGFUL_TITLE_MIN_TOKENS = 12;

/** Minimum time ahead (1h) before firing standalone-meaningful-event trigger */
const STANDALONE_MIN_ADVANCE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Calendar event shape (minimal — only what the monitor needs)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the calendar event passed to the monitor.
 * Derived from CalendarEventSummary but decoupled to avoid google/ imports.
 */
export interface CalendarEventInput {
  /** Google Calendar event ID. */
  id: string;
  /** Event title / summary. */
  summary: string;
  /** Optional event description. */
  description?: string;
  /** ISO datetime or YYYY-MM-DD for start time. null for events without a start. */
  start: string | null;
  /** App-internal itemId — set on Jarvis-managed events. */
  itemId: string;
  /** Google recurringEventId — set on recurring event instances. */
  recurringEventId?: string;
}

// ---------------------------------------------------------------------------
// Pure detect function
// ---------------------------------------------------------------------------

/**
 * Detect whether a calendar event should trigger a spontaneous coach fire.
 *
 * Pure function — no side effects, no async.
 * Returns a TriggerRecord with userId=0 (placeholder; caller stamps real userId),
 * or null if no condition matches.
 *
 * Conditions (first match wins):
 *   1. recurring-meeting-detected: recurringEventId is set
 *   2. standalone-meaningful-event: no recurringEventId, title ≥ 12 tokens
 *      OR description present, start > now + 1h
 *
 * @param event  The calendar event to inspect.
 * @param now    Current timestamp (injectable for testing).
 */
export function detectCalendarTrigger(
  event: CalendarEventInput,
  now: Date = new Date(),
): TriggerRecord | null {
  const { itemId } = event;
  const nowMs = now.getTime();

  // --- Condition 1: recurring-meeting-detected ---
  if (event.recurringEventId) {
    return {
      userId: 0,
      itemId,
      kind: 'calendar',
      triggerType: 'recurring-meeting-detected',
      reason: buildTriggerReason('recurring-meeting-detected'),
      triggerContext: `kind=calendar reason=recurring_meeting itemId=${itemId}`,
      detectedAt: now.toISOString(),
    };
  }

  // --- Condition 2: standalone-meaningful-event ---
  // No recurringEventId, title ≥ 12 tokens OR description present,
  // start - now > 1h
  if (!event.recurringEventId) {
    const titleTokens = tokenize(event.summary);
    const hasDescription = Boolean(event.description?.trim());
    const isMeaningful = titleTokens.length >= MEANINGFUL_TITLE_MIN_TOKENS || hasDescription;

    if (isMeaningful && event.start) {
      const startMs = new Date(event.start).getTime();
      const advanceMs = startMs - nowMs;

      if (advanceMs > STANDALONE_MIN_ADVANCE_MS) {
        return {
          userId: 0,
          itemId,
          kind: 'calendar',
          triggerType: 'standalone-meaningful-event',
          reason: buildTriggerReason('standalone-meaningful-event'),
          triggerContext: `kind=calendar reason=standalone_meaningful_event itemId=${itemId}`,
          detectedAt: now.toISOString(),
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Boot-time callback registry (same pattern as v1.19.0 calendar sync)
// ---------------------------------------------------------------------------

/**
 * Type for the calendar event monitor callback.
 * Receives userId + the just-processed calendar event. Fire-and-forget.
 */
export type CalendarEventMonitorCallback = (userId: number, event: CalendarEventInput) => void;

let _calendarEventMonitorCallback: CalendarEventMonitorCallback | null = null;

/**
 * Register the calendar event monitor callback (called at boot from src/index.ts).
 * Fires after every reverse-sync event in pollCalendarChanges.
 *
 * ADR 020 D17 boot-wiring lint asserts this is NOT registered with a stub.
 */
export function registerCalendarEventCallback(cb: CalendarEventMonitorCallback): void {
  _calendarEventMonitorCallback = cb;
}

/**
 * Internal: fire the calendar event monitor callback fire-and-forget.
 * Called from calendar/sync.ts post-syncCalendarEventToItem.
 */
export function fireCalendarEventMonitor(userId: number, event: CalendarEventInput): void {
  if (_calendarEventMonitorCallback) {
    Promise.resolve()
      .then(() => _calendarEventMonitorCallback!(userId, event))
      .catch((err: unknown) => {
        log.warn(
          {
            userId,
            eventId: event.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'calendar event monitor callback rejected',
        );
      });
  }
}

// ---------------------------------------------------------------------------
// inspectCalendarEvent — callback body (registered at boot)
// ---------------------------------------------------------------------------

/**
 * Dependencies for inspectCalendarEvent (same as TriggerFireDeps).
 */
export type CalendarMonitorDeps = TriggerFireDeps;

/**
 * Main callback body — invoked via fire-and-forget after every reverse-sync event.
 *
 * 1. Calls detectCalendarTrigger (pure detect).
 * 2. If trigger detected, calls dispatchTrigger with CALENDAR_TRIGGER_DELAY_MS (R5).
 *    The 5-min delay allows the user to see their calendar item first.
 *    Post-delay rate-limit re-check handles quiet mode set during wait window.
 *
 * Failures are logged and silently swallowed — must not block calendar sync.
 * ADR 020 D17 boot-wiring lint asserts the registered callback calls this function.
 */
export async function inspectCalendarEvent(
  deps: CalendarMonitorDeps,
  userId: number,
  event: CalendarEventInput,
): Promise<void> {
  try {
    const trigger = detectCalendarTrigger(event);

    if (!trigger) {
      log.debug({ userId, eventId: event.id }, 'calendarMonitor: no trigger detected');
      return;
    }

    // Stamp userId (was 0 placeholder in pure detect)
    const stampedTrigger: TriggerRecord = { ...trigger, userId };

    log.info(
      { userId, eventId: event.id, itemId: event.itemId, triggerType: trigger.triggerType },
      'calendarMonitor: trigger detected, dispatching with delay',
    );

    // R5: dispatch with 5-min delay; post-delay rate-limit re-check is inside dispatchTrigger
    await dispatchTrigger(deps, stampedTrigger, { delayMs: CALENDAR_TRIGGER_DELAY_MS });
  } catch (err) {
    log.error(
      {
        userId,
        eventId: event.id,
        err: err instanceof Error ? err.message : String(err),
      },
      'calendarMonitor: inspectCalendarEvent threw — swallowed',
    );
  }
}
