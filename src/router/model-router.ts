/**
 * Model router — selects provider + model for a given turn.
 *
 * Precedence (high → low):
 *   1. Per-session pin set via /model command (override_until_clear=true)
 *   2. Keyword-based classification
 *   3. Config default (defaultProvider / defaultModel)
 *
 * /model claude or /model <premiumModel> routes to the premium provider.
 * /model auto clears the pin.
 */

import type { AppConfig } from '../config/index.js';
import type { MemoryApi } from '../memory/index.js';
import type { BotIdentity } from '../config/botIdentity.js';
import { BOT_MODEL_BY_NAME } from '../config/botIdentity.js';
import { classifyTask } from './task-classifier.js';
import { child } from '../logger/index.js';

const log = child({ component: 'router.model' });

export interface RoutingDecision {
  provider: string;
  model: string;
  reason: string;
}

export function routeTask(
  input: string,
  sessionId: number,
  cfg: AppConfig,
  memory: MemoryApi,
  botIdentity?: BotIdentity,
): RoutingDecision {
  const sessionState = memory.sessionModelState.get(sessionId);

  // 1. Per-session pin
  if (sessionState?.override_until_clear) {
    const decision: RoutingDecision = {
      provider: sessionState.provider,
      model: sessionState.model,
      reason: 'session-pin',
    };
    if (cfg.ai.routing.logRoutingDecisions) {
      log.info(decision, 'Routing decision');
    }
    return decision;
  }

  // 2. Keyword classification (only if routing enabled)
  if (cfg.ai.routing.enabled) {
    const classified = classifyTask(input);
    if (cfg.ai.routing.logRoutingDecisions) {
      log.info({ ...classified, reason: `keyword:${classified.reason}` }, 'Routing decision');
    }
    return { ...classified, reason: `keyword:${classified.reason}` };
  }

  // 3. v1.22.35 — per-bot default model. When routing is disabled but the
  // bot identity is known, each bot uses its own model (BOT_MODEL_BY_NAME).
  // Required for the debate-for-accuracy pattern: specialists drafting on
  // different models than the critic produces real diversity of blind spots.
  if (botIdentity && BOT_MODEL_BY_NAME[botIdentity.name]) {
    const decision: RoutingDecision = {
      provider: cfg.ai.defaultProvider,
      model: BOT_MODEL_BY_NAME[botIdentity.name],
      reason: `per-bot:${botIdentity.name}`,
    };
    if (cfg.ai.routing.logRoutingDecisions) {
      log.info(decision, 'Routing decision');
    }
    return decision;
  }

  // 4. Config default (fallback when no bot identity is wired)
  const decision: RoutingDecision = {
    provider: cfg.ai.defaultProvider,
    model: cfg.ai.defaultModel,
    reason: 'config-default',
  };
  if (cfg.ai.routing.logRoutingDecisions) {
    log.info(decision, 'Routing decision');
  }
  return decision;
}

/**
 * Resolve a /model argument to a provider + model.
 * Returns null if the name is 'auto' (means clear pin).
 * Returns the premium provider for 'claude', 'premium', or the premiumModel name.
 */
export function resolveModelAlias(
  nameArg: string,
  cfg: AppConfig,
): { provider: string; model: string } | null {
  const name = nameArg.trim().toLowerCase();

  if (name === 'auto') return null;

  if (
    name === 'claude' ||
    name === 'premium' ||
    name === cfg.ai.premiumModel.toLowerCase() ||
    name === cfg.ai.premiumProvider.toLowerCase()
  ) {
    return { provider: cfg.ai.premiumProvider, model: cfg.ai.premiumModel };
  }

  // Check if it matches a known Ollama model (contains :cloud or known tags)
  // We accept any string as a model name for forward-compat
  return { provider: 'ollama-cloud', model: nameArg.trim() };
}
