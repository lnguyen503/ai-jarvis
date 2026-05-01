import Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Tool, ToolContext, ToolResult, ToolDeps } from './types.js';
import { child } from '../logger/index.js';

// ---------------------------------------------------------------------------
// Untrusted-content tool set (D19 — ADR 018-revisions R1; closes pre-existing
// prompt-injection-defense gap at the dispatcher level). System-wide retrofit.
// Pre-v1.18.0 behavior: scrubber + truncate ran but NO <untrusted> wrap at
// dispatch. Module-level callers (organize/injection.ts, plan/synthesizer.ts)
// wrapped on their own paths. This constant moves the wrap to the single choke
// point so all future tool consumers get it for free.
// ---------------------------------------------------------------------------

/**
 * Tools whose output MUST be wrapped in <untrusted> because they contain
 * externally-sourced content that could carry prompt-injection payloads.
 * Closed set: adding a new external-content tool requires a one-line addition here.
 */
const UNTRUSTED_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  'web_search',     // Tavily SERP results — adversarial-by-default
  'browse_url',     // Playwright browser fetch — most exposed surface
  'read_file',      // file system content — could be hostile if user wrote it
  'list_directory', // file names — smaller surface but per the doc
  'search_files',   // glob-result file names + lines — same risk class
  'recall_archive', // archived prior-conversation content — could contain past hostile content
]);

/**
 * Sanitize a value for inclusion as an XML attribute.
 * - Accepts only string / number / boolean primitives.
 * - Strips nested objects / arrays (not safe to serialize inline).
 * - Truncates to 80 chars.
 * - Escapes `"` → `&quot;` and `<` → `&lt;` to keep the XML well-formed.
 */
function sanitizeArgValue(v: unknown): string {
  if (typeof v === 'string') {
    return v.slice(0, 80).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return '[object]';
}

/**
 * Build an XML attribute string from a record of tool args.
 * Only scalar primitives are included; nested objects are omitted.
 * Total args string is truncated at 200 chars per R1-9.
 */
function buildArgsAttr(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'object' && v !== null) continue; // skip nested objects
    parts.push(`${k}="${sanitizeArgValue(v)}"`);
  }
  const joined = parts.join(' ');
  return joined.slice(0, 200);
}

/**
 * Strip any literal </untrusted> (and opening <untrusted...>) sequences from
 * within the tool output so that injected closing-tag attacks cannot break the
 * wrapper structure. Replace with [stripped].
 * Defense: per prompt-injection-defense implementation checklist.
 */
function stripUntrustedTags(output: string): string {
  return output.replace(/<\/?untrusted[^>]*>/gi, '[stripped]');
}

/**
 * Wrap tool output in <untrusted> boundary tags (D19, ADR 018-revisions R1).
 * Only applied for toolName ∈ UNTRUSTED_CONTENT_TOOLS.
 * Returns the original output unchanged for all other tools.
 */
export function wrapUntrustedToolOutput(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): string {
  if (!UNTRUSTED_CONTENT_TOOLS.has(toolName)) return output;
  const argsAttr = buildArgsAttr(args);
  const safeOutput = stripUntrustedTags(output);
  const openTag = argsAttr.length > 0
    ? `<untrusted source="${toolName}" ${argsAttr}>`
    : `<untrusted source="${toolName}">`;
  return `${openTag}\n${safeOutput}\n</untrusted>`;
}

