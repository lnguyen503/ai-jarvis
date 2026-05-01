/**
 * Skill framework (v1.8.2).
 *
 * A "skill" is an autonomous multi-step workflow delivered through the same
 * pipeline — planner → task execution → multi-model synthesis → artifact
 * delivery. Every skill shares the same plumbing; they differ in only two
 * places: the planner's system prompt (what kind of tasks to generate) and
 * the per-task brief (how each task should approach its work).
 *
 * Adding a new skill is a single-file addition: a new SkillDefinition
 * module, plus one line in the gateway to register its command.
 *
 * Current skills:
 *   - research  — decompose a goal, gather info, deliver a comprehensive report
 *   - fix       — diagnose a bug / issue, locate the cause, apply a fix
 *   - build     — build a small app / feature / script from a description
 */

import type { Plan, PlanTask } from '../plan/types.js';

export interface SkillDefinition {
  /** Short identifier; matches the slash command (minus the slash). */
  name: 'research' | 'fix' | 'build';
  /** Shown at the top of the Telegram panel: "🤖 {label}: {goal}". Sentence case. */
  label: string;
  /** System prompt handed to Claude's planner. Must produce 3-8 single-sentence tasks. */
  plannerSystemPrompt: string;
  /** Build the user message handed to agent.turn() for a single task. */
  buildTaskBrief: (plan: Plan, task: PlanTask) => string;
  /** Optional override: total plan wall-clock budget in ms.
   *  Default = 15 minutes. /build uses 30 minutes (more file writes per task). */
  planWallTimeMs?: number;
  /** Optional override: per-task wall-clock cap in ms.
   *  Default = 5 minutes. /build uses 8 minutes. */
  perTaskWallTimeMs?: number;
}
