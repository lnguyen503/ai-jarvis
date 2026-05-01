/**
 * Tool: delegate_to_specialist — orchestrator-only delegation primitive (v1.22.14).
 *
 * In Avengers ASSEMBLE mode, the orchestrator (full-scope ai-jarvis) has every
 * specialist tool stripped (read_file, write_file, system_info, run_command, etc.)
 * to force delegation. v1.22.11–v1.22.13 demonstrated that pure prompt pressure
 * is insufficient: the model treated "@-mention" as a missing tool and apologized
 * ("the inter-bot communication tools appear to be unavailable") rather than
 * writing the literal text. This tool gives the model a CONCRETE tool that
 * matches its mental model — call delegate_to_specialist, the gateway posts the
 * @-mention message on its behalf, the specialist's grammY listener picks it up
 * via the existing mention router and responds.
 *
 * The tool is filtered into activeTools ONLY when:
 *   - botIdentity.scope === 'full'  (orchestrator process)
 *   - groupMode === true            (chat is a group, not DM)
 *   - assemble mode is ON           (per-chat /avengers assemble on)
 *
 * In all other contexts the dispatcher's allowedToolNames set rejects calls.
 * Specialists cannot call this tool because GATE 1 (specialist allowlist) drops
 * it before dispatch.
 */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './types.js';
import {
  BOT_NAMES,
  BOT_TELEGRAM_USERNAMES,
  BOT_DOMAINS,
  type BotName,
} from '../config/botIdentity.js';

const SPECIALIST_NAMES = BOT_NAMES.filter((n) => n !== 'ai-jarvis') as readonly BotName[];

const DelegateInput = z.object({
  specialist: z
    .enum(SPECIALIST_NAMES as unknown as [string, ...string[]])
    .describe(
      'Which specialist to delegate to. Pick by domain: ' +
        SPECIALIST_NAMES
          .map((n) => `"${n}" (${BOT_DOMAINS[n]})`)
          .join('; '),
    ),
  request: z
    .string()
    .min(3)
    .max(800)
    .describe(
      'A clear, self-contained one-or-two-sentence request for the specialist. ' +
        'Treat them as a peer agent who CAN see the chat history but should not need ' +
        'to re-read it — restate the ask in their terms. Do NOT include "@" or the ' +
        'specialist\'s username; the tool adds those. Do NOT wrap in quotes.',
    ),
});

type DelegateInputType = z.infer<typeof DelegateInput>;

export const delegateToSpecialistTool: Tool<DelegateInputType> = {
  name: 'delegate_to_specialist',
  description:
    'Hand a task off to another bot in the Avengers ensemble (Tony, Natasha, Bruce). ' +
    'This is the ONLY way to get specialist work done in ASSEMBLE mode — your specialist ' +
    'tools (read_file, system_info, write_file, run_command, web_search, etc.) have been ' +
    'stripped intentionally. Call this tool with the specialist name and a one-sentence ' +
    'request. The gateway posts an @-mention message in the current chat on your behalf; ' +
    'the specialist\'s bot picks it up and responds. After calling the tool, your final ' +
    'reply to the user can be brief ("On it, asking Tony.") — the specialist will deliver ' +
    'the actual work directly into the chat.',

  parameters: DelegateInput,

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.delegate_to_specialist' });

    if (!ctx.telegram) {
      log.error({}, 'delegate_to_specialist: ctx.telegram adapter not available');
      return {
        ok: false,
        output:
          'Delegation is not available in this context (no messaging adapter). ' +
          'This usually means you are in a DM or in a context that does not have a chat to post to.',
        error: { code: 'NO_TELEGRAM_ADAPTER', message: 'ctx.telegram is not set' },
      };
    }

    const specialist = input.specialist as BotName;
    const username = BOT_TELEGRAM_USERNAMES[specialist];

    if (!username || username.trim() === '') {
      log.warn({ specialist }, 'delegate_to_specialist: specialist not deployed');
      return {
        ok: false,
        output:
          `Cannot delegate to ${specialist}: that specialist is not deployed yet ` +
          `(no Telegram username on file). Available specialists with deployed bots: ` +
          SPECIALIST_NAMES
            .filter((n) => BOT_TELEGRAM_USERNAMES[n] && BOT_TELEGRAM_USERNAMES[n].trim() !== '')
            .map((n) => `${n} (${BOT_DOMAINS[n]})`)
            .join('; '),
        error: { code: 'SPECIALIST_NOT_DEPLOYED', message: `${specialist} has no Telegram username` },
      };
    }

    // Format the delegation message. The em-dash separator matches the
    // pattern the persona prompts already document so any reader (human or
    // bot) can scan the chat history consistently.
    const text = `@${username} — ${input.request.trim()}`;

    let messageId: number;
    try {
      const result = await ctx.telegram.sendMessage(ctx.chatId, text);
      messageId = result.messageId;
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const scrubbedMessage = ctx.safety.scrub(rawMessage);
      log.error({ specialist, err: scrubbedMessage }, 'delegate_to_specialist: telegram send failed');
      return {
        ok: false,
        output: `Failed to post the delegation message: ${scrubbedMessage}`,
        error: { code: 'TELEGRAM_ERROR', message: scrubbedMessage },
      };
    }

    // Audit (best-effort — never block on a failed audit insert)
    if (ctx.memory?.auditLog) {
      try {
        ctx.memory.auditLog.insert({
          category: 'bot.delegate',
          actor_user_id: ctx.userId ?? null,
          actor_chat_id: ctx.chatId,
          session_id: ctx.sessionId,
          detail: {
            from: ctx.botIdentity?.name ?? 'unknown',
            to: specialist,
            username,
            messageId,
            requestPreview: input.request.slice(0, 120),
          },
        });
      } catch {
        // Best-effort.
      }
    }

    log.info(
      { specialist, username, messageId, chatId: ctx.chatId },
      'delegate_to_specialist: posted delegation message',
    );

    return {
      ok: true,
      output:
        `Delegated to @${username}. They will respond in this chat. ` +
        `Your final reply to the user can be a brief acknowledgement ` +
        `(e.g. "On it.") — the specialist will deliver the actual work directly.`,
      data: {
        specialist,
        username,
        messageId,
        requestPreview: input.request.slice(0, 120),
      },
    };
  },
};

export default delegateToSpecialistTool;