import { SPECIALIST_TOOL_ALLOWLIST } from '../config/botIdentity.js';
import runCommandTool from './run_command.js';
import readFileTool from './read_file.js';
import writeFileTool from './write_file.js';
import listDirectoryTool from './list_directory.js';
import searchFilesTool from './search_files.js';
import systemInfoTool from './system_info.js';
import webSearchTool from './web_search.js';
import recallArchiveTool from './recall_archive.js';
import sendFileTool from './send_file.js';
import { updateMemoryTool } from './update_memory.js';
import { forgetMemoryTool } from './forget_memory.js';
import { buildCalendarListEventsTool } from './calendar_list_events.js';
import { buildCalendarCreateEventTool } from './calendar_create_event.js';
import { buildCalendarUpdateEventTool } from './calendar_update_event.js';
import { buildCalendarDeleteEventTool } from './calendar_delete_event.js';
import { buildGmailSearchTool } from './gmail_search.js';
import { buildGmailReadTool } from './gmail_read.js';
import { buildGmailDraftTool } from './gmail_draft.js';
import { buildBrowseUrlTool } from './browse_url.js';
import { buildOrganizeCreateTool } from './organize_create.js';
import { buildOrganizeUpdateTool } from './organize_update.js';
import { organizeCompleteTool } from './organize_complete.js';
import { organizeListTool } from './organize_list.js';
import { organizeLogProgressTool } from './organize_log_progress.js';
import { buildOrganizeDeleteTool } from './organize_delete.js';
import { scheduleTool } from './schedule.js';
import {
  coachLogNudge,
  coachLogResearch,
  coachLogIdea,
  coachLogPlan,
  coachReadHistory,
} from '../coach/coachTools.js';
import { coachLogUserOverride } from '../coach/coachOverrideTool.js';
import { delegateToSpecialistTool } from './delegate_to_specialist.js';

// web_fetch is intentionally NOT imported — removed from MVP per CP1/C8 + ADR 002 addendum

const log = child({ component: 'tools' });

let _tools: Tool[] = [];

/**
 * Register all built-in tools, plus MCP-discovered tools if provided.
 * web_fetch is NOT registered when config.web.enabled === false (default).
 * web_search (Tavily) is registered when config.tavily.enabled === true.
 * mcpTools are merged in at the end if provided (discovered at boot).
 * Returns the ordered list of registered tools.
 */
