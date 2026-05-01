/**
 * Avengers Operations Dashboard webapp API routes (v1.22.27).
 *
 * Mounts:
 *   GET /api/webapp/avengers/plans?chatId=N         — list recent plans for a chat
 *   GET /api/webapp/avengers/plans/:id              — plan detail (plan + steps)
 *   GET /api/webapp/avengers/plans/:id/deliverable  — serve deliverable HTML file
 *
 * Auth: reuses items.auth.ts (HMAC + allowlist).
 * Updates: frontend polls /plans/:id every 2s while plan is active. SSE not
 * required for v1 — polling at 2s is indistinguishable from instant for a
 * status panel and avoids the event-bus plumbing.
 */

import path from 'node:path';
import fs from 'node:fs';
import { type Express, type Request, type Response } from 'express';
import type { ItemsRouteDeps } from './items.auth.js';
import { authenticateRequest } from './items.auth.js';
import { child } from '../logger/index.js';

const log = child({ component: 'webapp.avengers' });

/**
 * v1.22.29 — auth wrapper for the Avengers dashboard routes.
 *
 * Telegram `web_app` inline buttons only work in private chats (per the Bot
 * API docs). In supergroups we use a regular `url` button that opens the
 * dashboard in the user's external browser. Outside Telegram, there's no
 * `Telegram.WebApp.initData` to authenticate with — so we fall back to a
 * lightweight allowlist check: accept the request when `?chatId=<N>` matches
 * one of the bot's `groups.allowedGroupIds` AND the plan's chat_id matches.
 *
 * Security posture (personal-use demo): the public webapp URL is a Cloudflare
 * tunnel with a randomly-generated subdomain. Combined with the requirement
 * that chatId be a member of the allowlist, the surface is comparable to a
 * "secret link" pattern. Acceptable for a single-user deployment.
 *
 * Returns:
 *   - { ok: true, viaInitData: true, userId } when standard tma auth passes
 *   - { ok: true, viaInitData: false, allowedChatId } when fallback accepts
 *   - sends 401/403 + returns { ok: false } when neither path qualifies
 */
type AuthResult =
  | { ok: true; viaInitData: true; userId: number }
  | { ok: true; viaInitData: false; allowedChatId: number }
  | { ok: false };

function authFlexible(req: Request, res: Response, deps: ItemsRouteDeps): AuthResult {
  const authHeader = req.header('authorization') ?? '';
  if (authHeader.startsWith('tma ')) {
    const result = authenticateRequest(req, res, deps);
    if (result.ok) return { ok: true, viaInitData: true, userId: result.userId };
    return { ok: false };
  }

  // Fallback: accept ?chatId=N when chatId is in groups.allowedGroupIds.
  const rawChatId = typeof req.query.chatId === 'string' ? req.query.chatId : '';
  const queryChatId = parseInt(rawChatId, 10);
  if (!Number.isFinite(queryChatId)) {
    deps.auditAuthFailure(req, 'no-auth-header-and-no-chatid');
    res.status(401).json({
      ok: false,
      code: 'AUTH_FAILED',
      error: 'Authorization required. Open from a Telegram bot button, or include ?chatId=N for personal-use access.',
    });
    return { ok: false };
  }

  const allowed = deps.config.groups.allowedGroupIds;
  if (
    !allowed.includes('*' as unknown as number) &&
    !allowed.includes(queryChatId)
  ) {
    res.status(403).json({
      ok: false,
      code: 'CHAT_NOT_ALLOWED',
      error: 'chatId is not in the bot\'s allowed groups.',
    });
    return { ok: false };
  }

  return { ok: true, viaInitData: false, allowedChatId: queryChatId };
}

interface PlanSummary {
  id: number;
  chatId: number;
  task: string;
  status: string;
  todoMessageId: number | null;
  deliverablePath: string | null;
  deliverableMessageId: number | null;
  deliverableFilename: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  stepCount: number;
  doneCount: number;
}

interface PlanStepDetail {
  id: number;
  stepOrder: number;
  botName: string;
  request: string;
  summary: string | null;
  detail: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  /** v1.22.35 — debate-for-accuracy state. */
  debateStatus: 'none' | 'approved' | 'contested';
  debateRounds: number;
}

interface DebateRoundDetail {
  round: number;
  speaker: 'specialist' | 'critic';
  model: string;
  text: string;
  verdict: 'approve' | 'revise' | null;
  createdAt: string;
}

function summarizePlan(deps: ItemsRouteDeps, planId: number): PlanSummary | null {
  const plan = deps.memory.plans.getById(planId);
  if (!plan) return null;
  const steps = deps.memory.plans.stepsFor(planId);
  return {
    id: plan.id,
    chatId: plan.chat_id,
    task: plan.task,
    status: plan.status,
    todoMessageId: plan.todo_message_id,
    deliverablePath: plan.deliverable_path,
    deliverableMessageId: plan.deliverable_message_id,
    deliverableFilename: plan.deliverable_path
      ? plan.deliverable_path.split(/[\\/]/).pop() ?? null
      : null,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    closedAt: plan.closed_at,
    stepCount: steps.length,
    doneCount: steps.filter((s) => s.status === 'done').length,
  };
}

