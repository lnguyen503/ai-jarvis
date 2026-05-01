/**
 * Coach setup and reset-memory routes for the Telegram Web App (v1.18.0 ADR 018 + v1.20.0 ADR 020 D18).
 *
 * Mounts:
 *   POST /api/webapp/coach/setup        — upsert the coach scheduled task for a user
 *   GET  /api/webapp/coach/setup        — return current coach task (banner check)
 *   POST /api/webapp/coach/reset-memory — delete all coach.* keyed-memory entries
 *   GET  /api/webapp/coach/profiles     — return per-profile schedule + quietUntil (D20)
 *
 * Auth: shared chain via authenticateRequest() from items.auth.ts.
 * Audit: coach.setup / coach.reset_memory per successful operation.
 *
 * POST /api/webapp/coach/setup (v1.18.0 back-compat)
 *   Body: { time: 'HH:MM', chatId: number }
 *   Converts time → daily cron expression (MM HH * * *) and calls upsertCoachTask().
 *   Returns: { ok: true, taskId: number, cronExpression: string }
 *   Emits coach.setup audit row.
 *
 * POST /api/webapp/coach/setup (v1.20.0 multi-profile)
 *   Body: { profile: 'morning'|'midday'|'evening'|'weekly', hhmm: 'HH:MM', weekday?: 0-6, chatId: number }
 *   Validates profile against COACH_PROFILES closed set.
 *   For weekly profile: weekday (0=Sun ... 6=Sat) is required.
 *   Returns: { ok: true, taskId: number, cronExpression: string, profile: string }
 *   Emits coach.setup audit row.
 *
 * POST /api/webapp/coach/reset-memory
 *   No body required (confirm=1 query param or body confirm:true triggers actual deletion).
 *   Two-tap: first call without confirm returns { ok: false, code: 'CONFIRM_REQUIRED' }.
 *   Second call with ?confirm=1 or body { confirm: true } → resets and returns { ok: true, deletedCount }.
 *   Emits coach.reset_memory audit row.
 *
 * GET /api/webapp/coach/profiles (v1.20.0 D20)
 *   Returns: { ok: true, profiles: [{ profile, hhmm, weekday?, active }], quietUntil: string|null }
 *   Used by hub banner expanded panel.
 *
 * RESERVED_DESCRIPTION guard:
 *   PATCH /api/webapp/scheduled/:id where task.description === '__coach__' → 400 RESERVED_DESCRIPTION.
 *   This guard lives in scheduled.mutate.ts (not here) but is part of the same commit.
 */

import express, { type Express, type Request, type Response } from 'express';
import { child } from '../logger/index.js';
import { resolveDataDir } from '../config/dataDir.js';
import {
  upsertCoachTask,
  resetCoachMemory,
  COACH_TASK_DESCRIPTION,
  COACH_PROFILES,
  COACH_MARKER_BY_PROFILE,
  isCoachProfile,
} from '../coach/index.js';
import { parseHHMM } from '../coach/profileTypes.js';
import { authenticateRequest, type ItemsRouteDeps } from './items.auth.js';
import { redactIp } from './items.shared.js';

const log = child({ component: 'webapp.coachRoute' });

const BODY_LIMIT = '4kb';

/**
 * Coach routes deps — extends ItemsRouteDeps with scheduler so POST /coach/setup
 * can call scheduler.reload() after upsertCoachTask (v1.18.0 P2 fix Item 3,
 * Scalability WARNING-1.18.0.A — same trap pattern as v1.17.0 WARNING-1.17.0.A).
 *
 * Scheduler is late-bound (chicken-and-egg: gateway builds before scheduler);
 * pass a `{ reload() }` wrapper that is populated via setScheduler() in
 * src/webapp/server.ts. null is accepted for tests that don't need reload.
 */
