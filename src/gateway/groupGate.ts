/**
 * Group chat activation gate (v1.3, enhanced v1.7.13, v1.21.0 D7).
 *
 * Determines whether Jarvis should respond to a given Telegram update in a
 * group or supergroup context, using a layered decision:
 *
 *   1. Preflight (cheap, deterministic): groups.enabled, allowedGroupIds,
 *      DB-persisted /jarvis_enable state. Fail any → silent.
 *
 *   2. Pending confirmation: if the previous turn ended with Jarvis asking
 *      "were you talking to me?", this message from the same user is a
 *      yes/no response. Promote to 'confirmed' (run the stashed original
 *      text) or clear the pending state and proceed to step 3.
 *
 *   3. Fast deterministic activation (v1.21.0 multi-bot: mention router
 *      takes precedence when botIdentity is wired; legacy "jarvis" keyword
 *      check is the fallback for back-compat):
 *        - @<selfUsername> mention      → 'mention'
 *        - Reply to the bot's own message → 'reply'
 *      Either → proceed.
 *
 *   4. Follow-up heuristic (v1.7.13, free): Jarvis replied to THIS user
 *      within `followUpWindowSeconds`. Treat this message as a silent
 *      conversational continuation. Proceeds as 'follow-up'.
 *
 *   5. LLM intent classifier (v1.7.13, paid): cheap Ollama-Cloud call with
 *      recent chat history. Results:
 *        - high confidence addressed     → proceed as 'intent-high'
 *        - medium confidence             → 'confirm-required' (caller posts
 *                                           "@X were you talking to me?" and
 *                                           stashes the original text via
 *                                           groupState.setPending)
 *        - low confidence / not addressed → silent
 *      Rate-limited per-chat; over the cap → silent.
 *
 *   6. Everything else → silent.
 */

import type { Context } from 'grammy';
import { child } from '../logger/index.js';
import {
  classifyAddressedToBot,
  type IntentResult,
} from './intent.js';
import {
  getPending,
  clearPending,
  interpretConfirmationResponse,
  isFollowUpFromSameUser,
  isIntentDetectionEnabledForChat,
  tryRateLimit,
  getBotSpoke,
} from './groupState.js';
import { shouldThisBotProcess, isAliasMatched } from './mentionRouter.js';
import { detectDirective } from '../avengers/detectDirective.js';
import {
  isGroupChat,
  isJarvisMentioned,
  isReplyToJarvis,
  type GroupActivationResult,
  type GroupGateDeps,
} from './groupGate.types.js';

// Re-export so existing callers can keep importing from this module.
export {
  isGroupChat,
  isJarvisMentioned,
  isReplyToJarvis,
} from './groupGate.types.js';
export type {
  ActivationReason,
  ActivationMode,
  GroupActivationResult,
  GroupGateDeps,
} from './groupGate.types.js';

const log = child({ component: 'gateway.groupGate' });

/**
 * Main group-activation check. Async because the classifier is an optional
 * network call on the ambiguous path.
 */
