/**
 * Skill-invocation command handler (v1.8.2).
 *
 * Shared entry point for /research, /fix, /build (and /plan as a /research
 * alias). Each skill provides its own planner prompt + task-brief template;
 * this handler orchestrates the common pipeline around them:
 *   1. parse the --claude flag
 *   2. post the live panel message
 *   3. call planner → task list
 *   4. hand off to executor (task loop + synthesizer + auto-deliver)
 *
 * Admin-only in groups (mirrors /clear, /audit, /model).
 * One concurrent skill-run per chat. A second invocation while one is
 * running is rejected with the active plan_id.
 */

import path from 'node:path';
import type { Context } from 'grammy';
import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { MessagingAdapter } from '../messaging/adapter.js';
import type { AgentApi } from '../agent/index.js';
import type { ModelProvider } from '../providers/types.js';
import type { SkillDefinition } from '../skill/types.js';
import { isGroupChat } from '../gateway/groupGate.js';
import { workspacePathForChat } from '../safety/workspaces.js';
import { planGoal } from '../plan/planner.js';
import { executePlan } from '../plan/executor.js';
import { renderPanel, panelButtons } from '../plan/panel.js';
import type { InlineKeyboard } from '../messaging/adapter.js';
import type { Plan, PlanTask } from '../plan/types.js';
import { child } from '../logger/index.js';

const log = child({ component: 'commands.plan' });

/** chatId -> active plan_id. Used to enforce one plan per chat AND to
 *  look up a running plan when a callback button (Cancel) fires. */
const activePlans = new Map<number, string>();

/**
 * planId -> { plan, abortController }. Populated when a plan starts running
 * and cleared when execution completes. Enables /cancel via inline button
 * without the command handler needing to know about gateway internals.
 */
interface ActivePlanEntry {
  plan: Plan;
  abortController: AbortController;
  /** Set when the plan is waiting on the user to tap approve / deny. */
  approvalResolve?: (approved: boolean) => void;
}
const runningPlans = new Map<string, ActivePlanEntry>();

/**
 * planId -> Plan (terminal state: completed / failed / cancelled). Small
 * cache (last 20 plans) so terminal-state button actions (Send Again,
 * Re-run with Sonnet) can look up the report path + original goal. Entries
 * are dropped FIFO. Not a persistent store — lost on restart.
 */
const recentPlans = new Map<string, Plan>();
const RECENT_PLANS_CACHE_SIZE = 20;

function rememberPlan(plan: Plan): void {
  recentPlans.set(plan.id, plan);
  while (recentPlans.size > RECENT_PLANS_CACHE_SIZE) {
    const first = recentPlans.keys().next().value;
    if (first === undefined) break;
    recentPlans.delete(first);
  }
}

/** Lookup helper — used by the gateway callback_query handler. */
export function getPlanForButton(planId: string): Plan | undefined {
  return runningPlans.get(planId)?.plan ?? recentPlans.get(planId);
}

/** Cancel helper — signals abort to the running plan's executor. Returns
 *  true if a running plan was found and cancelled. */
export function cancelPlanById(planId: string): boolean {
  const entry = runningPlans.get(planId);
  if (!entry) return false;
  entry.abortController.abort();
  return true;
}

export interface PlanCommandDeps {
  config: AppConfig;
  memory: MemoryApi;
  agent: AgentApi;
  adapter: MessagingAdapter;
  /** Ollama provider used by the multi-model synthesis pass. */
  ollama: ModelProvider;
}

/**
 * Shared handler for every skill-invocation command.
 * The gateway wires up command-specific wrappers that pass the skill.
 */