export function registerTools(_deps: ToolDeps, mcpTools: Tool[] = []): Tool[] {
  const tools: Tool[] = [
    runCommandTool,
    readFileTool,
    writeFileTool,
    listDirectoryTool,
    searchFilesTool,
    systemInfoTool,
  ];

  // web_fetch: conditionally registered only when explicitly enabled
  // Default is false; enabling it requires a non-empty allowedHosts list
  if (_deps.config.web.enabled && _deps.config.web.allowedHosts.length > 0) {
    // Future: import and register webFetchTool here
    log.warn({}, 'web.enabled=true but web_fetch tool is not implemented in MVP');
  }

  // recall_archive: always registered — read-only SQLite tool, safe in all modes
  tools.push(recallArchiveTool);

  // send_file: always registered — path-gated by isReadAllowed; allowed in group mode
  tools.push(sendFileTool);

  // v1.8.5: persistent per-user memory tools. Always registered — they
  // self-gate on ctx.userId being available (no-op if missing). Privacy
  // filter at write-time rejects sensitive content (phone, email, creds).
  tools.push(updateMemoryTool as Tool);
  tools.push(forgetMemoryTool as Tool);

  // Tavily web_search: registered when tavily.enabled === true
  if (_deps.config.tavily?.enabled) {
    tools.push(webSearchTool);
    log.info({}, 'Tavily web_search tool registered');
  }

  // Google Calendar tools: registered when google.enabled && google.calendar.enabled.
  // All Google tools are admin-only by construction (set on the Tool object) —
  // never visible in group chats regardless of role.
  if (_deps.config.google?.enabled && _deps.config.google.calendar.enabled) {
    tools.push(buildCalendarListEventsTool(_deps));
    tools.push(buildCalendarCreateEventTool(_deps));
    tools.push(buildCalendarUpdateEventTool(_deps));
    tools.push(buildCalendarDeleteEventTool(_deps));
    log.info({}, 'Google calendar tools registered (admin-only): list_events, create_event, update_event, delete_event');
  }

  // Google Gmail tools: registered when google.enabled && google.gmail.enabled.
  // Admin-only like Calendar.
  //
  // - gmail_search + gmail_read: always on when gmail is enabled (gmail.readonly scope)
  // - gmail_draft: additionally gated on google.gmail.send.enabled. There is
  //   NO gmail_send tool; gmail_draft only stages a draft. The actual send
  //   happens via the gateway's CONFIRM SEND interceptor after the user
  //   explicitly approves. This architecture keeps the LLM out of the send
  //   decision entirely — even if it decided to "send", it structurally cannot.
  if (_deps.config.google?.enabled && _deps.config.google.gmail.enabled) {
    tools.push(buildGmailSearchTool(_deps));
    tools.push(buildGmailReadTool(_deps));
    const sendBits: string[] = [];
    if (_deps.config.google.gmail.send.enabled) {
      tools.push(buildGmailDraftTool(_deps));
      sendBits.push('draft');
    }
    log.info(
      { sendEnabled: _deps.config.google.gmail.send.enabled },
      `Google gmail tools registered (admin-only): search, read${sendBits.length ? ', ' + sendBits.join(', ') : ''}`,
    );
  }

  // Headless browser tool (v1.7.14): autonomous web research via Playwright.
  // Admin-only. Fresh incognito context per call — no cookies, no login
  // state survives across invocations.
  if (_deps.config.browser?.enabled) {
    tools.push(buildBrowseUrlTool(_deps));
    log.info({}, 'Browser tool registered (admin-only): browse_url');
  }

  // v1.8.6: organize tools — always registered; scoped to DM-only by the
  // group-mode tool filter in agent/index.ts (organize_* names filtered out
  // in group turns). adminOnly:false — per-user feature, not admin-gated.
  tools.push(buildOrganizeCreateTool(_deps) as Tool);
  tools.push(buildOrganizeUpdateTool(_deps) as Tool);
  tools.push(organizeCompleteTool as Tool);
  tools.push(organizeListTool as Tool);
  tools.push(organizeLogProgressTool as Tool);
  tools.push(buildOrganizeDeleteTool(_deps) as Tool);
  log.info({}, 'Organize tools registered (adminOnly:false, DM-only via agent filter): create, update, complete, list, log_progress, delete');

  // v1.10.0: schedule tool — create recurring scheduled tasks. adminOnly:false (per-user feature).
  // Added to config.groups.disabledTools default so it is filtered in group mode by default;
  // users schedule via DM and manage via /scheduled.
  tools.push(scheduleTool as Tool);
  log.info({}, 'Schedule tool registered (adminOnly:false, group-mode filtered via disabledTools config)');

  // v1.18.0 ADR 018: coach tools — five tools for the autonomous life-coach agent.
  // Always registered; filtered by config.coach.disabledTools in the agent's coach-turn path
  // and by groups.disabledTools in group mode (like organize_* and schedule).
  // adminOnly:false — per-user feature, not admin-gated.
  tools.push(coachLogNudge as Tool);
  tools.push(coachLogResearch as Tool);
  tools.push(coachLogIdea as Tool);
  tools.push(coachLogPlan as Tool);
  tools.push(coachReadHistory as Tool);
  // v1.19.0 R3: coach_log_user_override — callable from coach turns AND explicit /coach back-off|push|defer commands.
  // NOT auto-invoked from arbitrary chat turns (parser is pure; tool is the gated write path).
  // ADR 019 019-revisions-after-cp1 R3/W1: tool uses same NUL-ban + char caps + sole-writer as other coach tools.
  // ADR 019 D2: do NOT add to coach.disabledTools — this is how coach records user overrides (needs to be callable).
  tools.push(coachLogUserOverride as Tool);
  log.info({}, 'Coach tools registered (adminOnly:false, DM-only, group-mode filtered): log_nudge, log_research, log_idea, log_plan, read_history, log_user_override');

  // v1.22.14: delegate_to_specialist — orchestrator-only delegation primitive.
  // Always registered; the agent loop filters it OUT of activeTools except in
  // group + assemble + full-scope contexts. The dispatcher's allowedToolNames
  // gate (GATE 2) drops calls in any other context. GATE 1 drops calls from
  // any specialist bot (not in SPECIALIST_TOOL_ALLOWLIST).
  tools.push(delegateToSpecialistTool as Tool);
  log.info({}, 'Delegate tool registered (filtered into activeTools only in assemble mode for orchestrator)');

  // MCP-discovered tools: merged in (already adapted + prefixed)
  if (mcpTools.length > 0) {
    tools.push(...mcpTools);
    log.info({ count: mcpTools.length, names: mcpTools.map((t) => t.name) }, 'MCP tools merged');
  }

  _tools = tools;
  log.info({ count: tools.length, names: tools.map((t) => t.name) }, 'Tools registered');
  return tools;
}