export function mountAvengersRoutes(app: Express, deps: ItemsRouteDeps): void {
  // ---------------------------------------------------------------------------
  // GET /api/webapp/avengers/plans?chatId=N — list plans for a chat
  // ---------------------------------------------------------------------------
  app.get('/api/webapp/avengers/plans', (req: Request, res: Response): void => {
    const auth = authFlexible(req, res, deps);
    if (!auth.ok) return;

    const rawChatId = typeof req.query.chatId === 'string' ? req.query.chatId : '';
    const chatId = parseInt(rawChatId, 10);
    if (!Number.isFinite(chatId)) {
      res.status(400).json({ ok: false, code: 'INVALID_CHAT_ID', error: 'chatId query param required (integer)' });
      return;
    }

    const plans = deps.memory.plans.listForChat(chatId, 25);
    const summaries = plans
      .map((p) => summarizePlan(deps, p.id))
      .filter((s): s is PlanSummary => s !== null);

    res.json({ ok: true, plans: summaries });
  });

  // ---------------------------------------------------------------------------
  // GET /api/webapp/avengers/plans/:id — plan + steps detail
  // ---------------------------------------------------------------------------
  app.get('/api/webapp/avengers/plans/:id', (req: Request, res: Response): void => {
    const auth = authFlexible(req, res, deps);
    if (!auth.ok) return;

    const planId = parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(planId)) {
      res.status(400).json({ ok: false, code: 'INVALID_PLAN_ID', error: 'plan id must be an integer' });
      return;
    }

    const summary = summarizePlan(deps, planId);
    if (!summary) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'plan not found' });
      return;
    }

    // Fallback-auth users can only see plans in their declared chatId.
    if (!auth.viaInitData && summary.chatId !== auth.allowedChatId) {
      res.status(403).json({ ok: false, code: 'PLAN_NOT_IN_CHAT', error: 'plan does not belong to the requested chat' });
      return;
    }

    const stepRows = deps.memory.plans.stepsFor(planId);
    const steps: PlanStepDetail[] = stepRows.map((s) => ({
      id: s.id,
      stepOrder: s.step_order,
      botName: s.bot_name,
      request: s.request,
      summary: s.summary,
      detail: s.detail,
      status: s.status,
      startedAt: s.started_at,
      completedAt: s.completed_at,
      debateStatus: s.debate_status,
      debateRounds: s.debate_rounds,
    }));

    res.json({ ok: true, plan: summary, steps });
  });

  // ---------------------------------------------------------------------------
  // GET /api/webapp/avengers/plans/:id/debates — full debate transcripts
  // (v1.22.35). Returns one entry per step with all rounds in order.
  // ---------------------------------------------------------------------------
  app.get('/api/webapp/avengers/plans/:id/debates', (req: Request, res: Response): void => {
    const auth = authFlexible(req, res, deps);
    if (!auth.ok) return;

    const planId = parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(planId)) {
      res.status(400).json({ ok: false, code: 'INVALID_PLAN_ID', error: 'plan id must be an integer' });
      return;
    }

    const plan = deps.memory.plans.getById(planId);
    if (!plan) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'plan not found' });
      return;
    }
    if (!auth.viaInitData && plan.chat_id !== auth.allowedChatId) {
      res.status(403).json({ ok: false, code: 'PLAN_NOT_IN_CHAT', error: 'plan does not belong to the requested chat' });
      return;
    }

    const stepRows = deps.memory.plans.stepsFor(planId);
    const debatesByStep = stepRows.map((step) => {
      const rounds = deps.memory.plans.debateRoundsFor(step.id);
      return {
        stepId: step.id,
        stepOrder: step.step_order,
        botName: step.bot_name,
        debateStatus: step.debate_status,
        debateRounds: step.debate_rounds,
        rounds: rounds.map<DebateRoundDetail>((r) => ({
          round: r.round,
          speaker: r.speaker,
          model: r.model,
          text: r.text,
          verdict: r.verdict,
          createdAt: r.created_at,
        })),
      };
    });

    res.json({ ok: true, debates: debatesByStep });
  });

  // ---------------------------------------------------------------------------
  // GET /api/webapp/avengers/plans/:id/deliverable — serve the HTML file
  // ---------------------------------------------------------------------------
  app.get('/api/webapp/avengers/plans/:id/deliverable', (req: Request, res: Response): void => {
    const auth = authFlexible(req, res, deps);
    if (!auth.ok) return;

    const planId = parseInt(req.params.id ?? '', 10);
    if (!Number.isFinite(planId)) {
      res.status(400).json({ ok: false, code: 'INVALID_PLAN_ID', error: 'plan id must be an integer' });
      return;
    }

    const plan = deps.memory.plans.getById(planId);
    if (!plan) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'plan not found' });
      return;
    }
    // Fallback-auth users can only download deliverables for plans in their declared chatId.
    if (!auth.viaInitData && plan.chat_id !== auth.allowedChatId) {
      res.status(403).json({ ok: false, code: 'PLAN_NOT_IN_CHAT', error: 'plan does not belong to the requested chat' });
      return;
    }
    if (!plan.deliverable_path) {
      res.status(404).json({ ok: false, code: 'NO_DELIVERABLE', error: 'plan has no deliverable yet' });
      return;
    }

    // Path-safety: only serve files under the bot's own data/<bot>/plans/ dir.
    // The deliverable_path is set by Jarvis's lifecycle code itself, so it's
    // already trusted, but we double-check the prefix to be defensive.
    const expectedPrefix = path.resolve(path.dirname(deps.config.memory.dbPath), 'plans');
    const resolved = path.resolve(plan.deliverable_path);
    if (!resolved.startsWith(expectedPrefix)) {
      log.warn({ planId, deliverablePath: plan.deliverable_path }, 'avengers.deliverable: path outside expected dir');
      res.status(403).json({ ok: false, code: 'PATH_REJECTED', error: 'deliverable path is outside the plans directory' });
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).json({ ok: false, code: 'FILE_MISSING', error: 'deliverable file not on disk' });
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(resolved).pipe(res);
  });

  log.info({}, 'avengers routes mounted: GET /api/webapp/avengers/plans, /:id, /:id/deliverable');
}