export async function handleSkillInvocation(
  ctx: Context,
  deps: PlanCommandDeps,
  skill: SkillDefinition,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined) return;

  // Admin gating in groups.
  if (isGroupChat(ctx)) {
    if (!deps.config.groups.adminUserIds.includes(userId ?? -1)) {
      await ctx.reply('Admin only.').catch(() => {});
      return;
    }
  }

  const text = ctx.message?.text ?? '';
  // Match any of the registered skill commands (plus /plan alias).
  let rest = text.replace(/^\/(research|plan|fix|build)(@\S+)?\s*/, '').trim();

  // Optional leading flag: --claude (default Haiku) or --sonnet (escalated).
  // --claude / -c / --deep all default to Haiku 4.5 — cheap and plenty
  // capable for tool-driven research. --sonnet picks the more expensive
  // Sonnet 4.6 for genuinely hard reasoning tasks.
  let forceProvider: 'claude' | undefined;
  let forceModel: string | undefined;
  let requireApproval = false;

  // Flag parsing is order-agnostic: each flag can appear at the front of
  // the remaining text. Loop until no known flag matches.
  for (;;) {
    const sonnetFlag = /^--sonnet\s+/i.exec(rest);
    const claudeFlag = /^(--claude|--deep|-c)\s+/i.exec(rest);
    const approveFlag = /^(--approve|-a)\s+/i.exec(rest);
    if (sonnetFlag) {
      forceProvider = 'claude';
      forceModel = deps.config.ai.premiumModel; // "claude-sonnet-4-6"
      rest = rest.slice(sonnetFlag[0].length).trim();
    } else if (claudeFlag) {
      forceProvider = 'claude';
      forceModel = 'claude-haiku-4-5'; // ~3× cheaper than sonnet, plenty for tool loops
      rest = rest.slice(claudeFlag[0].length).trim();
    } else if (approveFlag) {
      requireApproval = true;
      rest = rest.slice(approveFlag[0].length).trim();
    } else {
      break;
    }
  }

  const goal = rest;
  if (!goal) {
    await ctx.reply(usageFor(skill));
    return;
  }

  return runSkill(ctx, deps, skill, goal, {
    forceProvider,
    forceModel,
    requireApproval,
  });
}

/**
 * Execute a skill run with already-parsed options. Called both from
 * handleSkillInvocation (parsed from a Telegram command) and from
 * handlePlanButton's plan.rerun-sonnet action (parsed from a prior plan's
 * record). Separating this from the command handler means button-triggered
 * reruns can't be tricked by a goal that starts with flag-shaped prose.
 *
 * Assumes caller has already authorized the request (admin gating in
 * group chats lives in the command / button handlers, not here).
 */