/**
 * Convert zod-based tool definitions to Anthropic Claude tool format.
 * Uses zod-to-json-schema for the input_schema conversion.
 */
export function toClaudeToolDefs(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool) => {
    // zod-to-json-schema gives us the JSON Schema representation
    const jsonSchema = zodToJsonSchema(tool.parameters, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;

    // Remove $schema key — Claude doesn't need it
    delete jsonSchema['$schema'];

    return {
      name: tool.name,
      description: tool.description,
      input_schema: jsonSchema as Anthropic.Tool['input_schema'],
    };
  });
}

/**
 * Dispatch a tool call: validate input, enforce safety, execute, scrub output, truncate.
 * Logs tool dispatch at info level.
 *
 * Three gates fire in BROADEST → NARROWEST scope order (CP1 W1 BINDING):
 *
 *   GATE 1: per-bot identity (specialist allowlist)   — outermost; structural property
 *             of the process. A specialist bot NEVER calls a non-allowlisted tool,
 *             even if a coach turn or per-turn override would otherwise permit it.
 *   GATE 2: per-turn allowedToolNames                  — middle; per-turn override
 *             (group mode, etc.). V-01 fix.
 *   GATE 3: per-coach-turn coach.disabledTools         — innermost; only fires inside
 *             a coach scheduled/spontaneous fire (ctx.coachTurnCounters defined).
 *
 * Each gate is checked independently; first failure short-circuits.
 * A specialist bot in a coach turn would hit GATE 1 first; coach scope NEVER
 * narrows specialist scope — the per-bot scope ALWAYS wins.
 */
