import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../config/index.js';
import type { BotIdentity } from '../config/botIdentity.js';
import {
  SPECIALIST_TOOL_ALLOWLIST,
  BOT_NAMES,
  BOT_DOMAINS,
  BOT_TELEGRAM_USERNAMES,
} from '../config/botIdentity.js';
import type { Tool } from '../tools/types.js';

/**
 * Compose the Claude system prompt from a persona template + runtime context.
 * Template variables are replaced at call time.
 *
 * v1.21.0 changes (D5 + R3 + R4):
 *   - Reads from `botIdentity.personaPath` instead of hardcoded `config/system-prompt.md`.
 *   - Replaces `{{TOOL_LIST}}` with the rendered list of allowed tools (SSOT — no hardcoded names).
 *   - Replaces `{{BOT_NAME}}` with the bot's name for self-reference in persona.
 *   - Persona path defaults to `config/personas/ai-jarvis.md` if botIdentity is not provided
 *     (backward compat for call sites that haven't been updated yet).
 *
 * The template file is REQUIRED config. If it is missing at boot, we throw immediately
 * so the operator sees a clear error rather than a silently degraded assistant.
 */
export function buildSystemPrompt(
  cfg: AppConfig,
  identity?: BotIdentity,
  registeredTools?: Tool[],
): string {
  // Resolve persona path: use identity if provided, else fall back to
  // config/personas/ai-jarvis.md, then the legacy config/system-prompt.md.
  let templatePath: string;
  if (identity?.personaPath) {
    templatePath = identity.personaPath;
  } else {
    const personaDir = path.resolve(process.cwd(), 'config', 'personas', 'ai-jarvis.md');
    const legacyPath = path.resolve(process.cwd(), 'config', 'system-prompt.md');
    templatePath = fs.existsSync(personaDir) ? personaDir : legacyPath;
  }

  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Boot failure: required system prompt template not found at "${templatePath}". ` +
        `Create the file or restore it from the repository. (${message})`,
    );
  }

  // Build template variable replacements.
  const projectsContext = cfg.projects
    .map((p) => `- **${p.name}**: \`${p.path}\``)
    .join('\n');

  const now = new Date().toISOString();
  const cwd = process.cwd();
  const botName = identity?.name ?? 'ai-jarvis';

  // {{TOOL_LIST}} — rendered from the SSOT (registeredTools + identity.scope).
  // R4 + W2 BINDING: persona files MUST NOT hardcode tool names. Use this block.
  const toolList = renderToolList(identity, registeredTools ?? []);

  // {{AVAILABLE_SPECIALISTS}} — v1.22.0. Renders the roster of currently-
  // deployed specialist bots (those with non-empty Telegram usernames).
  // When called from a specialist's persona, excludes the calling bot so
  // they see their PEERS, not themselves. When called from the orchestrator's
  // persona, shows the full specialist list.
  const specialistRoster = renderAvailableSpecialists(identity?.name);

  return template
    .replace(/\{\{PROJECTS_CONTEXT\}\}/g, projectsContext || '(no projects configured)')
    .replace(/\{\{CURRENT_DATETIME\}\}/g, now)
    .replace(/\{\{WORKING_DIRECTORY\}\}/g, cwd)
    .replace(/\{\{SYSTEM_INFO\}\}/g, `Node.js ${process.version} on Windows`)
    .replace(/\{\{BOT_NAME\}\}/g, botName)
    .replace(/\{\{TOOL_LIST\}\}/g, toolList)
    .replace(/\{\{AVAILABLE_SPECIALISTS\}\}/g, specialistRoster);
}

/**
 * Render the orchestrator's specialist roster for the
 * `{{AVAILABLE_SPECIALISTS}}` template variable. Filters BOT_NAMES to those
 * with a non-empty Telegram username (i.e., currently deployed) and a
 * non-empty domain (i.e., specialist scope). Result is markdown.
 *
 * Example output:
 *   - **@your_tony_bot** (Tony) — engineering: code review, file inspection, builds
 *   - **@ai_Natasha_bot** (Natasha) — research: web search, fact-checking
 */
function renderAvailableSpecialists(excludeBotName?: string): string {
  const lines: string[] = [];
  for (const name of BOT_NAMES) {
    if (excludeBotName !== undefined && name === excludeBotName) continue;
    const username = BOT_TELEGRAM_USERNAMES[name];
    const domain = BOT_DOMAINS[name];
    if (username.length === 0 || domain.length === 0) continue;
    // Display nickname is the BotName with "ai-" stripped + capitalized.
    const nick = name.replace(/^ai-/, '').replace(/^./, (c) => c.toUpperCase());
    lines.push(`- **@${username}** (${nick}) — ${domain}`);
  }
  if (lines.length === 0) {
    return '_(no other specialists currently deployed)_';
  }
  return lines.join('\n');
}

/**
 * Render the tool list for the `{{TOOL_LIST}}` template variable.
 *
 * For scope='full': all registered tools.
 * For scope='specialist': intersection of registered tools AND SPECIALIST_TOOL_ALLOWLIST.
 *
 * Output: markdown list, one tool per line, name + first-line of description.
 */
function renderToolList(identity: BotIdentity | undefined, registeredTools: Tool[]): string {
  if (registeredTools.length === 0) {
    return '_(tools not loaded at prompt-build time)_';
  }

  const scope = identity?.scope ?? 'full';
  const allowedSet = scope === 'specialist' ? SPECIALIST_TOOL_ALLOWLIST : null;

  const filtered = allowedSet === null
    ? registeredTools
    : registeredTools.filter((t) => allowedSet.has(t.name));

  if (filtered.length === 0) {
    return '_(no tools available for this scope)_';
  }

  return filtered
    .map((t) => `- **${t.name}** — ${t.description.split('\n')[0]}`)
    .join('\n');
}