export interface CoachRouteDeps extends ItemsRouteDeps {
  scheduler: { reload(): void } | null;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

function auditCoachSetup(
  deps: CoachRouteDeps,
  userId: number,
  taskId: number,
  cronExpression: string,
  ip?: string,
): void {
  try {
    deps.memory.auditLog.insert({
      category: 'coach.setup',
      actor_user_id: userId,
      detail: {
        taskId,
        cronExpression,
        ...(ip ? { ip } : {}),
      },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, taskId },
      'Failed to insert coach.setup audit row',
    );
  }
}

function auditCoachResetMemory(
  deps: CoachRouteDeps,
  userId: number,
  deletedCount: number,
  ip?: string,
): void {
  try {
    deps.memory.auditLog.insert({
      category: 'coach.reset_memory',
      actor_user_id: userId,
      detail: {
        deletedCount,
        ...(ip ? { ip } : {}),
      },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId, deletedCount },
      'Failed to insert coach.reset_memory audit row',
    );
  }
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

export function mountCoachRoutes(app: Express, deps: CoachRouteDeps): void {
  const jsonParser = express.json({ limit: BODY_LIMIT });

  // -------------------------------------------------------------------------
  // GET /api/webapp/coach/setup — used by v1.19.0 hub banner to check if coach is on
  // -------------------------------------------------------------------------
  app.get('/api/webapp/coach/setup', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    // Return the first active coach task (legacy or any profile) for banner display
    const tasks = deps.memory.scheduledTasks.listByOwner(userId);
    const coachTask = tasks.find(
      (t) => t.description === COACH_TASK_DESCRIPTION ||
        Object.values(COACH_MARKER_BY_PROFILE).includes(t.description),
    );

    res.status(200).json({ ok: true, task: coachTask ?? null });
  });

  // -------------------------------------------------------------------------
  // GET /api/webapp/coach/profiles — v1.20.0 D20: per-profile schedule for hub banner
  // -------------------------------------------------------------------------
  app.get('/api/webapp/coach/profiles', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const tasks = deps.memory.scheduledTasks.listByOwner(userId);

    const profiles = COACH_PROFILES.map((profile) => {
      const marker = COACH_MARKER_BY_PROFILE[profile];
      const task = tasks.find((t) => t.description === marker);
      if (!task) return { profile, active: false };

      // Parse cron to extract hhmm (and weekday for weekly)
      const parts = (task.cron_expression ?? '').split(' ');
      const minute = parts[0] ?? '0';
      const hour = parts[1] ?? '0';
      const dow = parts[4];
      const hhmm = `${String(parseInt(hour, 10)).padStart(2, '0')}:${String(parseInt(minute, 10)).padStart(2, '0')}`;

      const entry: Record<string, unknown> = { profile, active: true, hhmm };
      if (profile === 'weekly' && dow && dow !== '*') {
        entry['weekday'] = parseInt(dow, 10);
      }
      return entry;
    });

    // Read quietUntil from memory (D8 rate-limit key)
    const dataDir = resolveDataDir(deps.config);
    let quietUntil: string | null = null;
    try {
      const { listEntries } = await import('../memory/userMemoryEntries.js');
      const entries = await listEntries(userId, dataDir);
      const quietEntry = entries.find((e) => e.key === 'coach.global.quietUntil');
      if (quietEntry) {
        const body =
          typeof quietEntry.body === 'string'
            ? (JSON.parse(quietEntry.body) as Record<string, unknown>)
            : (quietEntry.body as Record<string, unknown>);
        const at = body['at'];
        if (typeof at === 'string' && new Date(at).getTime() > Date.now()) {
          quietUntil = at;
        }
      }
    } catch {
      // quiet-mode read failure is non-fatal; banner shows without quiet status
    }

    res.status(200).json({ ok: true, profiles, quietUntil });
  });