export async function dispatch(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  // GATE 1 (BROADEST scope — per-bot identity).
  // ADR 021 D6 + CP1 W1: specialist bots have a closed-set allowlist enforced at the
  // dispatcher. Fires for every tool call regardless of group/DM/coach/normal context.
  // ctx.botIdentity is optional (backward compat for tests); when undefined the gate is inert.
  if (ctx.botIdentity?.scope === 'specialist' && !SPECIALIST_TOOL_ALLOWLIST.has(name)) {
    log.warn(
      { toolName: name, botName: ctx.botIdentity.name },
      'GATE 1 reject: not in specialist allowlist (TOOL_NOT_AVAILABLE_FOR_BOT)',
    );
    // Audit the rejection (v1.21.0 D18 — bot.tool_unauthorized category).
    if (ctx.memory?.auditLog) {
      try {
        ctx.memory.auditLog.insert({
          category: 'bot.tool_unauthorized',
          detail: { toolName: name, botName: ctx.botIdentity.name, scope: 'specialist' },
        });
      } catch {
        // Best-effort audit — do not block the rejection response.
      }
    }
    return {
      ok: false,
      output:
        `Tool "${name}" is not available for ${ctx.botIdentity.name} (specialist scope). ` +
        `This bot focuses on engineering/build/code tasks. Try @ai-jarvis for ${name}.`,
      error: { code: 'TOOL_NOT_AVAILABLE_FOR_BOT', message: `Tool "${name}" not in specialist allowlist` },
    };
  }

  // GATE 2 (per-turn override scope).
  // V-01 fix: enforce active-tools filter from the current turn.
  // This prevents hallucinated or injected tool_use blocks from executing disabled tools
  // in group mode even if the model emits a tool name that was not in the presented list.
  if (ctx.allowedToolNames !== undefined && !ctx.allowedToolNames.has(name)) {
    log.warn({ toolName: name }, 'GATE 2 reject: not in active-tools filter (UNAUTHORIZED_IN_CONTEXT)');
    return {
      ok: false,
      output: `Tool "${name}" is not available in this context.`,
      error: { code: 'UNAUTHORIZED_IN_CONTEXT', message: `Tool "${name}" not in active tool set` },
    };
  }

  // GATE 3 (per-coach-turn scope, narrowest).
  // ADR 018-revisions R6/F1 (CONVERGENT BLOCKING): coach turn disabledTools gate.
  // Fires only when ctx.coachTurnCounters is defined (i.e., inside a scheduled coach
  // fire). Rejects disabled tools BEFORE the tool body runs — code-level, not prompt.
  // KNOWN_ISSUES.md v1.18.0 invariant 2: "Coach allowlist enforced by code, not prompt."
  if (ctx.coachTurnCounters !== undefined) {
    const coachDisabled: string[] = ctx.config.coach?.disabledTools ?? [];
    if (coachDisabled.includes(name)) {
      log.warn({ toolName: name }, 'GATE 3 reject: coach.disabledTools (UNAUTHORIZED_IN_CONTEXT)');
      return {
        ok: false,
        output: `Tool "${name}" is not available in a coach turn. The coach can suggest actions; the user confirms.`,
        error: { code: 'UNAUTHORIZED_IN_CONTEXT', message: `Tool "${name}" is in coach.disabledTools` },
      };
    }
  }

  const tool = _tools.find((t) => t.name === name);

  if (!tool) {
    log.warn({ toolName: name }, 'Unknown tool requested');
    return {
      ok: false,
      output: `Unknown tool: "${name}". Available tools: ${_tools.map((t) => t.name).join(', ')}`,
      error: { code: 'UNKNOWN_TOOL', message: `Tool "${name}" not registered` },
    };
  }

  const dispatchLog = ctx.logger.child({ component: 'tools.dispatch', toolName: name });
  dispatchLog.info({ toolName: name }, 'Tool dispatch start');

  // Validate input with zod
  const parsed = tool.parameters.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    dispatchLog.warn({ issues }, 'Tool input validation failed');
    return {
      ok: false,
      output: `Invalid input for tool "${name}": ${issues}`,
      error: { code: 'INVALID_INPUT', message: issues },
    };
  }

  let result: ToolResult;
  try {
    // parsed.data is `unknown` because tool.parameters is ZodTypeAny. We cast
    // to the first parameter of the tool's own execute function — this is the
    // narrowest safe cast: each tool declares its own TInput and zod has already
    // validated the shape matches.
    result = await tool.execute(parsed.data as Parameters<typeof tool.execute>[0], ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dispatchLog.error({ err: message }, 'Tool execute threw');
    return {
      ok: false,
      output: `Tool "${name}" encountered an unexpected error: ${message}`,
      error: { code: 'TOOL_ERROR', message },
    };
  }

  // Scrub secrets from output (C7) — runs on EVERY tool output
  const scrubbedOutput = ctx.safety.scrub(result.output);
  const scrubbedData = result.data ? ctx.safety.scrubRecord(result.data) : undefined;

  // Truncate output to maxOutputLength
  const maxLen = ctx.config.safety.maxOutputLength;
  const truncated =
    scrubbedOutput.length > maxLen
      ? `${scrubbedOutput.slice(0, maxLen)}\n… [truncated]`
      : scrubbedOutput;

  // D19 (ADR 018-revisions R1): wrap external-content tool output in <untrusted> boundary.
  // AFTER scrub + truncate, BEFORE return. Only fires for tools in UNTRUSTED_CONTENT_TOOLS.
  const wrappedOutput = wrapUntrustedToolOutput(name, parsed.data as Record<string, unknown>, truncated);

  dispatchLog.info({ ok: result.ok, outputLen: wrappedOutput.length }, 'Tool dispatch end');

  return {
    ...result,
    output: wrappedOutput,
    data: scrubbedData,
  };
}

/**
 * Return the appropriate tool list for a given context.
 * In group mode, disabled tools are filtered out.
 */
export function toolsForContext(opts: {
  groupMode: boolean;
  disabledTools: string[];
  allTools: Tool[];
}): Tool[] {
  if (!opts.groupMode) return opts.allTools;
  const disabled = new Set(opts.disabledTools);
  return opts.allTools.filter((t) => !disabled.has(t.name));
}

export type { Tool, ToolContext, ToolResult, ToolDeps };