async function runSkill(
  ctx: Context,
  deps: PlanCommandDeps,
  skill: SkillDefinition,
  goal: string,
  opts: {
    forceProvider?: 'claude';
    forceModel?: string;
    requireApproval: boolean;
  },
): Promise<void> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined) return;

  const { forceProvider, forceModel, requireApproval } = opts;

  // One plan per chat.
  const existing = activePlans.get(chatId);
  if (existing) {
    await ctx.reply(`A ${skill.label.toLowerCase()} is already running in this chat: ${existing}\nWait for it to finish (up to 15 min).`);
    return;
  }

  // Resolve plan directory under the chat workspace.
  const wsRoot = workspacePathForChat(chatId, deps.config);
  if (!wsRoot) {
    await ctx.reply('Workspaces are disabled in config — cannot create a plan directory. Enable `workspaces.enabled` first.');
    return;
  }
  const planId = makePlanId();
  const planDir = path.join(wsRoot, 'plans', planId);

  // Post the initial panel message so we have a message_id to edit later.
  const initialPlan: Plan = {
    id: planId,
    goal,
    planDir,
    chatId,
    panelMessageId: 0, // filled in immediately below
    tasks: [],
    startedAt: Date.now(),
    status: 'planning',
    forceProvider,
    skill,
  };
  const initialText = `🤖 ${skill.label}: ${goal.slice(0, 200)}\n   id: ${planId} · planning…`;
  let panel;
  try {
    panel = await deps.adapter.sendMessage(chatId, initialText);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), planId, skill: skill.name }, 'Failed to post initial panel');
    await ctx.reply('Failed to start plan (could not post panel message).').catch(() => {});
    return;
  }
  initialPlan.panelMessageId = panel.messageId;

  // Decompose goal into tasks using the skill's planner prompt.
  const abortController = new AbortController();
  let titles: string[];
  try {
    titles = await planGoal(goal, skill, deps.config, abortController.signal);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), planId, skill: skill.name }, 'Planner errored');
    await editSafe(deps.adapter, chatId, panel.messageId, `❌ Planner failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (titles.length === 0) {
    await editSafe(deps.adapter, chatId, panel.messageId, `❌ Could not decompose this request into a ${skill.label.toLowerCase()} plan. Try rephrasing or adding more detail.`);
    return;
  }

  initialPlan.tasks = titles.map<PlanTask>((title, i) => ({
    index: i + 1,
    title,
    status: 'pending',
  }));

  // Mark active + register for button lookup.
  activePlans.set(chatId, planId);
  const runEntry: ActivePlanEntry = { plan: initialPlan, abortController };
  runningPlans.set(planId, runEntry);

  // If --approve was passed, show the plan WITH approve/deny buttons and
  // wait for a tap before kicking off execution.
  //
  // MEDIUM fix (2026-04-23 Anti-Slop review): 90s timeout now DENIES on
  // no-response instead of auto-approving. A walked-away user should NOT
  // implicitly green-light a potentially 30-minute Sonnet run. Previous
  // behavior inverted the semantics of the flag.
  if (requireApproval) {
    await editSafe(
      deps.adapter,
      chatId,
      panel.messageId,
      renderPanel(initialPlan) + '\n\n⏸ Awaiting approval (tap a button; auto-CANCELS in 90s if no response).',
      [[
        { label: '✅ Run', data: `plan.approve:${planId}` },
        { label: '❌ Cancel', data: `plan.deny:${planId}` },
      ]],
    );
    const approved = await new Promise<boolean>((resolve) => {
      runEntry.approvalResolve = resolve;
      setTimeout(() => resolve(false), 90_000).unref();
    });
    runEntry.approvalResolve = undefined;
    if (!approved) {
      activePlans.delete(chatId);
      runningPlans.delete(planId);
      initialPlan.status = 'cancelled';
      await editSafe(
        deps.adapter,
        chatId,
        panel.messageId,
        renderPanel(initialPlan) + '\n\n⊘ Cancelled before execution.',
        [],
      );
      return;
    }
  }

  // Push the planned-state panel (with buttons) before kicking off execution.
  await editSafe(deps.adapter, chatId, panel.messageId, renderPanel(initialPlan), panelButtons(initialPlan));

  const session = deps.memory.sessions.getOrCreate(chatId);
  log.info(
    { planId, chatId, sessionId: session.id, taskCount: titles.length, planDir, skill: skill.name },
    'Plan starting execution',
  );

  // Fire-and-forget execution (we already replied; this runs async).
  executePlan({
    plan: initialPlan,
    sessionId: session.id,
    userId,
    chatType: ctx.chat?.type ?? 'private',
    agent: deps.agent,
    adapter: deps.adapter,
    ollama: deps.ollama,
    forceProvider,
    forceModel,
    abortSignal: abortController.signal,
  })
    .catch((err: unknown) => {
      log.error(
        { planId, err: err instanceof Error ? err.message : String(err) },
        'Plan executor threw',
      );
    })
    .finally(() => {
      activePlans.delete(chatId);
      runningPlans.delete(planId);
      rememberPlan(initialPlan);
    });
}

async function editSafe(
  adapter: MessagingAdapter,
  chatId: number,
  messageId: number,
  text: string,
  buttons?: InlineKeyboard,
): Promise<void> {
  try {
    await adapter.editMessageText(chatId, messageId, text, buttons ? { buttons } : undefined);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), chatId, messageId },
      'editMessageText failed',
    );
  }
}

function makePlanId(): string {
  // Short readable id: pl_<6 hex chars>
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `pl_${rand}`;
}

function usageFor(skill: SkillDefinition): string {
  const lowerLabel = skill.label.toLowerCase();
  const common =
    `Flags:\n` +
    `  --claude    use Claude Haiku 4.5 (cheap: ~$0.20-0.50/run)\n` +
    `  --sonnet    use Claude Sonnet 4.6 (deeper: ~$0.50-1.50/run with caching)\n` +
    `  --approve   show the plan and wait for approval before running\n` +
    `Without a flag, tasks run on Ollama Cloud (free under your subscription).\n` +
    `Flags can combine in any order, e.g. /research --approve --sonnet <topic>.`;
  switch (skill.name) {
    case 'research':
      return (
        `Usage: /research [--claude|--sonnet] <topic>\n` +
        `Example: /research the EV charging market in Indianapolis\n` +
        `Example: /research --claude compare Postgres vs SQLite for multi-tenant SaaS\n\n` +
        common
      );
    case 'fix':
      return (
        `Usage: /fix [--claude|--sonnet] <describe the bug or issue>\n` +
        `Example: /fix the nightly backup script is failing on Wednesdays\n` +
        `Example: /fix --claude tests started failing after the last config change\n\n` +
        `Fix mode runs a diagnostic workflow: gather evidence → locate cause → propose/apply a ` +
        `minimal fix → verify. Evidence and diffs are saved to the plan folder.\n\n` +
        common
      );
    case 'build':
      return (
        `Usage: /build [--claude|--sonnet] <what to build>\n` +
        `Example: /build a CLI that converts CSV to JSON with node\n` +
        `Example: /build --claude a small Express server with /users CRUD and SQLite\n\n` +
        `Build mode runs a lightweight construction workflow: design → implement → verify → ` +
        `document. Code is written under the plan folder and delivered with a README.\n\n` +
        common
      );
    default:
      return `Usage: /${skill.name} [--claude|--sonnet] <${lowerLabel} request>`;
  }
}

/** Test hook — clear in-memory active-plan state. */
export function _resetActivePlansForTests(): void {
  activePlans.clear();
  runningPlans.clear();
  recentPlans.clear();
}

/**
 * Handle an inline-button tap on a plan panel. Called by the gateway's
 * callback_query handler. Returns a short toast string to show the user
 * (Telegram pops this up near the button for ~2s).
 *
 * Actions:
 *   - plan.cancel:<id>         → abort running plan
 *   - plan.resend:<id>         → re-send REPORT.md as a document
 *   - plan.rerun-sonnet:<id>   → start a fresh plan with the same goal + Sonnet
 *
 * Admin-only in groups (mirrors the command handler).
 */
export async function handlePlanButton(
  data: string,
  ctx: Context,
  deps: PlanCommandDeps,
): Promise<string> {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined) return 'No chat context.';

  // Admin gating in groups.
  if (isGroupChat(ctx)) {
    if (!deps.config.groups.adminUserIds.includes(userId ?? -1)) {
      return 'Admin only.';
    }
  }

  const [action, planId] = data.split(':');
  if (!action || !planId) return 'Bad button payload.';

  // HIGH-01 fix (2026-04-23 QA review): every action below must verify
  // that the target plan belongs to THIS chat. runningPlans and recentPlans
  // are process-global Maps; without this check, any admin in any chat
  // could drive any plan by id. A cross-tenant leak waiting for the first
  // multi-chat deployment.
  const plan = getPlanForButton(planId);
  if (plan && plan.chatId !== chatId) {
    log.warn(
      { planId, requestChatId: chatId, planChatId: plan.chatId, userId },
      'Button action rejected — chat/plan mismatch',
    );
    return 'Plan not found.';
  }

  if (action === 'plan.approve' || action === 'plan.deny') {
    const entry = runningPlans.get(planId);
    if (!entry) return 'Plan is not waiting for approval.';
    if (entry.plan.chatId !== chatId) return 'Plan not found.';
    if (!entry.approvalResolve) return 'Plan is not waiting for approval.';
    entry.approvalResolve(action === 'plan.approve');
    return action === 'plan.approve' ? 'Starting…' : 'Cancelled.';
  }

  if (action === 'plan.cancel') {
    // cancelPlanById already scopes via runningPlans map lookup, but we
    // re-check the chat binding explicitly for the same reason as above.
    const entry = runningPlans.get(planId);
    if (!entry) return 'Plan is not running.';
    if (entry.plan.chatId !== chatId) return 'Plan not found.';
    const ok = cancelPlanById(planId);
    log.info({ planId, ok, userId }, 'Plan cancel requested via button');
    return ok ? 'Cancelling…' : 'Plan is not running.';
  }

  if (action === 'plan.resend') {
    if (!plan) return 'Plan not found.';
    if (!plan.reportPath) return 'No report to send.';

    // v1.8.4: re-send all three formats (docx + txt + md) the same way
    // the executor delivered them on first completion. .reportPaths is
    // present for runs after v1.8.4; for older completed plans, fall
    // back to just .reportPath (md only).
    const paths = plan.reportPaths
      ? [
          { path: plan.reportPaths.docx, label: 'docx' },
          { path: plan.reportPaths.txt, label: 'txt' },
          { path: plan.reportPaths.md, label: 'md' },
        ]
      : [{ path: plan.reportPath, label: 'md' }];

    const sentPaths = new Set<string>();
    let anySent = false;
    for (const { path: filePath, label } of paths) {
      if (sentPaths.has(filePath)) continue;
      sentPaths.add(filePath);
      try {
        await deps.adapter.sendDocument(chatId, filePath, {
          caption: `📄 ${plan.skill.label} ${plan.id} report (.${label})`,
        });
        anySent = true;
      } catch (err) {
        log.warn(
          { planId, format: label, err: err instanceof Error ? err.message : String(err) },
          'Resend failed for one format',
        );
      }
    }
    log.info({ planId, userId, anySent }, 'Report re-sent via button');
    return anySent ? 'Sent.' : 'Send failed — files may have been deleted.';
  }

  if (action === 'plan.rerun-sonnet') {
    if (!plan) return 'Plan not found.';
    if (activePlans.has(chatId)) {
      return `Another ${plan.skill.label.toLowerCase()} is already running.`;
    }
    // HIGH (Anti-Slop) fix: direct-call the runSkill body with typed
    // parameters instead of concatenating plan.goal into a command string
    // and re-running the flag parser. Previously a goal starting with
    // flag-like prose (e.g. "--approve do X") would silently re-activate
    // the flag on rerun.
    void runSkill(ctx, deps, plan.skill, plan.goal, {
      forceProvider: 'claude',
      forceModel: deps.config.ai.premiumModel, // Sonnet 4.6
      requireApproval: false,
    });
    log.info({ planId, userId, goal: plan.goal }, 'Rerun-with-Sonnet requested via button');
    return 'Starting new run with Sonnet…';
  }

  return 'Unknown action.';
}