export async function checkGroupActivation(
  ctx: Context,
  deps: GroupGateDeps,
): Promise<GroupActivationResult> {
  const { config, botUserId, groupSettings } = deps;

  if (!isGroupChat(ctx)) {
    return { proceed: false, reason: 'silent', note: 'not a group chat' };
  }
  if (!config.groups.enabled) {
    return { proceed: false, reason: 'silent', note: 'groups.enabled=false' };
  }

  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const senderName = ctx.from?.first_name ?? ctx.from?.username ?? 'User';
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';

  if (chatId === undefined || userId === undefined) {
    return { proceed: false, reason: 'silent', note: 'missing chat or user id' };
  }

  const isAllowed =
    config.groups.allowedGroupIds.includes('*') ||
    config.groups.allowedGroupIds.includes(chatId);
  if (!isAllowed) {
    return { proceed: false, reason: 'silent', note: 'group not in allowedGroupIds' };
  }

  if (!groupSettings.isEnabled(chatId)) {
    return { proceed: false, reason: 'silent', note: 'group disabled by admin' };
  }

  // --- Step 2: Pending confirmation ---------------------------------------
  // This must come BEFORE the mention check so a yes/no reply isn't double-
  // counted as a fresh activation.
  const pending = getPending(chatId);
  if (pending) {
    const verdict = interpretConfirmationResponse(chatId, userId, text);
    if (verdict === 'yes') {
      clearPending(chatId);
      log.info({ chatId, userId }, 'Pending confirmation → YES');
      return {
        proceed: true,
        reason: 'confirmed',
        dispatchText: pending.userText,
        note: 'yes-response to pending confirm',
      };
    }
    if (verdict === 'no') {
      clearPending(chatId);
      log.info({ chatId, userId }, 'Pending confirmation → NO');
      return { proceed: false, reason: 'silent', note: 'no-response to pending confirm' };
    }
    // 'unclear' or null (different user) — clear the stale pending and fall
    // through to normal gating on the current message.
    if (verdict === 'unclear') {
      clearPending(chatId);
      log.debug({ chatId, userId }, 'Pending confirmation expired (unclear reply)');
    }
  }

  // --- Step 2.5: Directive-driven activation (v1.23.0) -------------------
  // When Boss writes "Tony — X. Bruce — Y." (or similar with em-dash, en-dash,
  // hyphen, colon, comma), this is a deterministic tasking. The bot named
  // here activates in WORK mode with the parsed task; bots NOT named go
  // silent EVEN IF their alias also appears casually elsewhere in the
  // message. This replaces the rule-as-prose §6/§7 persona discipline
  // ("no active task by default") with a deterministic gateway gate.
  if (deps.botIdentity && text.length > 0) {
    const directive = detectDirective(text, deps.botIdentity.name);
    if (directive.hasDirectives) {
      if (directive.thisBotNamed) {
        log.info(
          {
            chatId,
            userId,
            botName: deps.botIdentity.name,
            taskLen: directive.taskForThisBot?.length ?? 0,
            allNamed: directive.allNamedBots,
          },
          'directive routing: activating in WORK mode',
        );
        return {
          proceed: true,
          reason: 'directive',
          mode: 'work',
          directiveTask: directive.taskForThisBot ?? '',
          directive,
        };
      }
      // Directive present, but this bot wasn't named.
      // Exception: Jarvis (orchestrator) still wants to observe the
      // directive event so it can run plan auto-trigger as a side-effect.
      // Returning the directive result lets the gateway side-channel handle
      // plan creation without forcing a chat reply from Jarvis. The actual
      // turn doesn't proceed — Jarvis stays silent unless ALSO @-mentioned.
      log.debug(
        {
          chatId,
          userId,
          botName: deps.botIdentity.name,
          allNamed: directive.allNamedBots,
        },
        'directive routing: not named — silent (others handle the work)',
      );
      return {
        proceed: false,
        reason: 'silent',
        mode: 'banter',
        note: 'directive-for-other-bot',
        directive,
      };
    }
  }

  // --- Step 3: Fast deterministic activation ------------------------------
  // v1.21.0 D7: when botIdentity is wired (multi-bot mode), use the mention
  // router to determine if THIS bot is the addressed recipient. The router
  // handles @<selfUsername>, reply-to-self — replacing the hardcoded
  // "jarvis" keyword check for non-Jarvis bots.
  if (deps.botIdentity && deps.botUsername) {
    const routingResult = shouldThisBotProcess(
      ctx.message as Parameters<typeof shouldThisBotProcess>[0],
      deps.botIdentity,
      botUserId,
      deps.botUsername,
    );
    if (!routingResult.process) {
      // v1.22.1 — Avengers chat mode relaxation. When `/avengers chat on`
      // is active in this chat, specialists may also activate via their
      // own aliases (not just explicit @-mentions). Casual demo mode.
      const avengersChat = deps.groupSettings.getAvengersModes(chatId).chat;
      if (
        avengersChat &&
        deps.botIdentity.scope === 'specialist' &&
        deps.botIdentity.aliases.length > 0
      ) {
        const text = ctx.message?.text ?? ctx.message?.caption ?? '';
        if (text.length > 0 && isAliasMatched(text, deps.botIdentity.aliases)) {
          log.debug(
            { chatId, userId, botName: deps.botIdentity.name },
            'avengers chat mode: specialist alias activated',
          );
          return { proceed: true, reason: 'mention' };
        }
      }

      log.debug(
        { chatId, userId, reason: routingResult.reason, botName: deps.botIdentity.name },
        'mention router: message not addressed to this bot — silent',
      );
      return { proceed: false, reason: 'silent', note: `mention-router: ${routingResult.reason}` };
    }
    // v1.22.23 — assemble-mode collective-alias suppression for specialists.
    // When the user types "Avengers, …" / "team, …" in a chat with assemble
    // mode ON, the collective-alias gate fires every bot. That clashes with
    // the orchestrator-driven flow: Jarvis is supposed to delegate via the
    // tool, then specialists respond to their @-mentions. If specialists
    // also pre-fire on the collective alias, you get 4 disconnected replies
    // instead of one cohesive plan + deliverable.
    //
    // Rule: in assemble mode, collective-alias activation is ORCHESTRATOR-ONLY.
    // Specialists wait for Jarvis to delegate via @-mention.
    // Chat mode keeps the original behavior (everyone chimes in freely).
    if (
      routingResult.reason === 'collective' &&
      deps.botIdentity.scope === 'specialist' &&
      deps.groupSettings.getAvengersModes(chatId).assemble
    ) {
      log.debug(
        { chatId, userId, botName: deps.botIdentity.name },
        'avengers assemble: specialist suppressed on collective alias — waiting for delegation',
      );
      return {
        proceed: false,
        reason: 'silent',
        note: 'collective-alias suppressed for specialist in assemble mode',
      };
    }

    // Mention router says proceed — return with appropriate reason.
    if (routingResult.reason === 'mention') {
      return { proceed: true, reason: 'mention' };
    }
    if (routingResult.reason === 'reply_to_self') {
      return { proceed: true, reason: 'reply' };
    }
    // dm or other affirmative reasons (collective, alias)
    return { proceed: true, reason: 'mention' };
  }

  // Legacy path: bot identity not wired — use existing "jarvis" keyword + reply check.
  const mentioned = isJarvisMentioned(ctx);
  if (mentioned) {
    return { proceed: true, reason: 'mention' };
  }
  const repliedToBot = isReplyToJarvis(ctx, botUserId);
  if (repliedToBot) {
    return { proceed: true, reason: 'reply' };
  }

  // --- Step 4: Follow-up heuristic ----------------------------------------
  const intentCfg = config.groups.intentDetection;
  if (
    isFollowUpFromSameUser(chatId, userId, intentCfg.followUpWindowSeconds)
  ) {
    log.info({ chatId, userId, window: intentCfg.followUpWindowSeconds }, 'Follow-up heuristic activated');
    return { proceed: true, reason: 'follow-up' };
  }

  // --- Step 5: LLM intent classifier --------------------------------------
  if (!intentCfg.enabled) {
    return { proceed: false, reason: 'silent', note: 'intentDetection.enabled=false' };
  }
  if (!isIntentDetectionEnabledForChat(chatId)) {
    return { proceed: false, reason: 'silent', note: '/jarvis_intent off for this chat' };
  }
  if (!tryRateLimit(chatId, intentCfg.rateLimitPerMinute)) {
    log.warn({ chatId, cap: intentCfg.rateLimitPerMinute }, 'Classifier rate limit hit — silent');
    return { proceed: false, reason: 'silent', note: 'classifier rate-limited' };
  }

  const botSpoke = getBotSpoke(chatId);
  const botSpokeRecently =
    botSpoke !== undefined &&
    Date.now() - botSpoke.at <= intentCfg.followUpWindowSeconds * 1000;

  let result: IntentResult;
  try {
    result = await classifyAddressedToBot({
      text,
      senderName,
      recent: deps.getRecentMessages(chatId, intentCfg.recentMessageContext),
      botSpokeRecently,
      provider: deps.classifierProvider,
      model: intentCfg.model,
      abortSignal: deps.abortSignal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ chatId, err: message }, 'Classifier threw — defaulting to silent');
    return { proceed: false, reason: 'silent', note: `classifier error: ${message}` };
  }

  if (result.addressed && result.confidence === 'high') {
    return { proceed: true, reason: 'intent-high', note: result.reason };
  }
  if (result.addressed && result.confidence === 'medium') {
    return {
      proceed: false,
      reason: 'confirm-required',
      confirmPrompt:
        `@${senderName} were you talking to me? Reply "yes" to run that ` +
        `through Jarvis, or just mention me directly next time. (no = ignore)`,
      note: result.reason,
    };
  }
  // Addressed=true low-confidence or not addressed → silent.
  return { proceed: false, reason: 'silent', note: `classifier: ${result.reason}` };
}