  // -------------------------------------------------------------------------
  // POST /api/webapp/coach/setup
  // Accepts EITHER:
  //   v1.18.0 back-compat: { time: 'HH:MM', chatId: number }
  //   v1.20.0 multi-profile: { profile: CoachProfile, hhmm: 'HH:MM', weekday?: 0-6, chatId: number }
  // -------------------------------------------------------------------------
  app.post('/api/webapp/coach/setup', jsonParser, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    const body = req.body as Record<string, unknown>;

    // v1.20.0 D20: heavy-hammer action — remove ALL coach tasks across all profiles
    if (body['action'] === 'mute_all') {
      const allTasks = deps.memory.scheduledTasks.listByOwner(userId);
      const allMarkers = new Set([
        COACH_TASK_DESCRIPTION,
        ...Object.values(COACH_MARKER_BY_PROFILE),
      ]);
      let removedCount = 0;
      for (const t of allTasks) {
        if (allMarkers.has(t.description)) {
          deps.memory.scheduledTasks.remove(t.id);
          removedCount++;
        }
      }
      try { deps.scheduler?.reload(); } catch (reloadErr) {
        log.warn(
          { err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr) },
          'scheduler.reload() failed after mute_all',
        );
      }
      const ip = redactIp(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0');
      try {
        deps.memory.auditLog.insert({
          category: 'coach.setup',
          actor_user_id: userId,
          detail: { action: 'mute_all', removedCount, ...(ip ? { ip } : {}) },
        });
      } catch (auditErr) {
        log.warn(
          { err: auditErr instanceof Error ? auditErr.message : String(auditErr), userId },
          'Failed to insert coach.setup mute_all audit row',
        );
      }
      log.info({ userId, removedCount }, 'coach: mute_all — removed all coach tasks via hub banner');
      res.status(200).json({ ok: true, removedCount });
      return;
    }

    // Detect v1.20.0 multi-profile request vs v1.18.0 back-compat
    const profileRaw = body['profile'];
    const isProfileRequest = profileRaw !== undefined;

    if (isProfileRequest) {
      // -----------------------------------------------------------------------
      // v1.20.0 multi-profile path
      // -----------------------------------------------------------------------
      if (!isCoachProfile(profileRaw)) {
        res.status(400).json({
          ok: false,
          code: 'VALIDATION_ERROR',
          error: `profile must be one of: ${COACH_PROFILES.join(', ')}`,
        });
        return;
      }

      const profile = profileRaw;
      const hhmmRaw = body['hhmm'];
      const parsed = parseHHMM(typeof hhmmRaw === 'string' ? hhmmRaw : '');
      if (!parsed.ok) {
        res.status(400).json({
          ok: false,
          code: 'VALIDATION_ERROR',
          error: 'hhmm must be in HH:MM format (e.g. 08:00, 14:30)',
        });
        return;
      }

      const { hour, minute } = parsed;

      // For weekly profile, weekday is required (0=Sun ... 6=Sat)
      let cronExpression: string;
      if (profile === 'weekly') {
        const weekdayRaw = body['weekday'];
        if (
          typeof weekdayRaw !== 'number' ||
          !Number.isInteger(weekdayRaw) ||
          weekdayRaw < 0 ||
          weekdayRaw > 6
        ) {
          res.status(400).json({
            ok: false,
            code: 'VALIDATION_ERROR',
            error: 'weekday is required for weekly profile and must be 0 (Sun) – 6 (Sat)',
          });
          return;
        }
        cronExpression = `${minute} ${hour} * * ${weekdayRaw}`;
      } else {
        cronExpression = `${minute} ${hour} * * *`;
      }

      const chatIdRaw = body['chatId'];
      if (typeof chatIdRaw !== 'number' || !Number.isInteger(chatIdRaw)) {
        res.status(400).json({
          ok: false,
          code: 'VALIDATION_ERROR',
          error: 'chatId must be an integer',
        });
        return;
      }
      const chatId = chatIdRaw;

      // Upsert using the profile-specific marker as description
      const marker = COACH_MARKER_BY_PROFILE[profile];

      // Remove existing profile task if present
      const tasks = deps.memory.scheduledTasks.listByOwner(userId);
      const existing = tasks.find((t) => t.description === marker);
      if (existing) {
        deps.memory.scheduledTasks.remove(existing.id);
        log.info(
          { userId, existingId: existing.id, profile, cronExpression },
          'coach: removed old profile task for upsert',
        );
      }

      let taskId: number;
      try {
        taskId = deps.memory.scheduledTasks.insert({
          description: marker,
          cron_expression: cronExpression,
          command: '${coach_prompt}',
          chat_id: chatId,
          owner_user_id: userId,
        });
      } catch (err) {
        log.error(
          { userId, profile, cronExpression, err: err instanceof Error ? err.message : String(err) },
          'scheduledTasks.insert failed in POST /coach/setup (profile)',
        );
        res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to set up coach profile task' });
        return;
      }

      try { deps.scheduler?.reload(); } catch (reloadErr) {
        log.warn(
          { err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr), taskId, profile },
          'scheduler.reload() failed after coach profile setup',
        );
      }

      const ip = redactIp(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0');
      auditCoachSetup(deps, userId, taskId, cronExpression, ip);

      log.info({ userId, taskId, profile, cronExpression }, 'coach: profile task upserted via webapp');
      res.status(200).json({ ok: true, taskId, cronExpression, profile });
      return;
    }

    // -----------------------------------------------------------------------
    // v1.18.0 back-compat path: { time: 'HH:MM', chatId: number }
    // -----------------------------------------------------------------------
    const timeRaw = body['time'];
    const chatIdRaw = body['chatId'];

    // Validate time: must be HH:MM format
    if (typeof timeRaw !== 'string' || !/^\d{1,2}:\d{2}$/.test(timeRaw)) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'time must be in HH:MM format',
      });
      return;
    }

    const timeParts = timeRaw.split(':');
    const hour = parseInt(timeParts[0] ?? '0', 10);
    const minute = parseInt(timeParts[1] ?? '0', 10);

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'time out of range: hour 0–23, minute 0–59',
      });
      return;
    }

    if (typeof chatIdRaw !== 'number' || !Number.isInteger(chatIdRaw)) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: 'chatId must be an integer',
      });
      return;
    }

    const chatId = chatIdRaw;
    const cronExpression = `${minute} ${hour} * * *`;

    let taskId: number;
    try {
      taskId = upsertCoachTask(deps.memory, userId, chatId, cronExpression);
    } catch (err) {
      log.error(
        { userId, cronExpression, err: err instanceof Error ? err.message : String(err) },
        'upsertCoachTask failed in POST /coach/setup',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to set up coach task' });
      return;
    }

    // v1.18.0 P2 fix Item 3 (Scalability WARNING-1.18.0.A): same trap pattern as
    // v1.17.0 WARNING-1.17.0.A. Without scheduler.reload(), the new/updated coach
    // task is NOT picked up by node-cron until a pm2 restart, and the user's
    // "Set up Coach Jarvis" tap appears to succeed but the task never fires.
    try { deps.scheduler?.reload(); } catch (reloadErr) {
      log.warn(
        { err: reloadErr instanceof Error ? reloadErr.message : String(reloadErr), taskId },
        'scheduler.reload() failed after coach setup — coach task will fire on next scheduler reload',
      );
    }

    const ip = redactIp(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0');
    auditCoachSetup(deps, userId, taskId, cronExpression, ip);

    log.info({ userId, taskId, cronExpression }, 'coach: task upserted via webapp');
    res.status(200).json({ ok: true, taskId, cronExpression });
  });

  // -------------------------------------------------------------------------
  // POST /api/webapp/coach/reset-memory
  // Two-tap pattern: first call → CONFIRM_REQUIRED; second call with confirm=1 → execute
  // -------------------------------------------------------------------------
  app.post('/api/webapp/coach/reset-memory', jsonParser, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    const auth = authenticateRequest(req, res, deps);
    if (!auth.ok) return;
    const { userId } = auth;

    // Two-tap: check for confirm=1 query param or body { confirm: true }
    const confirmQuery = req.query['confirm'];
    const body = req.body as Record<string, unknown> | null | undefined;
    const confirmBody = body && body['confirm'];
    const confirmed = confirmQuery === '1' || confirmBody === true || confirmBody === 1;

    if (!confirmed) {
      res.status(200).json({
        ok: false,
        code: 'CONFIRM_REQUIRED',
        error: 'Pass ?confirm=1 or body { confirm: true } to confirm reset',
      });
      return;
    }

    const dataDir = resolveDataDir(deps.config);

    let deletedCount: number;
    try {
      deletedCount = await resetCoachMemory(userId, dataDir);
    } catch (err) {
      log.error(
        { userId, err: err instanceof Error ? err.message : String(err) },
        'resetCoachMemory failed in POST /coach/reset-memory',
      );
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', error: 'Failed to reset coach memory' });
      return;
    }

    const ip = redactIp(req.ip ?? req.socket.remoteAddress ?? '0.0.0.0');
    auditCoachResetMemory(deps, userId, deletedCount, ip);

    log.info({ userId, deletedCount }, 'coach: memory reset via webapp');
    res.status(200).json({ ok: true, deletedCount });
  });
}
