/**
 * Plan & Execute — minimal in-memory types for v1.8.0 MVP.
 *
 * Plans are not persisted. A process restart drops in-flight plans —
 * acceptable for MVP since most plans complete in <10 minutes.
 */

import type { SkillDefinition } from '../skill/types.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PlanTask {
  /** 1-based index of this task within the plan. */
  index: number;
  /** Human-readable single-sentence task title. */
  title: string;
  status: TaskStatus;
  /** Brief one-line summary of what the agent did, captured after completion. */
  summary?: string;
  /** Error message if status === 'failed'. */
  error?: string;
}

export interface Plan {
  /** Short readable id, e.g. 'pl_4f2a8c'. */
  id: string;
  /** Original user goal. */
  goal: string;
  /** Absolute path to the plan's artifact directory. */
  planDir: string;
  /** Telegram chat id where the plan was created. */
  chatId: number;
  /** Telegram message id of the live progress panel. */
  panelMessageId: number;
  /** Tasks in execution order. */
  tasks: PlanTask[];
  /** Wall-clock start time, ms since epoch. */
  startedAt: number;
  status: 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled';
  /** Set when the post-task synthesizer finishes. Path to REPORT.md
   *  (the source-of-truth markdown). v1.8.4 keeps this for backwards
   *  compat; reportPaths below is the multi-format set. */
  reportPath?: string;
  /** v1.8.4: paths to all delivered formats (md/txt/docx) so the
   *  "Send Again" button can re-deliver every format the user got
   *  the first time. md is kept for technical readers; txt/docx are
   *  the mobile-friendly versions. */
  reportPaths?: { md: string; txt: string; docx: string };
  /** When set, task execution is pinned to this provider (Claude).
   *  Synthesis drafters stay on Ollama regardless. */
  forceProvider?: 'claude' | 'ollama-cloud';
  /** Sum of input/output tokens across every task's agent.turn() in this
   *  plan. Used to display an estimated cost in the panel footer when
   *  forceProvider === 'claude'. cache_* fields enabled by prompt caching
   *  in v1.8.3 — read tokens are 10× cheaper than full-price input. */
  totalUsage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Model actually used for task execution (e.g. 'claude-haiku-4-5',
   *  'claude-sonnet-4-6'). Set by the executor after the first task so
   *  the panel can compute cost using model-specific pricing. */
  modelUsed?: string;
  /** Skill driving this plan (research / fix / build). Determines the
   *  planner prompt, task-brief template, and panel label. */
  skill: SkillDefinition;
}
