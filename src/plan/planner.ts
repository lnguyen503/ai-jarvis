/**
 * Plan & Execute — planner.
 *
 * One Claude call: take a user goal, return 3-8 single-sentence tasks.
 * Pure decomposition — the planner has no knowledge of tools or models;
 * the executor decides those at runtime via the existing model router.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider } from '../providers/claude.js';
import type { AppConfig } from '../config/index.js';
import type { SkillDefinition } from '../skill/types.js';
import { child } from '../logger/index.js';

const log = child({ component: 'plan.planner' });

const MIN_TASKS = 3;
const MAX_TASKS = 8;

/**
 * Decompose a goal into a list of task titles, using the planner prompt
 * supplied by the skill. Returns an empty array if the planner refuses or
 * produces a malformed list.
 */
export async function planGoal(
  goal: string,
  skill: SkillDefinition,
  cfg: AppConfig,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const provider = new ClaudeProvider(cfg);

  let response;
  try {
    response = await provider.call({
      model: cfg.ai.premiumModel,
      system: skill.plannerSystemPrompt,
      messages: [{ role: 'user', content: `Goal: ${goal.trim()}` }],
      tools: [],
      maxTokens: 1024,
      abortSignal,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Planner LLM call failed',
    );
    return [];
  }

  const tasks = parseTaskList(response.content);
  log.info(
    { skill: skill.name, goalLength: goal.length, taskCount: tasks.length, model: response.model },
    'Plan generated',
  );

  if (tasks.length < MIN_TASKS || tasks.length > MAX_TASKS) {
    log.warn(
      { skill: skill.name, taskCount: tasks.length, min: MIN_TASKS, max: MAX_TASKS },
      'Planner returned out-of-range task count; rejecting',
    );
    return [];
  }

  return tasks;
}

/**
 * Parse the planner's freeform text into a clean list of task titles.
 * Strips numbering, bullets, blank lines, and trailing punctuation noise.
 * Exported for unit testing.
 */
export function parseTaskList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(stripLeadingMarker)
    .filter((line) => line.length > 5);
}

function stripLeadingMarker(line: string): string {
  // Strip "1.", "1)", "1 -", "- ", "* ", "• " etc. at the start of the line.
  return line.replace(/^[\s*•-]*\d*\s*[.):-]\s*/, '').replace(/^[*•-]\s+/, '').trim();
}

// Re-export Anthropic type so consumers don't need to import it directly.
export type { Anthropic };
